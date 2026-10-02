/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Project cycle synchronization and audio-thread gapless promotion.
// Song staging lives in AudioEngineSongSelection.cpp; message-thread
// play/stop/seek controls live in AudioEngineTransportControls.cpp.
// Capture lives in AudioEngineRecording.cpp; block-rate timeline event,
// MIDI-region, and automation dispatch lives in their dedicated TUs.
// These remain AudioEngine member TUs with identical private access.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "timing/SongLength.h"

#include <algorithm>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

namespace resostage {

using audio_engine_detail::kRingBufferSeconds;

void AudioEngine::publishStandaloneTempoMap(std::shared_ptr<const TempoMap> map) {
    // Message-thread only: retain the new standalone owner before publishing,
    // even if a later cache publication replaces it while audio still reads it.
    std::erase_if(retiredStandaloneTempoMaps, [](const auto& retired) { return retired.use_count() == 1; });
    retiredStandaloneTempoMaps.push_back(map);
    std::atomic_store_explicit(&activeTempoMap, std::move(map), std::memory_order_release);
}

void AudioEngine::refreshActiveTempoMap() {
    if (!projectLoaded || currentSong >= loader.project().songs.size())
        return;
    const auto& song = loader.project().songs[currentSong];
    songActivityDirty = true;
    refreshSongActivityIndex();
    const auto publication = std::atomic_load_explicit(&projectActivityIndex, std::memory_order_acquire);
    const auto* prepared = publication && publishedGraph ? publication->songAt(currentSong, song,
        *publishedGraph, projectEpoch.load(std::memory_order_acquire), currentSampleRate) : nullptr;
    if (prepared)
        std::atomic_store_explicit(&activeTempoMap, prepared->tempoMap, std::memory_order_release);
    else
        publishStandaloneTempoMap(std::make_shared<const TempoMap>(song.bpm, song.tempoPoints));
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


int64_t AudioEngine::songLengthFrames(double endSeconds,
                                      int64_t contentFrames,
                                      double sampleRate) {
    // Pure arithmetic with a rule behind it, so it lives in
    // engine/timing/SongLength.h where it can be tested without a device.
    return songLengthFramesFor(endSeconds, contentFrames, sampleRate);
}

bool AudioEngine::tryGaplessPromoteOnAudioThread(size_t nextSongIndex, const MixGraph& graph) {
    if (!projectLoaded || nextSongIndex >= loader.project().songs.size())
        return false;
    const SongDef& song = loader.project().songs[nextSongIndex];
    const auto publication = std::atomic_load_explicit(&projectActivityIndex, std::memory_order_acquire);
    const auto* prepared = publication ? publication->songAt(nextSongIndex, song,
        graph, projectEpoch.load(std::memory_order_acquire), currentSampleRate) : nullptr;
    // Missing preparation takes the established message-thread handoff before
    // touching streams. Never allocate a TempoMap or grow event flags on audio.
    if (prepared == nullptr || song.events.size() > eventFiredFlags.capacity())
        return false;
    if (!streaming.tryPromotePrecached(nextSongIndex))
        return false;

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

    setCurrentSongIndex(nextSongIndex);
    std::atomic_store_explicit(&activeTempoMap, prepared->tempoMap, std::memory_order_release);
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
