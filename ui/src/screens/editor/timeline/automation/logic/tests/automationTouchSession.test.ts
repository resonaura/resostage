/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  finishTouchSession,
  MAX_AUTOMATION_GESTURE_POINTS,
  punchOutLatchSession,
  recordTouchValue,
  revertWriteModeToSafety,
  startTouchSession,
} from "../automationTouchSession";

describe("automationTouchSession", () => {
  it("ignores recording when in 'read' mode", () => {
    const session = startTouchSession("lane-1", "read", 0, 0);
    expect(session.state).toBe("idle");
    recordTouchValue(session, 1, 0.5);
    const result = finishTouchSession(session, 2, 0.5, 0);
    expect(result).toBeNull();
  });

  it("records fader values and generates return ramp in 'touch' mode", () => {
    const session = startTouchSession("lane-1", "touch", 4.0, 0.0);
    expect(session.state).toBe("recording");

    recordTouchValue(session, 5.0, -3.0);
    recordTouchValue(session, 6.0, -6.0);

    const result = finishTouchSession(session, 6.5, -6.0, 0.0, 1.0);
    expect(result).not.toBeNull();
    expect(result?.punchInBeats).toBe(4.0);
    expect(result?.releaseBeats).toBe(6.5);
    expect(result?.releaseValue).toBe(-6.0);
    expect(result?.returnRampBeats).toBe(1.0);
    expect(result?.underlyingValue).toBe(0.0);
    expect(result?.points.length).toBeGreaterThanOrEqual(3);
    expect(session.state).toBe("idle");
  });

  it("coalesces samples at the same beat and bounds long capture buffers", () => {
    const sameBeat = startTouchSession("lane-1", "touch", 0, 0);
    recordTouchValue(sameBeat, 1, 0.2);
    recordTouchValue(sameBeat, 1, 0.8);
    expect(sameBeat.recordedPoints).toHaveLength(2);
    expect(sameBeat.recordedPoints[1]).toEqual({ timeBeats: 1, value: 0.8 });

    const longGesture = startTouchSession("lane-2", "touch", 0, 0);
    for (let beat = 1; beat <= MAX_AUTOMATION_GESTURE_POINTS + 20; beat += 1) {
      recordTouchValue(longGesture, beat, beat / MAX_AUTOMATION_GESTURE_POINTS);
    }
    expect(longGesture.recordedPoints.length).toBeLessThanOrEqual(MAX_AUTOMATION_GESTURE_POINTS);
    expect(longGesture.pointsCompacted).toBe(true);
    expect(longGesture.recordedPoints[0]).toEqual({ timeBeats: 0, value: 0 });
    expect(longGesture.recordedPoints.at(-1)).toEqual({
      timeBeats: MAX_AUTOMATION_GESTURE_POINTS + 20,
      value: (MAX_AUTOMATION_GESTURE_POINTS + 20) / MAX_AUTOMATION_GESTURE_POINTS,
    });

    const result = finishTouchSession(longGesture, NaN, NaN, 0);
    expect(result?.pointsCompacted).toBe(true);
    expect(result?.points.length).toBeLessThanOrEqual(MAX_AUTOMATION_GESTURE_POINTS);
  });

  it("enters holding_latch state without return ramp in 'latch' mode", () => {
    const session = startTouchSession("lane-1", "latch", 2.0, 0.5);
    recordTouchValue(session, 3.0, 0.8);
    const result = finishTouchSession(session, 4.0, 0.8, 0.2, 1.0);

    expect(result).not.toBeNull();
    expect(result?.returnRampBeats).toBe(0);
    expect(session.state).toBe("holding_latch");
  });

  it("punches out a held latch session with return ramp and releases to idle", () => {
    const session = startTouchSession("lane-1", "latch", 2.0, 0.5);
    recordTouchValue(session, 3.0, 0.8);
    finishTouchSession(session, 4.0, 0.8, 0.0, 1.0);
    expect(session.state).toBe("holding_latch");

    const punchOut = punchOutLatchSession(session, 6.0, 0.0, 0.5);
    expect(punchOut).not.toBeNull();
    expect(punchOut?.punchInBeats).toBe(2.0);
    expect(punchOut?.releaseBeats).toBe(6.0);
    expect(punchOut?.releaseValue).toBe(0.8);
    expect(punchOut?.returnRampBeats).toBe(0.5);
    expect(punchOut?.underlyingValue).toBe(0.0);
    expect(session.state).toBe("idle");

    // Once idle, subsequent punch out returns null
    expect(punchOutLatchSession(session, 7.0, 0.0)).toBeNull();
  });

  it("reverts write mode to touch safety while leaving other modes untouched", () => {
    expect(revertWriteModeToSafety("write")).toBe("touch");
    expect(revertWriteModeToSafety("touch")).toBe("touch");
    expect(revertWriteModeToSafety("latch")).toBe("latch");
    expect(revertWriteModeToSafety("read")).toBe("read");
  });
});
