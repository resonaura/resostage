/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "project/HistoryRestore.h"
#include "timing/SongLength.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace resostage {

double AudioEngine::currentSongLengthSeconds() const {
    if (currentSampleRate <= 0.0 || currentSongLengthFrames <= 0)
        return 0.0;
    return static_cast<double>(currentSongLengthFrames) / currentSampleRate;
}

void AudioEngine::updateRegionWindow(const Region& r) {
    streaming.updateRegionWindow(r, currentSampleRate);
}

void AudioEngine::resyncStreamingWindowsForCurrentSong() {
    if (!projectLoaded || currentSong >= loader.project().songs.size())
        return;
    const SongDef& song = loader.project().songs[currentSong];
    for (const Region& r : song.regions)
        updateRegionWindow(r);
}

bool AudioEngine::undoTimelineEdit(std::string& appliedLabel) {
    appliedLabel = projectHistory.undoLabel();
    auto restored = projectHistory.undo();
    if (!restored.has_value())
        return false;
    applyHistoryProject(std::move(*restored));
    return true;
}

bool AudioEngine::redoTimelineEdit(std::string& appliedLabel) {
    appliedLabel = projectHistory.redoLabel();
    auto restored = projectHistory.redo();
    if (!restored.has_value())
        return false;
    applyHistoryProject(std::move(*restored));
    return true;
}

void AudioEngine::applyHistoryProject(Project restored) {
    // History stores whole Project values. Keep the callback out until both
    // the new document storage and its graph/event arrays are published.
    // This is the same document: healthy unchanged plug-in helpers keep their
    // epoch, state, and tails instead of being restarted for every Undo.
    ProjectReplacementScope replacement(*this, false);
    const auto previousSong = currentSong;
    const auto& previous = loader.project();
    const std::string songId = previousSong < previous.songs.size()
        ? previous.songs[previousSong].id : std::string{};
    const double previousBpm = previousSong < previous.songs.size() ? previous.songs[previousSong].bpm : 120.0;
    const TimeSignature previousMeter = previousSong < previous.songs.size()
        ? previous.songs[previousSong].timeSignature : TimeSignature{};
    const int previousFocus = focusedTrack();
    const std::string focusedId = previousFocus >= 0
        && static_cast<size_t>(previousFocus) < previous.tracks.size()
        ? previous.tracks[static_cast<size_t>(previousFocus)].id : std::string{};
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    int64_t cursor = wasPlaying ? hwSamplePosition.load(std::memory_order_relaxed)
                               : clock.currentSamplePosition();
    loader.project() = std::move(restored);
    const auto& project = loader.project();
    const int64_t capacity = static_cast<int64_t>(currentSampleRate * audio_engine_detail::kRingBufferSeconds);
    streaming.invalidateIncompatibleWarmSongs(project.songs, capacity, currentSampleRate);
    currentSong = resolveHistorySongIndex(project, songId, previousSong).value_or(static_cast<size_t>(-1));

    int nextFocus = -1;
    for (size_t i = 0; i < project.tracks.size(); ++i) {
        if (!focusedId.empty() && project.tracks[i].id == focusedId) {
            nextFocus = static_cast<int>(i);
            break;
        }
    }
    setFocusedTrack(nextFocus);
    bool sourcesReady = true;
    if (currentSong < project.songs.size()) {
        const auto& song = project.songs[currentSong];
        refreshActiveTempoMap();
        const TempoMap tempo(song.bpm, song.tempoPoints);
        double contentSeconds = 0.0;
        for (const auto& region : song.regions)
            contentSeconds = std::max(contentSeconds, region.startSeconds + regionEffectiveDurationSeconds(region));
        for (const auto& region : song.midiRegions)
            contentSeconds = std::max(contentSeconds, tempo.beatsToSeconds(region.startBeats + region.durationBeats));
        for (const auto& section : song.sections)
            contentSeconds = std::max(contentSeconds, section.startSeconds);
        for (const auto& event : song.events)
            contentSeconds = std::max(contentSeconds, event.timeSeconds);
        for (const auto& cue : song.lightCues)
            contentSeconds = std::max(contentSeconds, cue.startSeconds + cue.durationSeconds);
        currentSongLengthFrames = songLengthFramesFor(song.endSeconds,
            static_cast<int64_t>(std::llround(contentSeconds * currentSampleRate)), currentSampleRate);
        if (currentSongLengthFrames > 0)
            cursor = std::min(cursor, currentSongLengthFrames);
        if (!streaming.activeSongMatches(currentSong, song, capacity, currentSampleRate)) {
            std::string error;
            sourcesReady = streaming.rebindActiveSongAt(currentSong, song, capacity,
                                                        currentSampleRate, cursor, error);
            if (!sourcesReady) {
                // Missing/corrupt restored media must never fall back to an
                // unrelated old track buffer and emit the wrong audio.
                streaming.clearActiveSong();
                juce::Logger::writeToLog("History source restoration failed: " + juce::String(error));
            }
        } else {
            resyncStreamingWindowsForCurrentSong();
        }
        if (currentSampleRate > 0.0)
            clickGenerator.prepare(currentSampleRate, song.bpm,
                                   song.timeSignature.numerator, song.timeSignature.denominator);
        eventFiredFlags.assign(song.events.size(), 0);
        const double seconds = currentSampleRate > 0.0 ? static_cast<double>(cursor) / currentSampleRate : 0.0;
        for (size_t i = 0; i < song.events.size(); ++i) {
            const auto& event = song.events[i];
            if (!event.triggerOnLoad && event.timeSeconds - event.latencyCompensationMs / 1000.0 <= seconds)
                eventFiredFlags[i] = 1;
        }
    } else {
        streaming.clearActiveSong();
        currentSongLengthFrames = 0;
        cursor = 0;
        sourcesReady = false;
        eventFiredFlags.clear();
    }
    // Keep device sample position and Core's projected clock coherent. No
    // on-load events or message-thread song seek is fired by history replay.
    hwSamplePosition.store(cursor, std::memory_order_relaxed);
    clock.start(currentSampleRate, cursor);
    if (!wasPlaying || !sourcesReady)
        clock.stop();
    playing.store(wasPlaying && sourcesReady, std::memory_order_release);
    transportTelemetry.playheadSamples.store(cursor, std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(currentSampleRate > 0.0
        ? static_cast<double>(cursor) / currentSampleRate : 0.0, std::memory_order_relaxed);
    transportTelemetry.running.store(wasPlaying && sourcesReady, std::memory_order_relaxed);
    streamHandoff.store(false, std::memory_order_release);
    pendingSongEndAction = SongEndAction::None;
    syncTransportCycleFromProject();
    rebuildBussesFromProject();
    const auto* activeSong = currentSong < project.songs.size() ? &project.songs[currentSong] : nullptr;
    if (wasPlaying && sourcesReady && activeSong
        && (activeSong->id != songId || activeSong->bpm != previousBpm
            || activeSong->timeSignature.numerator != previousMeter.numerator
            || activeSong->timeSignature.denominator != previousMeter.denominator))
        syncMidiTransportToCurrentSong(/*sendContinue=*/false);
    markDirty();
}

double AudioEngine::songAuthoredDurationSeconds(const SongDef& song) const {
    double maxEnd = 0.0;
    for (const Region& r : song.regions)
        maxEnd = std::max(maxEnd, r.startSeconds + regionEffectiveDurationSeconds(r));
    return maxEnd;
}

double AudioEngine::globalPlayheadSeconds() const {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1))
        return 0.0;
    const Project& proj = loader.project();
    double offset = 0.0;
    for (size_t i = 0; i < currentSong && i < proj.songs.size(); ++i)
        offset += songAuthoredDurationSeconds(proj.songs[i]);
    return offset + clock.currentSeconds();
}

double AudioEngine::globalBeatsElapsed() const {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1) || currentSong >= loader.project().songs.size())
        return 0.0;
    const Project& proj = loader.project();
    double beats = 0.0;
    for (size_t i = 0; i < currentSong; ++i)
        beats += songAuthoredDurationSeconds(proj.songs[i]) * (proj.songs[i].bpm / 60.0);
    beats += clock.currentSeconds() * (proj.songs[currentSong].bpm / 60.0);
    return beats;
}

} // namespace resostage
