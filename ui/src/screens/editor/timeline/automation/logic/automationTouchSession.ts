/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { AutomationWriteMode } from "@/lib/state/types";

export type TouchSessionState = "idle" | "recording" | "holding_latch";

export interface TouchRecordSession {
  laneId: string;
  writeMode: AutomationWriteMode;
  punchInBeats: number;
  lastBeats: number;
  lastValue: number;
  recordedPoints: Array<{ timeBeats: number; value: number }>;
  state: TouchSessionState;
}

/**
 * Initializes a new live touch recording session.
 * In 'read' mode, session remains idle and does not record points.
 */
export function startTouchSession(
  laneId: string,
  writeMode: AutomationWriteMode,
  punchInBeats: number,
  initialValue: number,
): TouchRecordSession {
  const safeTime = Number.isFinite(punchInBeats) ? Math.max(0, punchInBeats) : 0;
  const safeVal = Number.isFinite(initialValue) ? initialValue : 0;

  if (writeMode === "read") {
    return {
      laneId,
      writeMode,
      punchInBeats: safeTime,
      lastBeats: safeTime,
      lastValue: safeVal,
      recordedPoints: [],
      state: "idle",
    };
  }

  return {
    laneId,
    writeMode,
    punchInBeats: safeTime,
    lastBeats: safeTime,
    lastValue: safeVal,
    recordedPoints: [{ timeBeats: safeTime, value: safeVal }],
    state: "recording",
  };
}

/**
 * Streams incoming parameter values during fader/control movement.
 */
export function recordTouchValue(
  session: TouchRecordSession,
  timeBeats: number,
  value: number,
): void {
  if (session.state !== "recording") return;
  if (!Number.isFinite(timeBeats) || !Number.isFinite(value)) return;

  if (timeBeats >= session.lastBeats) {
    session.recordedPoints.push({ timeBeats, value });
    session.lastBeats = timeBeats;
    session.lastValue = value;
  }
}

/**
 * Completes the touch gesture and calculates return-ramp parameters.
 * Returns null if the session was in 'read' mode or not recording.
 */
export function finishTouchSession(
  session: TouchRecordSession,
  releaseBeats: number,
  releaseValue: number,
  underlyingValue: number,
  returnRampBeats = 1.0,
): {
  punchInBeats: number;
  releaseBeats: number;
  releaseValue: number;
  returnRampBeats: number;
  underlyingValue: number;
  points: Array<{ timeBeats: number; value: number }>;
} | null {
  if (session.state !== "recording" || session.writeMode === "read") {
    return null;
  }

  const safeReleaseBeats = Math.max(
    session.lastBeats,
    Number.isFinite(releaseBeats) ? releaseBeats : session.lastBeats,
  );
  const safeReleaseVal = Number.isFinite(releaseValue)
    ? releaseValue
    : session.lastValue;
  const safeUnderlying = Number.isFinite(underlyingValue) ? underlyingValue : 0;
  const safeRamp =
    session.writeMode === "touch"
      ? Math.max(0, Number.isFinite(returnRampBeats) ? returnRampBeats : 1.0)
      : 0;

  session.recordedPoints.push({
    timeBeats: safeReleaseBeats,
    value: safeReleaseVal,
  });

  if (session.writeMode === "latch") {
    session.state = "holding_latch";
  } else {
    session.state = "idle";
  }

  return {
    punchInBeats: session.punchInBeats,
    releaseBeats: safeReleaseBeats,
    releaseValue: safeReleaseVal,
    returnRampBeats: safeRamp,
    underlyingValue: safeUnderlying,
    points: session.recordedPoints,
  };
}

/**
 * Terminates an active or held Latch session and prepares points for commit.
 * In Latch mode, points are held at the last touched value until punch-out or stop.
 */
export function punchOutLatchSession(
  session: TouchRecordSession,
  stopBeats: number,
  underlyingValue: number,
  returnRampBeats = 0.5,
): {
  punchInBeats: number;
  releaseBeats: number;
  releaseValue: number;
  returnRampBeats: number;
  underlyingValue: number;
  points: Array<{ timeBeats: number; value: number }>;
} | null {
  if (session.state !== "holding_latch" && session.state !== "recording") {
    return null;
  }

  const safeStopBeats = Math.max(
    session.lastBeats,
    Number.isFinite(stopBeats) ? stopBeats : session.lastBeats,
  );
  const safeUnderlying = Number.isFinite(underlyingValue) ? underlyingValue : 0;
  const safeRamp = Math.max(0, Number.isFinite(returnRampBeats) ? returnRampBeats : 0);

  if (safeStopBeats > session.lastBeats) {
    session.recordedPoints.push({
      timeBeats: safeStopBeats,
      value: session.lastValue,
    });
    session.lastBeats = safeStopBeats;
  }

  session.state = "idle";

  return {
    punchInBeats: session.punchInBeats,
    releaseBeats: safeStopBeats,
    releaseValue: session.lastValue,
    returnRampBeats: safeRamp,
    underlyingValue: safeUnderlying,
    points: session.recordedPoints,
  };
}

/**
 * Standard DAW console safety rule:
 * In 'write' mode, once recording is finished, the lane reverts to 'touch'
 * to prevent unintentional destruction of existing automation on subsequent passes.
 */
export function revertWriteModeToSafety(mode: AutomationWriteMode): AutomationWriteMode {
  return mode === "write" ? "touch" : mode;
}

