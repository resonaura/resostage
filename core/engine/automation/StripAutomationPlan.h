/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "AutomationEvaluator.h"
#include "project/ProjectSchema.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cmath>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace resostage {

struct MixGraph;
class MixRenderer;

/**
 * Immutable, pre-bound track-scope envelopes for a mix publication.
 *
 * Preparation copies project points and resolves strip and edge IDs off audio.
 * The MixGraph owns this plan and retires it through the graph's existing
 * lifetime mechanism; a callback never becomes the last owner of these point
 * vectors. Evaluation takes the actual segment beat, not an accumulated phase,
 * so seeks, tempo changes and exact cycle splits all select the same envelope.
 * Empty/muted/disabled lanes do not override manual mixer coefficients.
 * Region scopes and plug-in vendor parameters remain outside this contract.
 */
class StripAutomationPlan {
public:
    enum class Parameter : uint8_t { GainDb, Pan, Mute, SendGain };

    struct EvaluatedValue {
        std::string_view laneId;
        uint32_t stripIndex = 0;
        uint32_t edgeIndex = 0;
        Parameter parameter = Parameter::GainDb;
        float value = 0.0f;
    };

    static constexpr size_t kMaximumSongs = 4096;
    static constexpr size_t kMaximumLanes = 65536;
    static constexpr size_t kMaximumPoints = 1048576;

    // Message/offline worker thread only. A malformed or over-budget plan
    // returns null with an explanation; allocation failure may propagate to
    // the caller's existing non-realtime preparation failure handling.
    [[nodiscard]] static std::shared_ptr<const StripAutomationPlan> prepare(
        const Project& project, const MixGraph& graph, std::string& error);

    // Audio/offline DSP owner only, after renderer.beginBlock(). Bounded by
    // the admitted plan, with no strings, allocation or mutable project access.
    void apply(size_t songIndex, double segmentBeat, MixRenderer& renderer,
               const std::unordered_set<std::string>* manualOverrides = nullptr) const noexcept;

    // Shared evaluation of every admitted binding. The audio/offline renderer
    // uses this path too; visitors used there must remain noexcept, bounded,
    // and allocation-free. It exposes scalar values and resolved indices,
    // never mutable project references or target-string lookups.
    template <typename Visitor>
    void visitValues(size_t songIndex, double segmentBeat,
                     const std::unordered_set<std::string>* manualOverrides,
                     Visitor&& visitor) const {
        if (songIndex >= songs.size() || !std::isfinite(segmentBeat))
            return;
        for (const auto& binding : songs[songIndex].lanes) {
            if (manualOverrides != nullptr && manualOverrides->contains(binding.laneId))
                continue;
            const float value = std::clamp(
                AutomationEvaluator::evaluatePoints(binding.points, segmentBeat),
                binding.minValue, binding.maxValue);
            visitor(EvaluatedValue{binding.laneId, binding.stripIndex,
                                   binding.edgeIndex, binding.parameter, value});
        }
    }

    // Message-thread control telemetry only. Preparation indexes the winning
    // gain/pan binding per strip and send binding per edge, so a 60 Hz state
    // publication does not scan unrelated mute lanes. The total indexed work
    // is bounded by the prepared strip and edge counts.
    template <typename Visitor>
    void visitControlValues(size_t songIndex, double segmentBeat,
                            const std::unordered_set<std::string>* manualOverrides,
                            Visitor&& visitor) const {
        if (songIndex >= songs.size() || !std::isfinite(segmentBeat))
            return;
        const auto& song = songs[songIndex];
        for (const size_t index : song.controlValues) {
            if (index >= song.lanes.size())
                continue;
            const auto& binding = song.lanes[index];
            if (manualOverrides != nullptr && manualOverrides->contains(binding.laneId))
                continue;
            const float value = std::clamp(
                AutomationEvaluator::evaluatePoints(binding.points, segmentBeat),
                binding.minValue, binding.maxValue);
            visitor(EvaluatedValue{binding.laneId, binding.stripIndex,
                                   binding.edgeIndex, binding.parameter, value});
        }
    }

    [[nodiscard]] size_t bindingCount(size_t songIndex) const noexcept;

private:
    struct Binding {
        std::string laneId;
        uint32_t stripIndex = 0;
        uint32_t edgeIndex = 0;
        Parameter parameter = Parameter::GainDb;
        float minValue = 0.0f;
        float maxValue = 1.0f;
        std::vector<AutomationPoint> points;
    };
    struct SongBindings {
        std::vector<Binding> lanes;
        std::vector<size_t> controlValues;
    };
    std::vector<SongBindings> songs;
};

} // namespace resostage
