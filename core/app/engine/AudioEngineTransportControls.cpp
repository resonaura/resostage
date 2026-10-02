/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Message-thread transport controls and same-project seeking.
// The audio callback remains the authority for sample-accurate playback.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "events/DueQueue.h"

#include <algorithm>
#include <limits>
#include <string>

namespace resostage {

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

    if (!pluginLoadingSession.requestTransport(true)) return;

    const int64_t pendingCountInStart = pendingCountInStartSample.exchange(
        std::numeric_limits<int64_t>::min(), std::memory_order_acq_rel);
    const bool startingWithCountIn = pendingCountInStart != std::numeric_limits<int64_t>::min();

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
    if (projectLoaded && !startingWithCountIn) {
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
    int64_t startSample = startingWithCountIn
        ? pendingCountInStart : clock.currentSamplePosition();
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
    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);
        underrunFadeOutRemaining = 0;
        underrunFadeOutLength = 0;
        pendingSongEndAction = SongEndAction::None;
        const int fadeIn = 256;
        recoveryFadeInLength = fadeIn;
        recoveryFadeInRemaining = fadeIn;
        outputHeldSilent = false;
    }

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
    pluginLoadingSession.stop();
    if (isRecordingState.load(std::memory_order_acquire)) {
        stopRecording();
    }

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
    // Pause tail: we intentionally do NOT call resetMetersSilent() here.
    // The audio callback renders the decaying tail of active reverbs/delays,
    // publishing live decaying meters until the tail decays to silence.
    auto pluginPub = std::atomic_load_explicit(&activePluginBank, std::memory_order_acquire);
    if (pluginPub != nullptr && pluginPub->bank != nullptr) {
        pluginPub->bank->requestAllNotesOff();
    }
    activeMidiNotesClearRequested.store(true, std::memory_order_release);
    flushDeferredAutosave();
}

void AudioEngine::stopToStart() {
    const bool wasAlreadyStopped = !playing.load(std::memory_order_acquire);
    if (wasAlreadyStopped) {
        hardAllSoundOffRequested.store(true, std::memory_order_release);
        activeMidiNotesClearRequested.store(true, std::memory_order_release);
    }
    flushPauseTailRequested.store(true, std::memory_order_release);
    resetMetersSilent();
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
    if (!projectLoaded || (currentSong == static_cast<size_t>(-1) && songIndex == static_cast<size_t>(-1))) {
        error = "No song selected";
        return false;
    }

    const bool wasPlaying = playing.load(std::memory_order_acquire);
    const size_t targetSong = (songIndex == static_cast<size_t>(-1))
        ? currentSong.load(std::memory_order_acquire) : songIndex;
    if (targetSong >= loader.project().songs.size()) {
        error = "Song index out of range";
        return false;
    }

    const bool sameSong = (targetSong == currentSong);

    // Cross-song: full restage (StreamingTrackBuffer is forward-only per open).
    // Same-song: hard-seek in place WITHOUT stop/play -- scrub used to call
    // selectSong (which stops) then restart, producing a one-buffer "blip
    // then silence then play" glitch on every drag.
    // If the active song was not yet staged into streaming, force restage even on sameSong.
    if (!sameSong || !streaming.acquireActiveSong()) {
        if (!selectSong(targetSong, error, /*fireOnLoadEvents=*/false, /*forceRestage=*/true))
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
        flushPauseTailRequested.store(true, std::memory_order_release);
        resetMetersSilent();
        auto pluginPub = std::atomic_load_explicit(&activePluginBank, std::memory_order_acquire);
        if (pluginPub != nullptr && pluginPub->bank != nullptr) {
            pluginPub->bank->requestAllNotesOff();
            const auto graph = publishedGraph;
            const auto* playbackSong = graph != nullptr && graph->playbackState != nullptr
                ? graph->playbackState->songAt(targetSong) : nullptr;
            if (playbackSong != nullptr) {
                prewarmPluginsLookahead(*playbackSong, targetSong, sample, currentSampleRate,
                                        graph.get(), pluginPub->bank.get(),
                                        playbackSong->tempoMap.get());
            } else {
                pluginPub->bank->prewarmAllStrips();
            }
        }
        activeMidiNotesClearRequested.store(true, std::memory_order_release);

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

} // namespace resostage
