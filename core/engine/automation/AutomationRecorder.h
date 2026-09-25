#pragma once

#include "RamerDouglasPeucker.h"
#include "project/ProjectSchema.h"

#include <string>
#include <vector>

namespace resostage {

/**
 * Manages automation write gestures and console modes (Read, Touch, Latch, Write).
 *
 * Implements punch-in/punch-out return ramps, Latch hold states, RDP curve thinning,
 * and surgical merging of recorded breakpoint streams into existing AutomationLanes.
 */
class AutomationRecorder {
public:
    enum class State : uint8_t {
        Idle = 0,
        Recording = 1,
        HoldingLatch = 2
    };

    struct TouchSession {
        std::string laneId;
        AutomationWriteMode mode = AutomationWriteMode::Touch;
        double punchInBeats = 0.0;
        double lastBeats = 0.0;
        float lastValue = 0.0f;
        std::vector<AutomationPoint> recordedPoints;
        State state = State::Idle;
    };

    /** Starts recording a touch gesture at punchInBeats. */
    static void beginTouch(
        TouchSession& session,
        const std::string& laneId,
        AutomationWriteMode mode,
        double punchInBeats,
        float initialValue);

    /** Adds a continuous streaming fader point to the active session. */
    static void recordValue(
        TouchSession& session,
        double timeBeats,
        float value);

    /**
     * Completes a touch gesture.
     * In Touch mode, generates a return ramp and commits thinned points to the lane.
     * In Latch mode, enters HoldingLatch state until punchOutLatch() or transport stop.
     */
    static bool endTouch(
        TouchSession& session,
        AutomationLane& lane,
        double releaseBeats,
        float releaseValue,
        double returnRampBeats,
        float underlyingValue,
        double rdpTolerance = 0.002);

    /** Terminates a held Latch session and commits points to the lane. */
    static bool punchOutLatch(
        TouchSession& session,
        AutomationLane& lane,
        double stopBeats,
        double returnRampBeats,
        float underlyingValue,
        double rdpTolerance = 0.002);

    /**
     * Surgically punches a new series of points into an existing lane, replacing
     * all points in [rangeStartBeats, rangeEndBeats] and keeping the lane strictly sorted.
     */
    static void punchPointsIntoLane(
        AutomationLane& lane,
        const std::vector<AutomationPoint>& punchedPoints,
        double rangeStartBeats,
        double rangeEndBeats);
};

} // namespace resostage
