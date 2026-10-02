/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "project/ProjectSchema.h"

#include <cstddef>
#include <vector>

namespace resostage {

/**
 * Ramer-Douglas-Peucker (RDP) trajectory thinning for automation curves.
 *
 * Reduces dense high-rate controller data (e.g. 100 Hz MIDI/USB fader gestures)
 * into minimal breakpoint nodes while keeping maximum error within tolerance epsilon.
 */
class RamerDouglasPeucker {
public:
    static constexpr size_t kMaximumDistanceEvaluations = 4'194'304;
    /**
     * Thins an array of automation points using the Ramer-Douglas-Peucker algorithm.
     *
     * @param points Input breakpoint list, must be sorted by timeBeats.
     * @param epsilon Maximum perpendicular deviation in normalized space (default 0.002 = 0.2% fader travel).
     * Runs off the audio thread with an explicit work stack, never recursive
     * call-stack growth. If thinning exhausts its distance-comparison budget,
     * it returns the complete sanitized trajectory instead of losing samples.
     * @return Reduced breakpoint list, or lossless budget fallback.
     */
    [[nodiscard]] static std::vector<AutomationPoint> thin(
        const std::vector<AutomationPoint>& points,
        double epsilon = 0.002);

private:
    static bool rdpBounded(
        const std::vector<AutomationPoint>& points,
        size_t firstIdx,
        size_t lastIdx,
        double epsilon,
        double tMin,
        double tRange,
        double vMin,
        double vRange,
        std::vector<bool>& keepFlags);
};

} // namespace resostage
