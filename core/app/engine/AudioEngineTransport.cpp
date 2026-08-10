// Transport + song staging for AudioEngine (message thread / gapless paths).
// selectSong, play/stop/seek, cycle locators, timeline events, gapless promote.
// Kept in its own translation unit so AudioEngine.cpp doesn't balloon.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "project/RouteId.h"
#include "events/DueQueue.h"
#include "timing/SongLength.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>


namespace resostage {

using audio_engine_detail::dbToGain;
using audio_engine_detail::kRingBufferSeconds;

bool AudioEngine::selectSong(size_t songIndex, std::string& error, bool fireOnLoadEventsFlag) {
    // Setlist hop / Next while already PLAYING: keep transport live and start
    // the new song from 0 (same keep-playing path as gapless AutoplayNext).
    const bool keepPlaying = playing.load(std::memory_order_acquire);
    return selectSongInternal(songIndex, error, fireOnLoadEventsFlag, keepPlaying);
}

bool AudioEngine::selectSongInternal(size_t songIndex, std::string& error, bool fireOnLoadEventsFlag,
                                     bool gaplessKeepPlaying) {
    if (!projectLoaded) {
        error = "No project loaded";
        return false;
    }

    const Project& proj = loader.project();
    if (songIndex >= proj.songs.size()) {
        error = "Song index out of range";
        return false;
    }
    const SongDef& song = proj.songs[songIndex];

    // Capture before any stop() — used for same-song restart + prime decisions.
    const bool wasPlaying =
        gaplessKeepPlaying || playing.load(std::memory_order_acquire);

    // Already on this song (re-click / coalesced hop that landed where we
    // are): rewind in place — never re-open every stem. That used to make
    // "click current song" and rapid same-target coalescing feel laggy.
    if (songIndex == currentSong) {
        if (!wasPlaying)
            stop();
        else
            streamHandoff.store(true, std::memory_order_release);

        {
            std::lock_guard<std::recursive_mutex> lock(routingMutex);
            clock.stop();
            hwSamplePosition.store(0, std::memory_order_relaxed);
            underrunFadeOutRemaining = 0;
            underrunFadeOutLength = 0;
            lastCallbackWasUnderrun = false;
            lastCallbackHostNanos = 0;
            pendingSongEndAction = SongEndAction::None;
            const int fadeIn = wasPlaying ? 256 : kSongEndFadeSamples;
            recoveryFadeInLength = fadeIn;
            recoveryFadeInRemaining = fadeIn;
            outputHeldSilent = false;
            eventFiredFlags.assign(song.events.size(), 0);
            if (wasPlaying) {
                clock.start(currentSampleRate, 0);
                playing.store(true, std::memory_order_release);
                transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
                transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
                transportTelemetry.running.store(true, std::memory_order_relaxed);
            } else {
                clock.start(currentSampleRate, 0);
                clock.stop();
                transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
                transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
                transportTelemetry.running.store(false, std::memory_order_relaxed);
            }
            resetMetersSilent();
            streamHandoff.store(false, std::memory_order_release);
        }
        // Snap streams to 0 with no prime wait (fseek path is cheap).
        std::string seekErr;
        (void)streaming.seekActiveSongTo(0, seekErr, /*primeMaxWait=*/0.0);
        if (wasPlaying)
            syncMidiTransportToCurrentSong(/*sendContinue=*/false);
        if (fireOnLoadEventsFlag)
            fireOnLoadEvents(song);
        return true;
    }

    if (!wasPlaying)
        stop();
    // else: leave transport live — stageSong opens next while previous plays,
    // then sets streamHandoff only for the microseconds of the active flip.

    const int64_t ringCapacityFrames = static_cast<int64_t>(currentSampleRate * kRingBufferSeconds);
    // Pass streamHandoff so mute starts only at the swap, not during cold open.
    // asyncFill=true: a hard hop (song never opened before, e.g. jumping past
    // the ±2-neighbour warm cache) must not block this message-thread call --
    // see StreamingEngine::stageSong's doc comment. deferredMuteClear tells us
    // stageSong handed clearing streamHandoff off to its background fill
    // thread, so the unconditional clear below must be skipped for it.
    bool deferredMuteClear = false;
    if (!streaming.stageSong(songIndex, song, ringCapacityFrames, currentSampleRate, error,
                             /*primeSeconds=*/0.0, /*primeMaxWait=*/0.0,
                             wasPlaying ? &streamHandoff : nullptr, /*asyncFill=*/true,
                             &deferredMuteClear)) {
        streamHandoff.store(false, std::memory_order_release);
        return false;
    }
    // Previous song's StreamCursors are gone (or about to be after the audio
    // thread drops its ActiveSongHandle). Safe to drop packages parked by a
    // play-through save that could not be unlinked immediately.
    if (!wasPlaying)
        purgeStaleSavePackages();

    // Deliberately NO hardSeekTo(0) on the keep-playing path: streamHandoff
    // already prevents the audio thread from reading rings between promote
    // and playhead-reset, and precached buffers are still at frame 0. A
    // full re-open+prime of every multi-100MB stem was the multi-tens-of-ms
    // "prolag" between songs.

    // Validate track -> bus assignments before staging UI/routing state.
    // A SendsOnly route is valid and deliberate: a track with no main/FOH
    // destination, routed purely through its SendConfig entries
    // (publishRoutingSnapshot() already treats "route not found" as simply
    // "no main route" -- only a *non-empty* dangling reference is an error).
    std::vector<std::string> newTrackIds;
    newTrackIds.reserve(proj.tracks.size());
    for (const TrackDef& trackDef : proj.tracks) {
        const std::string routeId = routeIdOf(trackDef.output);
        if (routeId.empty()) {
            newTrackIds.push_back(trackDef.id);
            continue;
        }
        // A route id may be a comma compound of mono Direct Output lanes
        // ("audio::out:3,audio::out:4"). Validate every non-empty token,
        // following the routing rules: an "audio::out:*" token is always
        // acceptable -- the lane id is deterministic and a currently-absent
        // lane (unavailable/disabled output) silently drops to silence
        // instead of erroring. Only a genuine dangling reference to a
        // project/send bus is a hard error.
        std::size_t pos = 0;
        while (pos <= routeId.size()) {
            const std::size_t end = routeId.find(',', pos);
            const std::string tok = routeId.substr(
                pos, end == std::string::npos ? std::string::npos : end - pos);
            pos = (end == std::string::npos) ? routeId.size() + 1 : end + 1;
            if (tok.empty())
                continue;
            if (tok.rfind("audio::out:", 0) == 0)
                continue; // lane might exist or be shadowed -- never fatal
            if (busIndexById.find(tok) == busIndexById.end()) {
                error = "Track '" + trackDef.id + "' references unknown bus '" + tok + "'";
                return false;
            }
        }
        newTrackIds.push_back(trackDef.id);
    }

    // Song length from the (already published) active staged song, unless the
    // song carries an authored end -- see songLengthFrames.
    int64_t newSongLengthFrames = 0;
    {
        StreamingEngine::ActiveSongHandle activeSong = streaming.acquireActiveSong();
        if (activeSong) {
            for (const std::string& trackId : newTrackIds) {
                if (StreamingTrackBuffer* buf = activeSong.track(trackId))
                    newSongLengthFrames = std::max(newSongLengthFrames, buf->totalFrames());
            }
        }
    }
    newSongLengthFrames =
        songLengthFrames(song.endSeconds, newSongLengthFrames, currentSampleRate);

    // CRITICAL: every field the audio thread reads under routingMutex must
    // flip atomically relative to that lock. The previous code reassigned
    // trackScratch to a vector of EMPTY AudioBuffers *outside* the lock,
    // then called ensureScratchSizes() which blocked on the mutex -- so the
    // audio callback could (and did) try_to_lock successfully, read a null
    // getWritePointer/getReadPointer from a 0-channel buffer, and SIGSEGV
    // (see crash: audioDeviceIOCallbackWithContext reading a track scratch
    // with srcL == nullptr, while the message thread was stuck in
    // ensureScratchSizes during gapless switchToSongGapless).
    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);

        // Only rebuild scratch when track count / block size changed — full
        // re-zero of every track buffer was pure lag on every song hop.
        const bool tracksChanged = trackIdByIndex != newTrackIds;
        trackIdByIndex = std::move(newTrackIds);
        if (tracksChanged || trackScratch.size() != trackIdByIndex.size()) {
            trackScratch.assign(trackIdByIndex.size(), juce::AudioBuffer<float>());
            ensureTrackMeters(trackIdByIndex.size());
        }
        {
            const int samples = std::max(currentBlockSize, 1);
            for (auto& scratch : trackScratch) {
                if (scratch.getNumChannels() != 2 || scratch.getNumSamples() != samples)
                    scratch.setSize(2, samples, false, false, true);
            }
            if (static_cast<int>(clickScratch.size()) != samples)
                clickScratch.assign(static_cast<size_t>(samples), 0.0f);
        }

        currentSongLengthFrames = newSongLengthFrames;
        eventFiredFlags.assign(song.events.size(), 0);

        // Retarget full tempo + meter grid. Playhead resets to 0 below →
        // next render is bar 1 / strong downbeat under the new signature.
        if (currentSampleRate > 0.0) {
            clickGenerator.prepare(currentSampleRate, song.bpm,
                                   song.timeSignature.numerator,
                                   song.timeSignature.denominator);
        }

        currentSong = songIndex;
        // Keep LightEngine in sync with the active song index and BPM so
        // tempo-synced effects use the correct rate immediately.
        clock.setSongIndex(static_cast<int>(songIndex));
        lightEngine.setBpm(song.bpm);
        // Each song has its own cycle locators; re-mirror so the audio thread
        // loops the newly staged song (or deactivates if that song has none).
        syncTransportCycleFromProject();

        // Publish routing while still holding routingMutex (recursive).
        //
        // Deliberately NOT narrowed the way refreshClickState() was: a song
        // change has to be atomic against the render callback (see the CRITICAL
        // note at the top of this function -- a half-applied restage crashed).
        // The extra lock time is free here because the outputs are already
        // being held silent through the handoff and ramped back in below, so
        // there is no audio to protect. That is exactly what makes a knob move
        // different: it must NOT silence anything.
        publishRoutingSnapshot();

        // Reset playhead + micro-fade state under the same lock the audio
        // thread uses for the whole mix/fade path, so it can never observe
        // "hold cleared, fade-in not yet armed" or a half-updated song.
        //
        // Sequence matters for MasterClock: stop first so the audio thread's
        // onAudioCallback becomes a no-op (it only re-anchors while
        // clock.isRunning()), THEN zero the free-run counter, THEN start at 0.
        // free-running fetch_add while stopped was the other half of the
        // gapless playhead-jump race.
        clock.stop();
        hwSamplePosition.store(0, std::memory_order_relaxed);
        underrunFadeOutRemaining = 0;
        underrunFadeOutLength = 0;
        lastCallbackWasUnderrun = false;
        lastCallbackHostNanos = 0;
        pendingSongEndAction = SongEndAction::None;
        // Short edge only — long kSongEndFadeSamples on cold stage made hops
        // feel like a ramp delay even when stems were already open.
        const int fadeIn = wasPlaying ? 128 : 256;
        recoveryFadeInLength = fadeIn;
        recoveryFadeInRemaining = fadeIn;
        outputHeldSilent = false;

        if (wasPlaying) {
            // Stay in PLAYING: restart timeline at 0 without a stop/start gap.
            clock.start(currentSampleRate, 0);
            playing.store(true, std::memory_order_release);
            transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
            transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
            transportTelemetry.running.store(true, std::memory_order_relaxed);
        } else {
            // Anchor frozen at 0; play() will start the clock later.
            clock.start(currentSampleRate, 0);
            clock.stop();
            transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
            transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
            transportTelemetry.running.store(false, std::memory_order_relaxed);
        }

        // Streams + playhead are coherent at 0 -- audio may read again. Skip
        // when stageSong deferred clearing to its own background fill thread
        // (hard hop) -- unmuting here would let the audio thread read a
        // still-empty ring before that thread has decoded any head audio.
        resetMetersSilent();
        if (!deferredMuteClear)
            streamHandoff.store(false, std::memory_order_release);
    }

    if (wasPlaying)
        // Tempo retune + SPP for the new cumulative position / meter grid.
        // No Start/Stop/Continue -- clock keeps ticking through the hop.
        syncMidiTransportToCurrentSong(/*sendContinue=*/false);

    // Defer non-audio work so the handoff returns immediately (SPA already
    // updated optimistically). Peaks / on-load MIDI / warm must not block.
    const size_t deferredSong = songIndex;
    const bool deferredFire = fireOnLoadEventsFlag;
    juce::MessageManager::callAsync([this, deferredSong, deferredFire] {
        if (!projectLoaded || currentSong != deferredSong)
            return;
        rebuildTrackPeaks();
        if (deferredFire && deferredSong < loader.project().songs.size())
            fireOnLoadEvents(loader.project().songs[deferredSong]);
        warmNeighbourSongs();
    });

    return true;
}

void AudioEngine::warmNeighbourSongs() {
    if (!projectLoaded)
        return;
    const Project& proj = loader.project();
    if (proj.songs.empty() || currentSong >= proj.songs.size())
        return;
    const int64_t ringCap = static_cast<int64_t>(currentSampleRate * kRingBufferSeconds);
    const double sr = currentSampleRate;
    const size_t cur = currentSong;

    // Open neighbours on a background thread — never on the message thread
    // (precacheSong does fopen/parseHeader and used to stall song hops).
    auto scheduleWarm = [this, ringCap, sr, cur](size_t idx) {
        std::thread([this, idx, ringCap, sr, cur] {
            if (!projectLoaded)
                return;
            const Project& p = loader.project();
            if (idx >= p.songs.size())
                return;
            if (streaming.hasPrecacheFor(idx))
                return;
            if (currentSong == idx)
                return;
            // Still useful if we're near the original hop target.
            const bool stillNeighbour =
                (currentSong + 1 == idx) || (currentSong > 0 && currentSong - 1 == idx)
                || (cur + 1 == idx) || (cur + 2 == idx) || (cur > 0 && cur - 1 == idx);
            if (!stillNeighbour)
                return;
            streaming.precacheSong(idx, p.songs[idx], ringCap, sr, /*epoch=*/0,
                                   /*requireEpochMatch=*/false);
        }).detach();
    };

    if (cur + 1 < proj.songs.size())
        scheduleWarm(cur + 1);
    if (cur > 0)
        scheduleWarm(cur - 1);
    if (cur + 2 < proj.songs.size())
        scheduleWarm(cur + 2);
}

bool AudioEngine::switchToSongGapless(size_t songIndex, std::string& error) {
    return selectSongInternal(songIndex, error, /*fireOnLoadEvents=*/true, /*gaplessKeepPlaying=*/true);
}

bool AudioEngine::consumeGaplessAdvance(size_t& outSongIndex) {
    const int pending = pendingGaplessSong.exchange(-1, std::memory_order_acq_rel);
    if (pending < 0)
        return false;
    outSongIndex = static_cast<size_t>(pending);
    return true;
}

bool AudioEngine::consumeGaplessUiNotify(size_t& outSongIndex) {
    const int pending = pendingGaplessUiNotify.exchange(-1, std::memory_order_acq_rel);
    if (pending < 0)
        return false;
    outSongIndex = static_cast<size_t>(pending);
    return true;
}

void AudioEngine::syncTransportCycleFromProject() {
    // Bump epoch first so any in-flight callAsync cycle seeks from the OLD
    // zone become no-ops (disable / move / replace must cut the previous
    // loop immediately, then the new locators take effect).
    cycleEpoch.fetch_add(1, std::memory_order_acq_rel);
    pendingCycleSeekSec.store(-1.0, std::memory_order_release);

    if (!projectLoaded || currentSong >= loader.project().songs.size()) {
        cycleActive.store(false, std::memory_order_relaxed);
        cycleSkip.store(false, std::memory_order_relaxed);
        return;
    }
    // Project-wide cycle: only armed while the staged song is the one the
    // locators belong to (cycle cannot span songs).
    const ProjectCycle& c = loader.project().cycle;
    const bool appliesHere =
        c.active && c.songIndex >= 0
        && static_cast<size_t>(c.songIndex) == currentSong;
    double lo = c.startSeconds;
    double hi = c.endSeconds;
    if (hi < lo)
        std::swap(lo, hi);
    cycleActive.store(appliesHere, std::memory_order_relaxed);
    cycleSkip.store(c.skip, std::memory_order_relaxed);
    cycleLeftSec.store(lo, std::memory_order_relaxed);
    cycleRightSec.store(hi, std::memory_order_relaxed);
}

bool AudioEngine::consumeCycleSeek(double& outSeconds) {
    const double pending = pendingCycleSeekSec.exchange(-1.0, std::memory_order_acq_rel);
    if (pending < 0.0)
        return false;
    outSeconds = pending;
    return true;
}

void AudioEngine::resetMetersSilent() {
    const MeterFrame silent{};
    for (auto& m : trackMeters)
        if (m != nullptr)
            m->write(silent);
    for (auto& band : trackBandMeters)
        band.reset();
    for (size_t i = 0; i < busMeters.size(); ++i) {
        if (i < busLoudnessMeters.size())
            busLoudnessMeters[i].reset();
        if (busMeters[i] != nullptr)
            busMeters[i]->write(silent);
    }
    clickMeterFrame.write(silent);

    // The peak sources the UI actually reads, not just the SeqLock frames.
    //
    // consumeBusMeterInterval reports max(impulse latch, last rendered block),
    // and while the transport is stopped no block is rendered at all -- so
    // without clearing these the needles stay parked at whatever was playing
    // when Stop was pressed, forever. Silence is a real measurement here: the
    // engine is knowingly producing none.
    clickPeakIntervalMaxL.store(0.0f, std::memory_order_relaxed);
    clickPeakIntervalMaxR.store(0.0f, std::memory_order_relaxed);
    clickLastBlockPeakL.store(0.0f, std::memory_order_relaxed);
    clickLastBlockPeakR.store(0.0f, std::memory_order_relaxed);
    for (size_t i = 0; i < busPeakIntervalCount; ++i) {
        if (busPeakIntervalMaxL) busPeakIntervalMaxL[i].store(0.0f, std::memory_order_relaxed);
        if (busPeakIntervalMaxR) busPeakIntervalMaxR[i].store(0.0f, std::memory_order_relaxed);
        if (busLastBlockPeakL) busLastBlockPeakL[i].store(0.0f, std::memory_order_relaxed);
        if (busLastBlockPeakR) busLastBlockPeakR[i].store(0.0f, std::memory_order_relaxed);
    }

    // Same for the trajectory: drop the points still in flight, zero the
    // ballistics, and zero the held value the drain falls back to. Leaving any
    // one of the three would let a needle finish a release that belongs to
    // audio the engine has stopped producing.
    // The rings and the held values are ours to touch -- this thread is the
    // consumer of both. The ballistics are NOT: they belong to the callback,
    // so ask, and it zeroes them on its next block.
    envelopeResetRequested.store(true, std::memory_order_relaxed);
    clickEnvelopeRing.clear();
    clickLastPpm = MeterEnvelopePoint{};
    for (size_t i = 0; i < busEnvelopeRings.size(); ++i) {
        if (busEnvelopeRings[i] != nullptr)
            busEnvelopeRings[i]->clear();
        if (i < busLastPpm.size())
            busLastPpm[i] = MeterEnvelopePoint{};
    }
}

int64_t AudioEngine::songLengthFrames(double endSeconds,
                                      int64_t contentFrames,
                                      double sampleRate) {
    // Pure arithmetic with a rule behind it, so it lives in
    // engine/timing/SongLength.h where it can be tested without a device.
    return songLengthFramesFor(endSeconds, contentFrames, sampleRate);
}

bool AudioEngine::tryGaplessPromoteOnAudioThread(size_t nextSongIndex) {
    if (!projectLoaded || nextSongIndex >= loader.project().songs.size())
        return false;
    if (!streaming.tryPromotePrecached(nextSongIndex))
        return false;

    const SongDef& song = loader.project().songs[nextSongIndex];

    // Length from the just-promoted buffers (device domain).
    int64_t newLen = 0;
    {
        StreamingEngine::ActiveSongHandle activeSong = streaming.acquireActiveSong();
        if (activeSong) {
            for (const std::string& trackId : trackIdByIndex) {
                if (StreamingTrackBuffer* buf = activeSong.track(trackId))
                    newLen = std::max(newLen, buf->totalFrames());
            }
        }
    }

    // Click routing for the new song (same fields the message-thread path sets).
    // Click routing is project-global (same for every song).
    // Apply under the same mutex the render path holds, so the first post-
    // handoff callback sees a coherent song 0 / click / length snapshot.
    // We already hold nothing here (called from the render path before the
    // routeLock section finishes fade) -- try_lock; if contended, fall back.
    std::unique_lock<std::recursive_mutex> lock(routingMutex, std::try_to_lock);
    if (!lock.owns_lock()) {
        // Streams already promoted -- leave streamHandoff true and ask the
        // message thread to finish state via switchToSongGapless.
        pendingGaplessSong.store(static_cast<int>(nextSongIndex), std::memory_order_release);
        return false;
    }

    currentSong = nextSongIndex;
    currentSongLengthFrames = newLen;
    eventFiredFlags.assign(song.events.size(), 0);
    // Gapless hop: new BPM + full meter; playhead 0 = strong downbeat.
    if (currentSampleRate > 0.0) {
        clickGenerator.prepare(currentSampleRate, song.bpm,
                               song.timeSignature.numerator,
                               song.timeSignature.denominator);
    }

    clock.stop();
    hwSamplePosition.store(0, std::memory_order_relaxed);
    underrunFadeOutRemaining = 0;
    underrunFadeOutLength = 0;
    lastCallbackWasUnderrun = false;
    lastCallbackHostNanos = 0;
    pendingSongEndAction = SongEndAction::None;
    recoveryFadeInLength = 256;
    recoveryFadeInRemaining = 256;
    outputHeldSilent = false;
    clock.start(currentSampleRate, 0);
    playing.store(true, std::memory_order_release);
    transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
    transportTelemetry.running.store(true, std::memory_order_relaxed);
    resetMetersSilent();
    streamHandoff.store(false, std::memory_order_release);

    // MIDI: live tempo retune + Song Position so followers match the new
    // cumulative beat position under the new song's grid.
    syncMidiTransportToCurrentSong(/*sendContinue=*/false);
    pendingGaplessUiNotify.store(static_cast<int>(nextSongIndex), std::memory_order_release);
    autoAdvancePending.store(false, std::memory_order_release);

    // Precache the song after this one (message thread will also try; best-effort).
    if (nextSongIndex + 1 < loader.project().songs.size()) {
        const int64_t ringCapacityFrames = static_cast<int64_t>(currentSampleRate * kRingBufferSeconds);
        // Cannot safely open files on the audio thread -- leave precache to UI tick.
        (void)ringCapacityFrames;
    }
    return true;
}

void AudioEngine::syncEventFiredFlags() {
    if (!projectLoaded || currentSong >= loader.project().songs.size())
        return;
    const size_t wanted = loader.project().songs[currentSong].events.size();

    // The audio thread reads this vector inside fireDueEvents, under the same
    // lock the render callback try_locks -- so resizing it anywhere else would
    // be a use-after-free waiting for a busy song.
    std::lock_guard<std::recursive_mutex> lock(routingMutex);
    if (eventFiredFlags.size() == wanted)
        return;

    // See engine/events/DueQueue.h: grows with zeros so a new event is armed,
    // preserves what is there so adding a trigger halfway through a song does
    // not re-fire everything before it.
    resizeFiredFlags(eventFiredFlags, wanted);
}

void AudioEngine::play() {
    if (currentSong == static_cast<size_t>(-1))
        return;

    // A trigger added to the song already open never fired.
    //
    // eventFiredFlags is sized when a song is STAGED, and fireDueEvents stops
    // at its length -- so an event appended to the current song sat outside
    // the loop bound forever. Pressing Play only zeroed the flags that already
    // existed. The only way to arm the new event was to switch songs and come
    // back, which is not a thing anyone would think to do.
    syncEventFiredFlags();

    // Active loop cycle (project-wide): every Play jumps to the cycle's song
    // and left locator — even if the user is currently staged on another song.
    // Skip mode leaves the anchor alone (pass-through zone, not a loop).
    if (projectLoaded) {
        const ProjectCycle& c = loader.project().cycle;
        if (c.active && !c.skip && c.songIndex >= 0
            && static_cast<size_t>(c.songIndex) < loader.project().songs.size()) {
            double lo = c.startSeconds;
            double hi = c.endSeconds;
            if (hi < lo)
                std::swap(lo, hi);
            if (hi - lo >= 0.05) {
                std::string err;
                // Cross-song seek if the cycle lives on a different song;
                // same-song just parks at left. Then play continues below.
                (void)seekToSeconds(lo, err, static_cast<size_t>(c.songIndex));
                // Re-mirror atomics after a possible song hop so loop seeks
                // arm on the newly staged song.
                syncTransportCycleFromProject();
            }
        }
    }

    // Resume from the current anchor (0 after selectSong, or last seek/stop pos,
    // or the cycle left locator just applied above).
    // Defensively clamped to the song's actual length: this anchor should
    // never legitimately exceed it (selectSong resets to 0, seekToSeconds
    // clamps to [0, length]), but resuming beyond the end would otherwise
    // manifest as "Play does nothing audible" -- the render callback's
    // song-end check fires on the very first block and immediately stops
    // again before any audio is produced.
    int64_t startSample = clock.currentSamplePosition();
    if (currentSongLengthFrames > 0 && startSample >= currentSongLengthFrames)
        startSample = 0;
    // If starting from the beginning of a song, re-arm timeline events.
    if (startSample <= 0)
        std::fill(eventFiredFlags.begin(), eventFiredFlags.end(), 0);

    // No blocking prime — IO workers fill; a long prime here made Play and
    // post-switch resume feel like a half-second stall.
    (void)streaming.primeActiveSong(0.0, currentSampleRate, 0.0);

    // Reset the raw hardware sample counter BEFORE (re)starting MasterClock.
    // hwSamplePosition free-runs continuously since the audio device
    // started, incrementing every callback regardless of `playing` (see
    // audioDeviceIOCallbackWithContext -- the fetch_add happens
    // unconditionally, before the playing check). Without this reset, the
    // very next callback after play() re-anchors MasterClock to that stale,
    // ever-growing counter, instantly jumping the playhead forward by
    // however long playback was stopped -- including the entire gap between
    // app/device startup and the first Play, or between Stop and the next
    // Play. Stored before clock.start() (which release-stores
    // MasterClock::running) so the audio thread's acquire-load of running
    // is guaranteed to also observe this reset (release/acquire
    // synchronizes-with, not a torn race).
    hwSamplePosition.store(startSample, std::memory_order_relaxed);
    clock.start(currentSampleRate, startSample);

    const Project& proj = loader.project();
    if (currentSong < proj.songs.size()) {
        const double bpm = proj.songs[currentSong].bpm;
        // First transport start this project -> MIDI Start (0xFA), fresh
        // phase. Every later play() (resume from pause/stop, anywhere in the
        // project) -> MIDI Continue (0xFB), preserving phase -- deliberately
        // NOT keyed on `startSample <= 0`, since seeking to the very start of
        // e.g. song 3 mid-project must not look like a whole-set restart.
        if (!midiClockEverStarted) {
            midiDispatcher.startClock(bpm, SystemMonotonicClock{}.nowNanos());
            midiClockEverStarted = true;
        } else {
            midiDispatcher.continueClock(bpm);
        }
    }

    playing.store(true, std::memory_order_release);
}

void AudioEngine::stop() {
    // Freeze the playhead at the current position so Stop/Play resumes rather
    // than jumping to 0 (explicit restarts go through selectSong / seek).
    if (playing.load(std::memory_order_acquire)) {
        const int64_t pos = clock.currentSamplePosition();
        clock.start(currentSampleRate, pos);
    }
    playing.store(false, std::memory_order_release);
    clock.stop();
    midiDispatcher.stopClock();

    transportTelemetry.playheadSamples.store(clock.currentSamplePosition(), std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(clock.currentSeconds(), std::memory_order_relaxed);
    transportTelemetry.running.store(false, std::memory_order_relaxed);
    // Stopped means the render callback stops producing blocks, so the peak
    // sources the meters read would otherwise keep reporting the last block
    // that played -- needles parked at whatever was going on when Stop was
    // pressed. This is the one place that knows silence is now the truth.
    resetMetersSilent();
    // Flush autosave that was deferred during play (SSD stays free mid-show).
    flushDeferredAutosave();
}

void AudioEngine::stopToStart() {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1)) {
        stop();
        return;
    }

    // A few ms of tolerance so a seek that landed a handful of samples off
    // zero (rounding in seconds<->sample conversion) still counts as "at the
    // start" on the second press, rather than requiring bit-exact 0.
    const int64_t epsilonSamples = static_cast<int64_t>(currentSampleRate * 0.05);
    const bool atSongStart = clock.currentSamplePosition() <= epsilonSamples;

    if (atSongStart && currentSong != 0) {
        // Second press (already at this song's start): rewind to the very
        // beginning of the whole project. selectSong() halts playback itself.
        std::string error;
        selectSong(0, error);
        return;
    }

    // First press (or already at the project's own start): halt, then
    // rewind the current song to 0. stop() first so seekToSeconds's
    // wasPlaying capture reads false and the result is a genuine stop, not
    // "seek while still playing".
    stop();
    std::string error;
    seekToSeconds(0.0, error);
}

bool AudioEngine::seekToSeconds(double seconds, std::string& error, size_t songIndex) {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1)) {
        error = "No song selected";
        return false;
    }

    const bool wasPlaying = playing.load(std::memory_order_acquire);
    const size_t targetSong = (songIndex == static_cast<size_t>(-1)) ? currentSong : songIndex;
    if (targetSong >= loader.project().songs.size()) {
        error = "Song index out of range";
        return false;
    }

    const bool sameSong = (targetSong == currentSong);

    // Cross-song: full restage (StreamingTrackBuffer is forward-only per open).
    // Same-song: hard-seek in place WITHOUT stop/play -- scrub used to call
    // selectSong (which stops) then restart, producing a one-buffer "blip
    // then silence then play" glitch on every drag.
    if (!sameSong) {
        if (!selectSong(targetSong, error, /*fireOnLoadEvents=*/false))
            return false;
    }

    double maxSec = currentSongLengthSeconds();
    if (maxSec <= 0.0)
        maxSec = 24 * 3600.0;
    seconds = std::clamp(seconds, 0.0, maxSec);
    const int64_t sample = static_cast<int64_t>(seconds * currentSampleRate);

    // Mute stream reads while we re-park the rings at `sample`.
    streamHandoff.store(true, std::memory_order_release);
    if (!streaming.seekActiveSongTo(sample, error)) {
        streamHandoff.store(false, std::memory_order_release);
        return false;
    }

    // Mark past events as already fired so seek doesn't re-trigger them.
    const Project& proj = loader.project();
    if (targetSong < proj.songs.size()) {
        const SongDef& song = proj.songs[targetSong];
        eventFiredFlags.assign(song.events.size(), 0);
        for (size_t i = 0; i < song.events.size(); ++i) {
            const TimelineEvent& ev = song.events[i];
            if (ev.triggerOnLoad)
                continue;
            const double fireAt = ev.timeSeconds - (ev.latencyCompensationMs / 1000.0);
            if (fireAt <= seconds)
                eventFiredFlags[i] = 1;
        }
    }

    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);
        hwSamplePosition.store(sample, std::memory_order_relaxed);
        underrunFadeOutRemaining = 0;
        underrunFadeOutLength = 0;
        outputHeldSilent = false;
        // Very short edge on scrub (same-song) so it doesn't feel like a stop.
        const int fadeIn = sameSong ? 64 : kUnderrunFadeSamples;
        recoveryFadeInLength = fadeIn;
        recoveryFadeInRemaining = fadeIn;
        pendingSongEndAction = SongEndAction::None;
        lastCallbackWasUnderrun = false;
        lastCallbackHostNanos = 0;
        clock.start(currentSampleRate, sample);
        transportTelemetry.playheadSamples.store(sample, std::memory_order_relaxed);
        transportTelemetry.playheadSeconds.store(seconds, std::memory_order_relaxed);
        resetMetersSilent();

        if (wasPlaying || sameSong) {
            // sameSong keeps transport running across the seek; cross-song
            // restores prior wasPlaying after restage.
            if (wasPlaying) {
                playing.store(true, std::memory_order_release);
                transportTelemetry.running.store(true, std::memory_order_relaxed);
            } else {
                clock.stop();
                playing.store(false, std::memory_order_release);
                transportTelemetry.running.store(false, std::memory_order_relaxed);
            }
        } else {
            clock.stop();
            transportTelemetry.running.store(false, std::memory_order_relaxed);
        }
        streamHandoff.store(false, std::memory_order_release);
    }

    if (wasPlaying && targetSong < proj.songs.size()) {
        // Seek/relocate: SPP + Continue so followers jump with us. BPM/TS of
        // the (possibly new) song already applied via selectSong path above.
        syncMidiTransportToCurrentSong(/*sendContinue=*/true);
    }
    return true;
}

void AudioEngine::dispatchEvent(const TimelineEvent& ev, uint64_t targetHostTimeNanos) {
    switch (ev.type) {
        case EventType::MidiNoteOn: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::NoteOn;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiNote, 0, 127));
            cmd.data2 = static_cast<uint8_t>(std::clamp(ev.midiVelocity, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::MidiNoteOff: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::NoteOff;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiNote, 0, 127));
            cmd.data2 = static_cast<uint8_t>(std::clamp(ev.midiVelocity, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::MidiCC: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::ControlChange;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiCC, 0, 127));
            cmd.data2 = static_cast<uint8_t>(std::clamp(ev.midiCCValue, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::MidiProgramChange: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::ProgramChange;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiProgram, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::Http: {
            HttpTriggerCommand cmd;
            cmd.url = ev.httpUrl.value_or("");
            cmd.method = ev.httpMethod;
            cmd.body = ev.httpBody.value_or("");
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            eventDispatcher.enqueueHttp(cmd);
            break;
        }
        case EventType::Dmx: {
            DmxTriggerCommand cmd;
            cmd.universe = ev.dmxUniverse;
            cmd.data = ev.dmxData;
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            eventDispatcher.enqueueDmx(cmd);
            break;
        }
    }
}

void AudioEngine::fireOnLoadEvents(const SongDef& song) {
    const uint64_t now = SystemMonotonicClock{}.nowNanos();
    for (const TimelineEvent& ev : song.events)
        if (ev.triggerOnLoad)
            dispatchEvent(ev, now);
}

void AudioEngine::fireDueEvents(const SongDef& song, double blockStartSeconds, double blockEndSeconds,
                                 uint64_t hostTimeNanosAtBlockStart) {
    // How long the audio for this block will sit in the device before anyone
    // hears it. Every event below is scheduled for that moment rather than for
    // now, so a MIDI note or a light cue lands WITH its downbeat instead of
    // ahead of it -- and, just as importantly, stops moving when the operator
    // changes the buffer size. See engine/timing/OutputLatency.h.
    const double outputLatencySec =
        resostage::outputLatencySeconds(currentOutputLatencySamples.load(std::memory_order_relaxed),
                                        currentSampleRate);

    for (size_t i = 0; i < song.events.size() && i < eventFiredFlags.size(); ++i) {
        const TimelineEvent& ev = song.events[i];
        if (ev.triggerOnLoad || eventFiredFlags[i] != 0)
            continue;

        const double fireAtSeconds = ev.timeSeconds - (ev.latencyCompensationMs / 1000.0);
        if (fireAtSeconds > blockEndSeconds)
            continue;

        // Events already in the past when we get to them (e.g. several were
        // skipped during a MasterClock catch-up jump) fire as soon as
        // possible rather than being silently dropped.
        const double offsetSeconds = std::max(0.0, fireAtSeconds - blockStartSeconds);
        const uint64_t targetHostTimeNanos =
            heardHostNanos(hostTimeNanosAtBlockStart, offsetSeconds, outputLatencySec);

        dispatchEvent(ev, targetHostTimeNanos);
        eventFiredFlags[i] = 1;
    }
}

} // namespace resostage
