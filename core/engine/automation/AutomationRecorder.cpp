/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "AutomationRecorder.h"

#include "AutomationCurve.h"
#include "AutomationEvaluator.h"

#include <algorithm>
#include <cmath>

namespace resostage {
namespace {

constexpr double kPointTimeEpsilon = 1.0e-9;

bool appendPreservedCurveTail(
    const AutomationPoint& sourceStart,
    const AutomationPoint& sourceEnd,
    double boundaryBeat,
    std::vector<AutomationPoint>& output) {
    const double sourceSpan = sourceEnd.timeBeats - sourceStart.timeBeats;
    if (!(sourceSpan > 0.0) || boundaryBeat <= sourceStart.timeBeats
        || boundaryBeat >= sourceEnd.timeBeats)
        return true;

    const double curve = std::clamp(
        std::isfinite(sourceStart.curve) ? static_cast<double>(sourceStart.curve) : 0.0,
        -1.0, 1.0);
    const double exponent = std::pow(2.0, -curve * 2.0);
    const double startX = std::clamp(
        (boundaryBeat - sourceStart.timeBeats) / sourceSpan, 0.0, 1.0);
    if (startX <= 0.0 || startX >= 1.0 || std::abs(exponent - 1.0) < 1.0e-12
        || std::abs(sourceEnd.value - sourceStart.value) < 1.0e-12)
        return true;

    const double valueDelta = static_cast<double>(sourceEnd.value) - sourceStart.value;
    const double tolerance = AutomationRecorder::kBoundaryPreservationTolerance;
    const auto valueAt = [&](double x) {
        return AutomationCurve::interpolate(
            x, sourceStart.value, sourceEnd.value, curve);
    };

    size_t generatedPoints = 0;
    const auto subdivide = [&](const auto& self, double x0, double x1,
                               unsigned depth) -> bool {
        const double dx = x1 - x0;
        const double curvatureX = exponent >= 2.0 ? x1 : x0;
        const double secondDerivative = std::abs(valueDelta * exponent
            * (exponent - 1.0) * std::pow(curvatureX, exponent - 2.0));
        const double errorBound = secondDerivative * dx * dx / 8.0;
        if (std::isfinite(errorBound) && errorBound <= tolerance) {
            if (x1 < 1.0 - 1.0e-14) {
                if (++generatedPoints > AutomationRecorder::kMaximumBoundaryPreservationPoints)
                    return false;
                output.push_back({sourceStart.timeBeats + x1 * sourceSpan,
                                  static_cast<float>(valueAt(x1)), 0.0f});
            }
            return true;
        }
        if (depth >= 24)
            return false;
        const double midpoint = x0 + dx * 0.5;
        return self(self, x0, midpoint, depth + 1)
            && self(self, midpoint, x1, depth + 1);
    };

    return subdivide(subdivide, startX, 1.0, 0);
}

} // namespace

void AutomationRecorder::beginTouch(
    TouchSession& session,
    const std::string& laneId,
    AutomationWriteMode mode,
    double punchInBeats,
    float initialValue) {
    if (mode == AutomationWriteMode::Read) {
        session.state = State::Idle;
        return;
    }

    if (!std::isfinite(punchInBeats)) punchInBeats = 0.0;
    if (!std::isfinite(initialValue)) initialValue = 0.0f;

    session.laneId = laneId;
    session.mode = mode;
    session.punchInBeats = punchInBeats;
    session.lastBeats = punchInBeats;
    session.lastValue = initialValue;
    session.recordedPoints.clear();
    session.recordedPoints.push_back({punchInBeats, initialValue, 0.0f});
    session.state = State::Recording;
}

void AutomationRecorder::recordValue(
    TouchSession& session,
    double timeBeats,
    float value) {
    if (session.state != State::Recording)
        return;

    if (!std::isfinite(timeBeats) || !std::isfinite(value))
        return;

    if (timeBeats >= session.lastBeats) {
        session.recordedPoints.push_back({timeBeats, value, 0.0f});
        session.lastBeats = timeBeats;
        session.lastValue = value;
    }
}

bool AutomationRecorder::endTouch(
    TouchSession& session,
    AutomationLane& lane,
    double releaseBeats,
    float releaseValue,
    double returnRampBeats,
    float underlyingValue,
    double rdpTolerance) {
    if (session.state != State::Recording)
        return false;

    if (session.mode == AutomationWriteMode::Read) {
        session.state = State::Idle;
        session.recordedPoints.clear();
        return false;
    }

    if (!std::isfinite(releaseBeats)) releaseBeats = session.lastBeats;
    if (!std::isfinite(releaseValue)) releaseValue = session.lastValue;
    if (!std::isfinite(underlyingValue)) underlyingValue = 0.0f;
    if (!std::isfinite(returnRampBeats) || returnRampBeats < 0.0) returnRampBeats = 0.0;

    if (session.mode == AutomationWriteMode::Latch) {
        session.recordedPoints.push_back({releaseBeats, releaseValue, 0.0f});
        session.lastBeats = releaseBeats;
        session.lastValue = releaseValue;
        session.state = State::HoldingLatch;
        return true;
    }

    // Touch or Write mode
    session.recordedPoints.push_back({releaseBeats, releaseValue, 0.0f});
    session.lastBeats = releaseBeats;
    session.lastValue = releaseValue;

    double rampEndBeats = releaseBeats;
    if (returnRampBeats > 0.0) {
        rampEndBeats = releaseBeats + returnRampBeats;
        session.recordedPoints.push_back({rampEndBeats, underlyingValue, 0.0f});
    }

    const auto thinned = RamerDouglasPeucker::thin(session.recordedPoints, rdpTolerance);
    if (!punchPointsIntoLane(lane, thinned, session.punchInBeats, rampEndBeats)) {
        session.state = State::Idle;
        session.recordedPoints.clear();
        return false;
    }

    session.state = State::Idle;
    session.recordedPoints.clear();
    return true;
}

bool AutomationRecorder::punchOutLatch(
    TouchSession& session,
    AutomationLane& lane,
    double stopBeats,
    double returnRampBeats,
    float underlyingValue,
    double rdpTolerance) {
    if (session.state != State::HoldingLatch && session.state != State::Recording)
        return false;

    if (!std::isfinite(stopBeats)) stopBeats = session.lastBeats;
    if (!std::isfinite(underlyingValue)) underlyingValue = 0.0f;
    if (!std::isfinite(returnRampBeats) || returnRampBeats < 0.0) returnRampBeats = 0.0;

    if (stopBeats > session.lastBeats) {
        session.recordedPoints.push_back({stopBeats, session.lastValue, 0.0f});
    }

    double rampEndBeats = stopBeats;
    if (returnRampBeats > 0.0) {
        rampEndBeats = stopBeats + returnRampBeats;
        session.recordedPoints.push_back({rampEndBeats, underlyingValue, 0.0f});
    }

    const auto thinned = RamerDouglasPeucker::thin(session.recordedPoints, rdpTolerance);
    if (!punchPointsIntoLane(lane, thinned, session.punchInBeats, rampEndBeats)) {
        session.state = State::Idle;
        session.recordedPoints.clear();
        return false;
    }

    session.state = State::Idle;
    session.recordedPoints.clear();
    return true;
}

bool AutomationRecorder::punchPointsIntoLane(
    AutomationLane& lane,
    const std::vector<AutomationPoint>& punchedPoints,
    double rangeStartBeats,
    double rangeEndBeats,
    size_t maximumLanePoints) {
    if (punchedPoints.empty())
        return true;

    if (!std::isfinite(rangeStartBeats)) rangeStartBeats = 0.0;
    if (!std::isfinite(rangeEndBeats)) rangeEndBeats = rangeStartBeats;

    const double minBeats = std::min(rangeStartBeats, rangeEndBeats);
    const double maxBeats = std::max(rangeStartBeats, rangeEndBeats);

    std::vector<AutomationPoint> original = lane.points;
    if (std::any_of(original.begin(), original.end(), [](const AutomationPoint& point) {
            return !std::isfinite(point.timeBeats) || !std::isfinite(point.value)
                || !std::isfinite(point.curve);
        }))
        return false;
    std::stable_sort(original.begin(), original.end(),
        [](const AutomationPoint& a, const AutomationPoint& b) {
            return a.timeBeats < b.timeBeats;
        });

    std::vector<AutomationPoint> incoming = punchedPoints;
    std::stable_sort(incoming.begin(), incoming.end(),
        [](const AutomationPoint& a, const AutomationPoint& b) {
            return a.timeBeats < b.timeBeats;
        });
    if (std::any_of(incoming.begin(), incoming.end(), [&](const AutomationPoint& point) {
            return !std::isfinite(point.timeBeats) || !std::isfinite(point.value)
                || !std::isfinite(point.curve)
                || point.timeBeats < minBeats - kPointTimeEpsilon
                || point.timeBeats > maxBeats + kPointTimeEpsilon;
        }))
        return false;

    const bool hasOriginal = !original.empty();
    const float startBoundaryValue = hasOriginal
        ? AutomationEvaluator::evaluatePoints(original, minBeats, 0.0f) : 0.0f;
    const float endBoundaryValue = hasOriginal
        ? AutomationEvaluator::evaluatePoints(original, maxBeats, 0.0f) : 0.0f;
    const auto exactPointAt = [](const std::vector<AutomationPoint>& points, double beat)
        -> const AutomationPoint* {
        const auto it = std::lower_bound(points.begin(), points.end(), beat,
            [](const AutomationPoint& point, double value) {
                return point.timeBeats < value;
            });
        return it != points.end() && std::abs(it->timeBeats - beat) <= 1.0e-12
            ? &*it : nullptr;
    };

    if (std::abs(incoming.front().timeBeats - minBeats) <= kPointTimeEpsilon) {
        incoming.front().timeBeats = minBeats;
    }
    if (std::abs(incoming.back().timeBeats - maxBeats) <= kPointTimeEpsilon) {
        incoming.back().timeBeats = maxBeats;
    }
    if (hasOriginal && std::abs(incoming.front().timeBeats - minBeats) <= kPointTimeEpsilon)
        incoming.front().value = startBoundaryValue;
    if (hasOriginal && std::abs(incoming.back().timeBeats - maxBeats) <= kPointTimeEpsilon) {
        incoming.back().value = endBoundaryValue;
        if (const auto* exactEnd = exactPointAt(original, maxBeats))
            incoming.back().curve = exactEnd->curve;
        else
            incoming.back().curve = 0.0f;
    }

    std::vector<AutomationPoint> tailSamples;
    const AutomationPoint* exactEnd = hasOriginal ? exactPointAt(original, maxBeats) : nullptr;
    if (hasOriginal && exactEnd == nullptr) {
        const auto next = std::upper_bound(original.begin(), original.end(), maxBeats,
            [](double beat, const AutomationPoint& point) {
                return beat < point.timeBeats;
            });
        if (next != original.end() && next != original.begin()) {
            const auto previous = next - 1;
            if (!appendPreservedCurveTail(*previous, *next, maxBeats, tailSamples))
                return false;
        }
    }

    // Reconstruct the untouched left boundary from its original evaluated
    // value. Keeping the source point's outgoing curve preserves the complete
    // pre-punch segment; the recording's first point starts at that value.
    std::vector<AutomationPoint> updated;
    updated.reserve(original.size() + incoming.size() + tailSamples.size() + 2);

    for (const auto& pt : original) {
        if (pt.timeBeats < minBeats) {
            updated.push_back(pt);
        }
    }
    if (hasOriginal && (incoming.empty()
        || std::abs(incoming.front().timeBeats - minBeats) > kPointTimeEpsilon))
        updated.push_back({minBeats, startBoundaryValue, 0.0f});

    updated.insert(updated.end(), incoming.begin(), incoming.end());

    if (hasOriginal && (incoming.empty()
        || std::abs(incoming.back().timeBeats - maxBeats) > kPointTimeEpsilon)) {
        updated.push_back({maxBeats, endBoundaryValue,
                           exactEnd != nullptr ? exactEnd->curve : 0.0f});
    }
    updated.insert(updated.end(), tailSamples.begin(), tailSamples.end());
    for (const auto& pt : original) {
        if (pt.timeBeats > maxBeats)
            updated.push_back(pt);
    }

    std::stable_sort(updated.begin(), updated.end(),
        [](const AutomationPoint& a, const AutomationPoint& b) {
            return a.timeBeats < b.timeBeats;
        });

    // Deduplicate identical timestamps (later / punched wins)
    std::vector<AutomationPoint> deduplicated;
    deduplicated.reserve(updated.size());
    for (const auto& pt : updated) {
        if (!deduplicated.empty() && std::abs(deduplicated.back().timeBeats - pt.timeBeats) < kPointTimeEpsilon) {
            deduplicated.back() = pt;
        } else {
            deduplicated.push_back(pt);
        }
    }

    if (deduplicated.size() > maximumLanePoints)
        return false;

    lane.points = std::move(deduplicated);
    return true;
}

} // namespace resostage
