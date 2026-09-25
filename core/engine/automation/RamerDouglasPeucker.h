#pragma once

#include "project/ProjectSchema.h"

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
    /**
     * Thins an array of automation points using the Ramer-Douglas-Peucker algorithm.
     *
     * @param points Input breakpoint list, must be sorted by timeBeats.
     * @param epsilon Maximum perpendicular deviation in normalized space (default 0.002 = 0.2% fader travel).
     * @return Reduced breakpoint list.
     */
    [[nodiscard]] static std::vector<AutomationPoint> thin(
        const std::vector<AutomationPoint>& points,
        double epsilon = 0.002);

private:
    static void rdpRecursive(
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
