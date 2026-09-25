#include "AutomationRecorder.h"

#include <algorithm>
#include <cmath>

namespace resostage {

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
    punchPointsIntoLane(lane, thinned, session.punchInBeats, rampEndBeats);

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
    punchPointsIntoLane(lane, thinned, session.punchInBeats, rampEndBeats);

    session.state = State::Idle;
    session.recordedPoints.clear();
    return true;
}

void AutomationRecorder::punchPointsIntoLane(
    AutomationLane& lane,
    const std::vector<AutomationPoint>& punchedPoints,
    double rangeStartBeats,
    double rangeEndBeats) {
    if (punchedPoints.empty())
        return;

    if (!std::isfinite(rangeStartBeats)) rangeStartBeats = 0.0;
    if (!std::isfinite(rangeEndBeats)) rangeEndBeats = rangeStartBeats;

    const double minBeats = std::min(rangeStartBeats, rangeEndBeats);
    const double maxBeats = std::max(rangeStartBeats, rangeEndBeats);

    // Remove existing points in the replaced range
    std::vector<AutomationPoint> updated;
    updated.reserve(lane.points.size() + punchedPoints.size());

    for (const auto& pt : lane.points) {
        if (pt.timeBeats < minBeats - 1.0e-9 || pt.timeBeats > maxBeats + 1.0e-9) {
            updated.push_back(pt);
        }
    }

    // Insert punched points
    updated.insert(updated.end(), punchedPoints.begin(), punchedPoints.end());

    // Sort by timestamp
    std::sort(updated.begin(), updated.end(), [](const AutomationPoint& a, const AutomationPoint& b) {
        return a.timeBeats < b.timeBeats;
    });

    // Deduplicate identical timestamps (later / punched wins)
    std::vector<AutomationPoint> deduplicated;
    deduplicated.reserve(updated.size());
    for (const auto& pt : updated) {
        if (!deduplicated.empty() && std::abs(deduplicated.back().timeBeats - pt.timeBeats) < 1.0e-9) {
            deduplicated.back() = pt;
        } else {
            deduplicated.push_back(pt);
        }
    }

    lane.points = std::move(deduplicated);
}

} // namespace resostage
