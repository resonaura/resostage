#pragma once

#include "AutomationCurve.h"
#include "project/ProjectSchema.h"
#include "timing/TempoMap.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

namespace resostage {

/**
 * Unified high-performance automation evaluator.
 *
 * Supports single-point queries, amortized O(1) sequential cursor-based evaluation,
 * vectorized block rendering, and multi-scope hierarchy resolution (Track -> Region -> Modulation).
 * Zero heap allocations in audio thread execution.
 */
class AutomationEvaluator {
public:
    /**
     * Evaluates a breakpoint list at a specific beat position.
     */
    [[nodiscard]] static float evaluatePoints(
        const std::vector<AutomationPoint>& points,
        double timeBeats,
        float defaultValue = 0.0f) noexcept;

    /**
     * Evaluates a breakpoint list with cursor tracking for O(1) amortized sequential traversal.
     */
    [[nodiscard]] static float evaluatePointsWithCursor(
        const std::vector<AutomationPoint>& points,
        double timeBeats,
        size_t& cursor,
        float defaultValue = 0.0f) noexcept;

    /**
     * Evaluates a full lane at a given beat position.
     */
    [[nodiscard]] static float evaluateLane(
        const AutomationLane& lane,
        double timeBeats,
        float defaultValue = 0.0f) noexcept;

    /**
     * Real-time audio block evaluation for a single lane without memory allocations.
     * Converts sample indices into musical beats using the provided TempoMap.
     */
    static void evaluateLaneBlock(
        const AutomationLane& lane,
        const TempoMap* tempoMap,
        int64_t blockStartSample,
        int numSamples,
        double sampleRate,
        float* outputBuffer,
        size_t& cursor,
        float defaultValue = 0.0f) noexcept;

    /**
     * Multi-scope resolution:
     * 1. Evaluates timeline-locked TrackAutomation.
     * 2. Overrides with RegionAutomation if an active region on track covers the playhead.
     * 3. Applies RegionModulation delta (+- delta) if present.
     * 4. Clamps within target bounds [minValue, maxValue].
     */
    [[nodiscard]] static float resolveMultiScopeValue(
        const SongDef& song,
        const AutomationTarget& target,
        double songPlayheadBeats,
        double songPlayheadSeconds,
        std::optional<std::string_view> trackId = std::nullopt,
        const TempoMap* tempoMap = nullptr) noexcept;
};

} // namespace resostage
