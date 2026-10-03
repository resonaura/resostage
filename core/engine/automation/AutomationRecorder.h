/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "RamerDouglasPeucker.h"
#include "project/ProjectSchema.h"

#include <cstddef>
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
    static constexpr size_t kMaximumLanePoints = 65'536;
    static constexpr size_t kMaximumBoundaryPreservationPoints = 4'096;
    static constexpr double kBoundaryPreservationTolerance = 1.0e-4;

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
     * Replaces one lane interval while preserving its outside envelope. Curved
     * post-punch boundary segments are adaptively linearized to the declared
     * tolerance and bounded point budget. Failure leaves the lane unchanged.
     */
    static bool punchPointsIntoLane(
        AutomationLane& lane,
        const std::vector<AutomationPoint>& punchedPoints,
        double rangeStartBeats,
        double rangeEndBeats,
        size_t maximumLanePoints = kMaximumLanePoints);
};

} // namespace resostage
