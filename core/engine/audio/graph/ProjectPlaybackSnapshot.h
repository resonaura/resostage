/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "audio/graph/MixGraph.h"
#include "project/ProjectSchema.h"
#include "timing/TempoMap.h"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace resostage {

struct PlaybackTrackState {
    std::string id;
    std::string inputSource;
    TrackKind kind{TrackKind::Audio};
    bool recordArmed{false};
    bool inputMonitoring{false};
    int channels{2};
    int midiInputChannel{0};
    uint32_t stripIndex{MixGraph::kNoStrip};
};

struct PlaybackSongState {
    std::string id;
    double bpm{120.0};
    TimeSignature timeSignature{};
    SongEnd onEnded{SongEnd::Stop};
    std::vector<Region> regions;
    std::vector<MidiRegion> midiRegions;
    std::vector<AutomationLane> automationLanes;
    std::vector<TimelineEvent> events;
    std::shared_ptr<const TempoMap> tempoMap;
};

struct ProjectPlaybackContent {
    std::vector<PlaybackSongState> songs;
};

/**
 * Immutable, block-consistent subset of Project needed by the audio callback.
 * The MixGraph owns this object, so graph publication and RCU retirement also
 * govern the lifetime of every string, region, event, and tempo map it reads.
 */
struct ProjectPlaybackSnapshot {
    static constexpr size_t kMaximumTracks = 4096;
    static constexpr size_t kMaximumSongs = 4096;
    static constexpr size_t kMaximumRegions = 1'048'576;
    static constexpr size_t kMaximumMidiEvents = 4'194'304;
    static constexpr size_t kMaximumAutomationPoints = 2'097'152;
    static constexpr size_t kMaximumTimelineEvents = 1'048'576;
    static constexpr size_t kMaximumTempoPoints = 65'536;
    static constexpr size_t kMaximumRetainedBytes = 128u * 1024u * 1024u;

    uint64_t projectEpoch{0};
    uint64_t contentRevision{0};
    bool clickEnabled{false};
    std::vector<PlaybackTrackState> tracks;
    std::shared_ptr<const ProjectPlaybackContent> content;

    [[nodiscard]] const PlaybackSongState* songAt(size_t index) const noexcept {
        return content != nullptr && index < content->songs.size()
            ? &content->songs[index] : nullptr;
    }

    [[nodiscard]] const PlaybackTrackState* trackAt(size_t index) const noexcept {
        return index < tracks.size() ? &tracks[index] : nullptr;
    }

    [[nodiscard]] const PlaybackTrackState* findTrack(std::string_view id) const noexcept {
        for (const auto& track : tracks)
            if (track.id == id)
                return &track;
        return nullptr;
    }
};

struct ProjectPlaybackBuildResult {
    std::shared_ptr<const ProjectPlaybackSnapshot> snapshot;
    std::string error;
};

namespace playback_snapshot_detail {

inline bool addBytes(size_t& total, size_t amount) noexcept {
    if (amount > ProjectPlaybackSnapshot::kMaximumRetainedBytes - total)
        return false;
    total += amount;
    return true;
}

inline bool addItems(size_t& total, size_t count, size_t itemSize) noexcept {
    if (count > ProjectPlaybackSnapshot::kMaximumRetainedBytes / itemSize)
        return false;
    return addBytes(total, count * itemSize);
}

inline bool addText(size_t& total, const std::string& text) noexcept {
    return addBytes(total, text.size());
}

inline bool accountLane(size_t& bytes, size_t& points, const AutomationLane& lane) noexcept {
    if (!addItems(bytes, 1, sizeof(AutomationLane))
        || !addText(bytes, lane.id)
        || !addText(bytes, lane.target.entityId)
        || !addText(bytes, lane.target.stripId)
        || !addText(bytes, lane.target.parameterId)
        || lane.points.size() > ProjectPlaybackSnapshot::kMaximumAutomationPoints - points
        || !addItems(bytes, lane.points.size(), sizeof(AutomationPoint)))
        return false;
    points += lane.points.size();
    return true;
}

inline bool accountLanes(size_t& bytes, size_t& points,
                         const std::vector<AutomationLane>& lanes) noexcept {
    for (const auto& lane : lanes)
        if (!accountLane(bytes, points, lane))
            return false;
    return true;
}

inline bool accountRegion(size_t& bytes, size_t& points, const Region& region) noexcept {
    return addItems(bytes, 1, sizeof(Region))
        && addText(bytes, region.id)
        && addText(bytes, region.trackId)
        && addText(bytes, region.source.file)
        && addText(bytes, region.source.videoFile)
        && accountLanes(bytes, points, region.automationLanes);
}

inline bool accountMidiRegion(size_t& bytes, size_t& points, size_t& midiEvents,
                              const MidiRegion& region) noexcept {
    if (region.notes.size() > ProjectPlaybackSnapshot::kMaximumMidiEvents - midiEvents)
        return false;
    midiEvents += region.notes.size();
    if (region.events.size() > ProjectPlaybackSnapshot::kMaximumMidiEvents - midiEvents)
        return false;
    midiEvents += region.events.size();
    if (region.umpEvents.size() > ProjectPlaybackSnapshot::kMaximumMidiEvents - midiEvents)
        return false;
    midiEvents += region.umpEvents.size();
    if (!addItems(bytes, 1, sizeof(MidiRegion))
        || !addText(bytes, region.id)
        || !addText(bytes, region.trackId)
        || !addText(bytes, region.name)
        || !addText(bytes, region.color)
        || !addItems(bytes, region.notes.size(), sizeof(MidiNote))
        || !addItems(bytes, region.events.size(), sizeof(MidiClipEvent))
        || !addItems(bytes, region.umpEvents.size(), sizeof(MidiUmpEvent)))
        return false;
    for (const auto& event : region.events)
        if (!addItems(bytes, event.data.size(), sizeof(uint8_t)))
            return false;
    return accountLanes(bytes, points, region.automationLanes);
}

inline bool accountTimelineEvent(size_t& bytes, const TimelineEvent& event) noexcept {
    return addItems(bytes, 1, sizeof(TimelineEvent))
        && addText(bytes, event.id)
        && (!event.httpUrl || addText(bytes, *event.httpUrl))
        && addText(bytes, event.httpMethod)
        && (!event.httpBody || addText(bytes, *event.httpBody))
        && addItems(bytes, event.dmxData.size(), sizeof(uint8_t));
}

} // namespace playback_snapshot_detail

/** Non-RT only. A failed bound rejects publication; audio never scans Project. */
inline ProjectPlaybackBuildResult buildProjectPlaybackSnapshot(
    const Project& project, const MixGraph& graph, uint64_t projectEpoch,
    uint64_t contentRevision,
    const std::shared_ptr<const ProjectPlaybackSnapshot>& previous,
    bool contentChanged) {
    using namespace playback_snapshot_detail;
    ProjectPlaybackBuildResult result;
    if (project.tracks.size() > ProjectPlaybackSnapshot::kMaximumTracks
        || project.songs.size() > ProjectPlaybackSnapshot::kMaximumSongs) {
        result.error = "Project playback snapshot exceeds the track or song limit";
        return result;
    }

    size_t estimatedBytes = 0;
    for (const auto& track : project.tracks) {
        if (!addItems(estimatedBytes, 1, sizeof(PlaybackTrackState))
            || !addText(estimatedBytes, track.id)
            || !addText(estimatedBytes, track.inputSource)) {
            result.error = "Project playback track snapshot exceeds its memory limit";
            return result;
        }
    }

    const bool canReuseContent = !contentChanged && previous != nullptr
        && previous->projectEpoch == projectEpoch
        && previous->contentRevision == contentRevision
        && previous->content != nullptr;
    if (!canReuseContent) {
        if (project.songs.size() > ProjectPlaybackSnapshot::kMaximumSongs) {
            result.error = "Project playback snapshot exceeds the song limit";
            return result;
        }
        size_t regions = 0;
        size_t midiEvents = 0;
        size_t points = 0;
        size_t timelineEvents = 0;
        size_t tempoPoints = 0;
        for (const auto& song : project.songs) {
            if (!addItems(estimatedBytes, 1, sizeof(PlaybackSongState))
                || !addText(estimatedBytes, song.id)
                || song.regions.size() > ProjectPlaybackSnapshot::kMaximumRegions - regions
                || song.midiRegions.size() > ProjectPlaybackSnapshot::kMaximumRegions - regions - song.regions.size()
                || song.events.size() > ProjectPlaybackSnapshot::kMaximumTimelineEvents - timelineEvents
                || song.tempoPoints.size() > ProjectPlaybackSnapshot::kMaximumTempoPoints - tempoPoints) {
                result.error = "Project playback snapshot exceeds its region or event limit";
                return result;
            }
            regions += song.regions.size() + song.midiRegions.size();
            timelineEvents += song.events.size();
            tempoPoints += song.tempoPoints.size();
            if (!addItems(estimatedBytes, song.tempoPoints.size(), sizeof(TempoPoint))) {
                result.error = "Project playback snapshot exceeds its tempo-map memory limit";
                return result;
            }
            for (const auto& region : song.regions) {
                if (!accountRegion(estimatedBytes, points, region)) {
                    result.error = "Project playback snapshot exceeds its automation or memory limit";
                    return result;
                }
            }
            for (const auto& region : song.midiRegions) {
                if (!accountMidiRegion(estimatedBytes, points, midiEvents, region)) {
                    result.error = "Project playback snapshot exceeds its MIDI or memory limit";
                    return result;
                }
            }
            if (!accountLanes(estimatedBytes, points, song.automationLanes)) {
                result.error = "Project playback snapshot exceeds its automation limit";
                return result;
            }
            for (const auto& event : song.events) {
                if (!accountTimelineEvent(estimatedBytes, event)) {
                    result.error = "Project playback snapshot exceeds its event memory limit";
                    return result;
                }
            }
        }
    }

    try {
        auto next = std::make_shared<ProjectPlaybackSnapshot>();
        next->projectEpoch = projectEpoch;
        next->contentRevision = contentRevision;
        next->clickEnabled = project.click.enabled;
        next->tracks.reserve(project.tracks.size());
        for (const auto& track : project.tracks) {
            PlaybackTrackState state;
            state.id = track.id;
            state.inputSource = track.inputSource;
            state.kind = track.kind;
            state.recordArmed = track.recordArmed;
            state.inputMonitoring = track.inputMonitoring;
            state.channels = track.channels;
            state.midiInputChannel = track.midiInputChannel;
            state.stripIndex = graph.find(track.effectiveStripId());
            next->tracks.push_back(std::move(state));
        }

        if (canReuseContent) {
            next->content = previous->content;
        } else {
            auto content = std::make_shared<ProjectPlaybackContent>();
            content->songs.reserve(project.songs.size());
            for (const auto& song : project.songs) {
                PlaybackSongState state;
                state.id = song.id;
                state.bpm = song.bpm;
                state.timeSignature = song.timeSignature;
                state.onEnded = song.onEnded;
                state.regions = song.regions;
                state.midiRegions = song.midiRegions;
                state.automationLanes = song.automationLanes;
                state.events = song.events;
                state.tempoMap = std::make_shared<const TempoMap>(song.bpm, song.tempoPoints);
                content->songs.push_back(std::move(state));
            }
            next->content = std::move(content);
        }
        result.snapshot = std::move(next);
    } catch (const std::bad_alloc&) {
        result.error = "Project playback snapshot allocation failed";
    }
    return result;
}

} // namespace resostage
