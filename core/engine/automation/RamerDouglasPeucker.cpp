#include "RamerDouglasPeucker.h"

#include <algorithm>
#include <cmath>

namespace resostage {

std::vector<AutomationPoint> RamerDouglasPeucker::thin(
    const std::vector<AutomationPoint>& points,
    double epsilon) {
    if (points.size() <= 2 || !std::isfinite(epsilon) || epsilon <= 0.0)
        return points;

    // Filter out non-finite points and copy
    std::vector<AutomationPoint> sanitized;
    sanitized.reserve(points.size());
    for (const auto& pt : points) {
        if (std::isfinite(pt.timeBeats) && std::isfinite(pt.value) && std::isfinite(pt.curve)) {
            sanitized.push_back(pt);
        }
    }

    if (sanitized.size() <= 2)
        return sanitized;

    // Pre-sort by timestamp
    std::stable_sort(sanitized.begin(), sanitized.end(), [](const AutomationPoint& a, const AutomationPoint& b) {
        return a.timeBeats < b.timeBeats;
    });

    // Filter duplicate identical timestamps
    std::vector<AutomationPoint> uniquePoints;
    uniquePoints.reserve(sanitized.size());
    for (const auto& pt : sanitized) {
        if (!uniquePoints.empty() && std::abs(uniquePoints.back().timeBeats - pt.timeBeats) < 1.0e-9) {
            uniquePoints.back() = pt; // replace with latest
        } else {
            uniquePoints.push_back(pt);
        }
    }

    if (uniquePoints.size() <= 2)
        return uniquePoints;

    double tMin = uniquePoints.front().timeBeats;
    double tMax = uniquePoints.back().timeBeats;
    double vMin = uniquePoints.front().value;
    double vMax = uniquePoints.front().value;
    for (const auto& pt : uniquePoints) {
        if (pt.value < vMin) vMin = pt.value;
        if (pt.value > vMax) vMax = pt.value;
    }

    const double tRange = std::max(1.0e-6, tMax - tMin);
    const double vRange = std::max(1.0e-6, vMax - vMin);

    std::vector<bool> keepFlags(uniquePoints.size(), false);
    keepFlags.front() = true;
    keepFlags.back() = true;

    // Retain points that define non-linear curves
    for (size_t i = 1; i + 1 < uniquePoints.size(); ++i) {
        if (std::abs(uniquePoints[i].curve) > 1.0e-4) {
            keepFlags[i] = true;
        }
    }

    rdpRecursive(uniquePoints, 0, uniquePoints.size() - 1, epsilon,
                 tMin, tRange, vMin, vRange, keepFlags);

    std::vector<AutomationPoint> result;
    result.reserve(uniquePoints.size());
    for (size_t i = 0; i < uniquePoints.size(); ++i) {
        if (keepFlags[i]) {
            result.push_back(uniquePoints[i]);
        }
    }
    return result;
}

void RamerDouglasPeucker::rdpRecursive(
    const std::vector<AutomationPoint>& points,
    size_t firstIdx,
    size_t lastIdx,
    double epsilon,
    double tMin,
    double tRange,
    double vMin,
    double vRange,
    std::vector<bool>& keepFlags) {
    if (lastIdx <= firstIdx + 1)
        return;

    const double x1 = (points[firstIdx].timeBeats - tMin) / tRange;
    const double y1 = (points[firstIdx].value - vMin) / vRange;
    const double x2 = (points[lastIdx].timeBeats - tMin) / tRange;
    const double y2 = (points[lastIdx].value - vMin) / vRange;

    const double dx = x2 - x1;
    const double dy = y2 - y1;
    const double segLenSq = dx * dx + dy * dy;

    double maxDist = 0.0;
    size_t maxIdx = firstIdx;

    for (size_t i = firstIdx + 1; i < lastIdx; ++i) {
        const double x0 = (points[i].timeBeats - tMin) / tRange;
        const double y0 = (points[i].value - vMin) / vRange;

        double dist = 0.0;
        if (segLenSq < 1.0e-12) {
            const double ddx = x0 - x1;
            const double ddy = y0 - y1;
            dist = std::sqrt(ddx * ddx + ddy * ddy);
        } else {
            dist = std::abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / std::sqrt(segLenSq);
        }

        if (dist > maxDist) {
            maxDist = dist;
            maxIdx = i;
        }
    }

    if (maxDist > epsilon) {
        keepFlags[maxIdx] = true;
        rdpRecursive(points, firstIdx, maxIdx, epsilon, tMin, tRange, vMin, vRange, keepFlags);
        rdpRecursive(points, maxIdx, lastIdx, epsilon, tMin, tRange, vMin, vRange, keepFlags);
    }
}

} // namespace resostage
