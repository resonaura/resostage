/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { AutomationLaneRow, AutomationWriteMode } from "@/lib/state/types";
import {
  finishTouchSession,
  punchOutLatchSession,
  recordTouchValue,
  startTouchSession,
  type TouchRecordSession,
} from "./automationTouchSession";
import { evaluateAutomationAt } from "./automationBoundary";

export interface AutomationGestureTarget {
  domain: "strip" | "plugin" | "midi" | "light";
  entityId: string;
  parameterId: string;
}

export interface AutomationGestureCommitPayload {
  laneId: string;
  writeMode: AutomationWriteMode;
  punchInBeats: number;
  releaseBeats: number;
  releaseValue: number;
  returnRampBeats: number;
  underlyingValue: number;
  points: Array<{ timeBeats: number; value: number }>;
  gestureId: string;
  shouldRevertWriteMode: boolean;
}

/** Matches target identity across canonical and legacy aliases. */
export function matchesGestureTarget(
  lane: AutomationLaneRow,
  target: AutomationGestureTarget,
): boolean {
  if (lane.target.domain !== target.domain) return false;

  const targetEntity = target.entityId;
  const laneEntity = lane.target.entityId;
  const entityMatches =
    laneEntity === targetEntity ||
    (target.domain === "strip" &&
      (laneEntity.endsWith(`:${targetEntity}`) || targetEntity.endsWith(`:${laneEntity}`)));

  if (!entityMatches) return false;

  const targetParam = target.parameterId;
  const laneParam = lane.target.parameterId;
  if (laneParam === targetParam) return true;

  // Canonical vs legacy aliases
  if (
    (targetParam === "faderGainDb" && laneParam === "gain") ||
    (targetParam === "gain" && laneParam === "faderGainDb")
  ) {
    return true;
  }

  return false;
}

/** Finds the active and automated lane for a target if enabled and non-read. */
export function findRecordableLane(
  lanes: AutomationLaneRow[],
  target: AutomationGestureTarget,
): AutomationLaneRow | undefined {
  return lanes.find(
    (l) =>
      l.enabled &&
      !l.muted &&
      l.writeMode !== "read" &&
      matchesGestureTarget(l, target),
  );
}

/**
 * Manages live Touch, Latch, and Write automation recording gestures.
 * Handles continuous point streaming, return ramp calculation, Latch hold,
 * transport stop punch-out, and cycle wrap transitions.
 */
export class AutomationTouchController {
  private activeSessions = new Map<string, { session: TouchRecordSession; lane: AutomationLaneRow }>();

  /** Returns true if a gesture is actively recording or holding for this lane. */
  public isLaneActive(laneId: string): boolean {
    return this.activeSessions.has(laneId);
  }

  /** Returns true if any lane is currently holding in Latch mode. */
  public hasHoldingLatch(): boolean {
    for (const { session } of this.activeSessions.values()) {
      if (session.state === "holding_latch") return true;
    }
    return false;
  }

  /**
   * Starts a live automation recording gesture when transport is playing.
   * If writeMode is 'read', no session is created and null is returned.
   */
  public startGesture(
    target: AutomationGestureTarget,
    initialValue: number,
    currentBeats: number,
    lanes: AutomationLaneRow[],
  ): TouchRecordSession | null {
    const lane = findRecordableLane(lanes, target);
    if (!lane) return null;

    const safeBeats = Math.max(0, Number.isFinite(currentBeats) ? currentBeats : 0);
    const session = startTouchSession(lane.id, lane.writeMode, safeBeats, initialValue);
    if (session.state === "idle") return null;

    this.activeSessions.set(lane.id, { session, lane });
    return session;
  }

  /**
   * Streams a new value into an active gesture.
   */
  public recordValue(
    target: AutomationGestureTarget,
    value: number,
    currentBeats: number,
  ): void {
    for (const { session, lane } of this.activeSessions.values()) {
      if (matchesGestureTarget(lane, target) && session.state === "recording") {
        recordTouchValue(session, currentBeats, value);
      }
    }
  }

  /**
   * Finishes a touch or write gesture on pointer release.
   * In Touch mode, returns a commit payload with calculated return ramp.
   * In Latch mode, transitions to 'holding_latch' until punch-out or stop.
   * In Write mode, returns a commit payload and signals write-mode safety revert.
   */
  public finishGesture(
    target: AutomationGestureTarget,
    releaseValue: number,
    currentBeats: number,
    returnRampBeats = 1.0,
  ): AutomationGestureCommitPayload | null {
    let commitPayload: AutomationGestureCommitPayload | null = null;

    for (const [laneId, entry] of this.activeSessions.entries()) {
      const { session, lane } = entry;
      if (!matchesGestureTarget(lane, target)) continue;

      if (session.state !== "recording") continue;

      const safeRelease = Number.isFinite(releaseValue) ? releaseValue : session.lastValue;
      const safeBeats = Math.max(session.lastBeats, currentBeats);
      const rampEndBeats = safeBeats + (session.writeMode === "touch" ? returnRampBeats : 0);
      const underlyingVal = evaluateAutomationAt(
        lane.points,
        rampEndBeats,
        lane.target.defaultValue ?? 0,
      );

      const result = finishTouchSession(
        session,
        safeBeats,
        safeRelease,
        underlyingVal,
        returnRampBeats,
      );

      if (!result) {
        this.activeSessions.delete(laneId);
        continue;
      }

      if (session.writeMode === "latch") {
        // Stays in activeSessions as holding_latch; commit occurs at punch-out or stop
        continue;
      }

      this.activeSessions.delete(laneId);
      commitPayload = {
        laneId: lane.id,
        writeMode: session.writeMode,
        punchInBeats: result.punchInBeats,
        releaseBeats: result.releaseBeats,
        releaseValue: result.releaseValue,
        returnRampBeats: result.returnRampBeats,
        underlyingValue: result.underlyingValue,
        points: result.points,
        gestureId: crypto.randomUUID(),
        shouldRevertWriteMode: session.writeMode === "write",
      };
      break;
    }

    return commitPayload;
  }

  /**
   * Punches out a specific lane currently in Latch mode (or recording).
   */
  public punchOut(
    laneId: string,
    currentBeats: number,
    returnRampBeats = 0.5,
  ): AutomationGestureCommitPayload | null {
    const entry = this.activeSessions.get(laneId);
    if (!entry) return null;

    const { session, lane } = entry;
    const safeBeats = Math.max(session.lastBeats, currentBeats);
    const rampEndBeats = safeBeats + returnRampBeats;
    const underlyingVal = evaluateAutomationAt(
      lane.points,
      rampEndBeats,
      lane.target.defaultValue ?? 0,
    );

    const result = punchOutLatchSession(
      session,
      safeBeats,
      underlyingVal,
      returnRampBeats,
    );

    this.activeSessions.delete(laneId);
    if (!result) return null;

    return {
      laneId: lane.id,
      writeMode: session.writeMode,
      punchInBeats: result.punchInBeats,
      releaseBeats: result.releaseBeats,
      releaseValue: result.releaseValue,
      returnRampBeats: result.returnRampBeats,
      underlyingValue: result.underlyingValue,
      points: result.points,
      gestureId: crypto.randomUUID(),
      shouldRevertWriteMode: session.writeMode === "write",
    };
  }

  /**
   * Terminates and commits all active recording and latch sessions upon transport stop.
   */
  public stopAll(currentBeats: number): AutomationGestureCommitPayload[] {
    const payloads: AutomationGestureCommitPayload[] = [];
    const laneIds = Array.from(this.activeSessions.keys());

    for (const laneId of laneIds) {
      const payload = this.punchOut(laneId, currentBeats, 0.5);
      if (payload) {
        payloads.push(payload);
      }
    }

    this.activeSessions.clear();
    return payloads;
  }

  /**
   * Handles loop cycle wrap: punches out the active pass at cycle right,
   * commits the points, and re-initializes continuous recording at cycle left.
   */
  public handleCycleWrap(
    cycleLeftBeats: number,
    cycleRightBeats: number,
  ): AutomationGestureCommitPayload[] {
    const payloads: AutomationGestureCommitPayload[] = [];

    for (const [laneId, entry] of this.activeSessions.entries()) {
      const { session, lane } = entry;
      const wasHoldingLatch = session.state === "holding_latch";
      const wasRecording = session.state === "recording";
      const lastVal = session.lastValue;
      const writeMode = session.writeMode;

      // Punch out at cycleRightBeats
      const underlyingVal = evaluateAutomationAt(
        lane.points,
        cycleRightBeats,
        lane.target.defaultValue ?? 0,
      );
      const result = punchOutLatchSession(session, cycleRightBeats, underlyingVal, 0);

      if (result) {
        payloads.push({
          laneId: lane.id,
          writeMode,
          punchInBeats: result.punchInBeats,
          releaseBeats: result.releaseBeats,
          releaseValue: result.releaseValue,
          returnRampBeats: 0,
          underlyingValue: result.underlyingValue,
          points: result.points,
          gestureId: crypto.randomUUID(),
          shouldRevertWriteMode: false, // Don't revert write mode mid-cycle
        });
      }

      // Re-arm session starting at cycleLeftBeats
      const nextSession = startTouchSession(lane.id, writeMode, cycleLeftBeats, lastVal);
      if (wasHoldingLatch) {
        nextSession.state = "holding_latch";
      } else if (wasRecording) {
        nextSession.state = "recording";
      }
      this.activeSessions.set(laneId, { session: nextSession, lane });
    }

    return payloads;
  }

  /** Cancels all sessions immediately without generating commit payloads (e.g. Esc or project switch). */
  public cancelAll(): void {
    this.activeSessions.clear();
  }
}
