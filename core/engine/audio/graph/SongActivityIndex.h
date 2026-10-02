/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "audio/graph/MixGraph.h"
#include "project/ProjectSchema.h"
#include "timing/TempoMap.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace resostage {

/** Bounded time interval representing active content on a strip. */
struct ActivityInterval {
    double startSeconds{0.0};
    double endSeconds{0.0};
};

/** Coefficient/processor/cycle edits do not change interval binding. Content
 * mutation has an explicit message-thread invalidation at its owning boundary. */
inline bool needsActivityPreparation(bool contentChanged, const MixGraph* previous,
                                     const MixGraph& next) noexcept {
    return contentChanged || previous == nullptr
        || previous->projectEpoch != next.projectEpoch
        || previous->contentRevision != next.contentRevision
        || previous->routingLayoutKey != next.routingLayoutKey;
}

/** Pre-indexed intervals for a single strip with bound strip index. */
struct StripActivityPlan {
    uint32_t stripIndex{MixGraph::kNoStrip};
    // Non-overlapping, sorted by startSeconds and endSeconds
    std::vector<ActivityInterval> intervals;

    /**
     * O(log N) check whether any activity intersects the lookahead horizon [start, end).
     * Guaranteed non-allocating, wait-free and safe for the audio thread.
     */
    [[nodiscard]] bool intersects(double start, double end) const noexcept {
        if (start >= end || std::isnan(start) || std::isnan(end) || intervals.empty())
            return false;

        // Find first interval with endSeconds > start
        auto it = std::lower_bound(
            intervals.begin(), intervals.end(), start,
            [](const ActivityInterval& a, double val) noexcept {
                return a.endSeconds <= val;
            });

        return (it != intervals.end() && it->startSeconds < end);
    }
};

/**
 * Immutable pre-calculated activity index for the active song.
 * Rebuilt off-thread and atomically published to the audio thread.
 */
struct SongActivityIndex {
    uint64_t projectEpoch{0};
    std::string songId;
    uint64_t routingLayoutKey{0};
    double sampleRate{48000.0};
    // Owned with the prepared intervals, including after a gapless song hop.
    std::shared_ptr<const TempoMap> tempoMap;
    std::vector<StripActivityPlan> stripPlans;

    [[nodiscard]] bool intersects(uint32_t stripIndex, double start, double end) const noexcept {
        const auto plan = std::lower_bound(stripPlans.begin(), stripPlans.end(), stripIndex,
            [](const StripActivityPlan& item, uint32_t strip) { return item.stripIndex < strip; });
        return plan != stripPlans.end() && plan->stripIndex == stripIndex && plan->intersects(start, end);
    }

    [[nodiscard]] bool isCompatible(const SongDef& song,
                                   const MixGraph& graph,
                                   uint64_t currentProjectEpoch,
                                   double currentSampleRate) const noexcept {
        return isCompatible(song.id, graph, currentProjectEpoch, currentSampleRate);
    }

    [[nodiscard]] bool isCompatible(std::string_view requestedSongId,
                                   const MixGraph& graph,
                                   uint64_t currentProjectEpoch,
                                   double currentSampleRate) const noexcept {
        return projectEpoch == currentProjectEpoch
            && songId == requestedSongId
            && routingLayoutKey == graph.routingLayoutKey
            && std::abs(sampleRate - currentSampleRate) < 1e-6;
    }
};

/**
 * Builds an immutable SongActivityIndex for the given song, graph, and tempo map.
 * Must run on non-real-time threads (message thread, builder, or loader).
 */
inline std::shared_ptr<const SongActivityIndex> buildSongActivityIndex(
    const SongDef& song,
    const MixGraph& graph,
    const TempoMap& tempoMap,
    uint64_t projectEpoch,
    double sampleRate) {
    auto index = std::make_shared<SongActivityIndex>();
    index->projectEpoch = projectEpoch;
    index->songId = song.id;
    index->routingLayoutKey = graph.routingLayoutKey;
    index->sampleRate = sampleRate > 0.0 ? sampleRate : 48000.0;
    index->tempoMap = std::make_shared<const TempoMap>(tempoMap);

    struct RawInterval {
        double start;
        double end;
    };
    std::unordered_map<std::string, std::vector<RawInterval>> trackIntervals;

    // Collect audio regions
    for (const auto& reg : song.regions) {
        if (!std::isfinite(reg.startSeconds) || !std::isfinite(reg.durationSeconds) || reg.durationSeconds < 0.0)
            continue;
        const double regStart = reg.startSeconds;
        const double regEnd = (reg.durationSeconds > 0.0)
            ? (regStart + reg.durationSeconds)
            : std::numeric_limits<double>::infinity();
        if (regEnd <= regStart && reg.durationSeconds != 0.0)
            continue;
        trackIntervals[reg.trackId].push_back({regStart, regEnd});
    }

    // Collect MIDI regions, converting beat timing through the authoritative TempoMap
    for (const auto& mreg : song.midiRegions) {
        if (mreg.muted) continue;
        if (!std::isfinite(mreg.startBeats) || !std::isfinite(mreg.durationBeats) || mreg.durationBeats < 0.0)
            continue;
        const double mregStart = tempoMap.beatsToSeconds(mreg.startBeats);
        const double mregEnd = (mreg.durationBeats > 0.0)
            ? tempoMap.beatsToSeconds(mreg.startBeats + mreg.durationBeats)
            : std::numeric_limits<double>::infinity();
        if (mregEnd <= mregStart && mreg.durationBeats != 0.0)
            continue;
        trackIntervals[mreg.trackId].push_back({mregStart, mregEnd});
    }

    // Resolve stripIndex once and merge contiguous/overlapping intervals
    for (auto& [trackId, raw] : trackIntervals) {
        const uint32_t stripIdx = graph.find(trackId);
        if (stripIdx == MixGraph::kNoStrip || raw.empty())
            continue;

        std::sort(raw.begin(), raw.end(), [](const RawInterval& a, const RawInterval& b) {
            if (a.start < b.start) return true;
            if (a.start > b.start) return false;
            return a.end < b.end;
        });

        std::vector<ActivityInterval> merged;
        merged.reserve(raw.size());
        for (const auto& item : raw) {
            if (merged.empty() || item.start > merged.back().endSeconds) {
                merged.push_back({item.start, item.end});
            } else {
                merged.back().endSeconds = std::max(merged.back().endSeconds, item.end);
            }
        }

        StripActivityPlan plan;
        plan.stripIndex = stripIdx;
        plan.intervals = std::move(merged);
        index->stripPlans.push_back(std::move(plan));
    }

    // Sort plans by stripIndex for linear cache efficiency during traversal
    std::sort(index->stripPlans.begin(), index->stripPlans.end(),
        [](const StripActivityPlan& a, const StripActivityPlan& b) {
            return a.stripIndex < b.stripIndex;
        });

    return index;
}

/**
 * All songs share one immutable publication so gapless promotion needs no
 * preparation on audio. Fader/pan publications reuse this object. Content,
 * tempo, project epoch, routing layout or device-rate changes rebuild it on
 * the message thread. Limits bound preparation and retained storage; rejecting
 * preparation keeps the existing hosted chains awake, never scans on audio.
 */
struct ProjectActivityIndex {
    static constexpr size_t kMaximumSongs = 4096;
    static constexpr size_t kMaximumRegions = 1'048'576;
    static constexpr size_t kMaximumPlans = 65'536;
    static constexpr size_t kMaximumTempoPoints = 65'536;
    uint64_t contentRevision{0};
    std::vector<std::shared_ptr<const SongActivityIndex>> songs;

    /** Nested maps may outlive the audio's publication reference. Reclaim
     * only after activeTempoMap and in-flight MIDI readers release them. */
    [[nodiscard]] bool tempoMapsUnreferenced() const noexcept {
        return std::all_of(songs.begin(), songs.end(), [](const auto& song) {
            return song->tempoMap.use_count() == 1;
        });
    }

    [[nodiscard]] const SongActivityIndex* songAt(size_t songIndex, const SongDef& song,
                                                const MixGraph& graph, uint64_t epoch,
                                                double rate) const noexcept {
        if (contentRevision != graph.contentRevision || songIndex >= songs.size()
            || !songs[songIndex]->isCompatible(song, graph, epoch, rate))
            return nullptr;
        return songs[songIndex].get();
    }

    [[nodiscard]] const SongActivityIndex* songAt(size_t songIndex,
                                                std::string_view songId,
                                                const MixGraph& graph, uint64_t epoch,
                                                double rate) const noexcept {
        if (contentRevision != graph.contentRevision || songIndex >= songs.size()
            || !songs[songIndex]->isCompatible(songId, graph, epoch, rate))
            return nullptr;
        return songs[songIndex].get();
    }
};

/** Non-RT only. Null means the bounded all-song preparation was rejected. */
inline std::shared_ptr<const ProjectActivityIndex> buildProjectActivityIndex(
    const Project& project, const MixGraph& graph, uint64_t epoch, double sampleRate) {
    if (project.songs.size() > ProjectActivityIndex::kMaximumSongs)
        return {};
    size_t regions = 0;
    size_t tempoPoints = 0;
    for (const auto& song : project.songs) {
        for (const auto count : {song.regions.size(), song.midiRegions.size()}) {
            if (count > ProjectActivityIndex::kMaximumRegions - regions) return {};
            regions += count;
        }
        if (song.tempoPoints.size() > ProjectActivityIndex::kMaximumTempoPoints - tempoPoints) return {};
        tempoPoints += song.tempoPoints.size();
    }
    auto index = std::make_shared<ProjectActivityIndex>();
    index->contentRevision = graph.contentRevision;
    index->songs.reserve(project.songs.size());
    size_t plans = 0;
    for (const auto& song : project.songs) {
        auto prepared = buildSongActivityIndex(song, graph, TempoMap(song.bpm, song.tempoPoints), epoch, sampleRate);
        if (prepared->stripPlans.size() > ProjectActivityIndex::kMaximumPlans - plans) return {};
        plans += prepared->stripPlans.size();
        index->songs.push_back(std::move(prepared));
    }
    return index;
}

} // namespace resostage
