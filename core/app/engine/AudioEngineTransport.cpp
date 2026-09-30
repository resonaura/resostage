// Song selection/staging, cycle locators, and gapless transitions.
// Message-thread play/stop/seek controls live in AudioEngineTransportControls.cpp.
// Capture lives in AudioEngineRecording.cpp; block-rate timeline event,
// MIDI-region, and automation dispatch lives in AudioEngineEventDispatch.cpp.
// These remain AudioEngine member TUs with identical private access.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "project/RouteId.h"
#include "project/MidiRegionLoop.h"
#include "events/DueQueue.h"
#include "midi/Midi2Compatibility.h"
#include "timing/SongLength.h"
#include "automation/AutomationEvaluator.h"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <limits>
#include <string>
#include <string_view>
#include <vector>
#include "project/Uuid.h"


namespace resostage {

using audio_engine_detail::dbToGain;
using audio_engine_detail::kRingBufferSeconds;

bool AudioEngine::selectSong(size_t songIndex, std::string& error, bool fireOnLoadEventsFlag, bool forceRestage) {
    // Setlist hop / Next while already PLAYING: keep transport live and start
    // the new song from 0 (same keep-playing path as gapless AutoplayNext).
    const bool keepPlaying = playing.load(std::memory_order_acquire);
    return selectSongInternal(songIndex, error, fireOnLoadEventsFlag, keepPlaying, forceRestage);
}

bool AudioEngine::selectSongInternal(size_t songIndex, std::string& error, bool fireOnLoadEventsFlag,
                                     bool gaplessKeepPlaying, bool forceRestage) {
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
    if (!forceRestage && songIndex == currentSong && static_cast<bool>(streaming.acquireActiveSong())) {
        if (!wasPlaying)
            stop();
        else
            streamHandoff.store(true, std::memory_order_release);

        int64_t sameSongLengthFrames = 0;
        double maxContentSec = 0.0;
        for (const auto& r : song.regions)
            maxContentSec = std::max(maxContentSec, r.startSeconds + r.durationSeconds);
        const double bpm = song.bpm > 0.0 ? song.bpm : 120.0;
        for (const auto& mr : song.midiRegions) {
            const double mrEndSec = ((mr.startBeats + mr.durationBeats) * 60.0) / bpm;
            maxContentSec = std::max(maxContentSec, mrEndSec);
        }
        for (const auto& sec : song.sections)
            maxContentSec = std::max(maxContentSec, sec.startSeconds);
        for (const auto& ev : song.events)
            maxContentSec = std::max(maxContentSec, ev.timeSeconds);
        for (const auto& lc : song.lightCues)
            maxContentSec = std::max(maxContentSec, lc.startSeconds + lc.durationSeconds);
        if (maxContentSec > 0.0 && currentSampleRate > 0.0)
            sameSongLengthFrames = std::max(sameSongLengthFrames, static_cast<int64_t>(std::llround(maxContentSec * currentSampleRate)));
        sameSongLengthFrames = songLengthFrames(song.endSeconds, sameSongLengthFrames, currentSampleRate);

        {
            std::lock_guard<std::recursive_mutex> lock(routingMutex);
            clock.stop();
            hwSamplePosition.store(0, std::memory_order_relaxed);
            underrunFadeOutRemaining = 0;
            underrunFadeOutLength = 0;
            lastCallbackWasUnderrun = false;
            lastCallbackHostNanos = 0;
            pendingSongEndAction = SongEndAction::None;
            currentSongLengthFrames = sameSongLengthFrames;
            if (currentSampleRate > 0.0) {
                clickGenerator.prepare(currentSampleRate, song.bpm,
                                       song.timeSignature.numerator,
                                       song.timeSignature.denominator);
            }
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
                flushPauseTailRequested.store(true, std::memory_order_release);
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
    double maxContentSec = 0.0;
    for (const auto& r : song.regions)
        maxContentSec = std::max(maxContentSec, r.startSeconds + r.durationSeconds);
    const double bpm = song.bpm > 0.0 ? song.bpm : 120.0;
    for (const auto& mr : song.midiRegions) {
        const double mrEndSec = ((mr.startBeats + mr.durationBeats) * 60.0) / bpm;
        maxContentSec = std::max(maxContentSec, mrEndSec);
    }
    for (const auto& sec : song.sections)
        maxContentSec = std::max(maxContentSec, sec.startSeconds);
    for (const auto& ev : song.events)
        maxContentSec = std::max(maxContentSec, ev.timeSeconds);
    for (const auto& lc : song.lightCues)
        maxContentSec = std::max(maxContentSec, lc.startSeconds + lc.durationSeconds);
    if (maxContentSec > 0.0 && currentSampleRate > 0.0)
        newSongLengthFrames = std::max(newSongLengthFrames, static_cast<int64_t>(std::llround(maxContentSec * currentSampleRate)));

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

        auto newTempoMap = std::make_shared<const TempoMap>(song.bpm, song.tempoPoints);
        std::atomic_store_explicit(&activeTempoMap, std::move(newTempoMap), std::memory_order_release);

        auto pluginPub = std::atomic_load_explicit(&activePluginBank, std::memory_order_acquire);
        if (pluginPub != nullptr && pluginPub->bank != nullptr) {
            pluginPub->bank->requestAllNotesOff();
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

void AudioEngine::refreshActiveTempoMap() {
    if (!projectLoaded || currentSong >= loader.project().songs.size())
        return;
    const auto& song = loader.project().songs[currentSong];
    auto next = std::make_shared<const TempoMap>(song.bpm, song.tempoPoints);
    std::atomic_store_explicit(&activeTempoMap, std::move(next), std::memory_order_release);
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

    // A project cycle must be able to jump back inside a device block. Give
    // its source material resident-worker priority now, while there is still
    // time before the right locator. The callback only takes the exact
    // zero-I/O path once every active buffer has published its RAM window.
    streaming.setActiveSongCycleRandomAccess(appliesHere && !c.skip);
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
    // Tracks too: consumeTrackMeterInterval reports max(interval latch, last
    // rendered block), and with the transport stopped no block is rendered at
    // all -- so without clearing these, a track's peak stays parked at
    // whatever was playing when Stop was pressed (busses/click were already
    // cleared below; tracks were the missing half).
    for (size_t i = 0; i < trackPeakIntervalCount; ++i) {
        if (trackPeakIntervalMaxL) trackPeakIntervalMaxL[i].store(0.0f, std::memory_order_relaxed);
        if (trackPeakIntervalMaxR) trackPeakIntervalMaxR[i].store(0.0f, std::memory_order_relaxed);
        if (trackLastBlockPeakL) trackLastBlockPeakL[i].store(0.0f, std::memory_order_relaxed);
        if (trackLastBlockPeakR) trackLastBlockPeakR[i].store(0.0f, std::memory_order_relaxed);
    }
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
    // consumer of both. The audio thread pushes its own zero point on the
    // first stopped callback, which is what wins the race against a block
    // still in flight; see the callback.
    clickEnvelopeRing.clear();
    clickLastPeak = MeterEnvelopePoint{};
    for (size_t i = 0; i < busEnvelopeRings.size(); ++i) {
        if (busEnvelopeRings[i] != nullptr)
            busEnvelopeRings[i]->clear();
        if (i < busLastPeak.size())
            busLastPeak[i] = MeterEnvelopePoint{};
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








} // namespace resostage
