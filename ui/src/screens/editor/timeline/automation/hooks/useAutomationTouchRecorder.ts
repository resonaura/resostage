/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef } from "react";
import { builder } from "@/lib/state/api";
import type { AutomationLaneRow } from "@/lib/state/types";
import {
  AutomationTouchController,
  type AutomationGestureCommitPayload,
  type AutomationGestureTarget,
} from "../logic/automationTouchController";

export interface UseAutomationTouchRecorderProps {
  songIndex: number;
  lanes: AutomationLaneRow[];
  isPlaying: boolean;
  getCurrentBeats: () => number;
  cycleRange?: { leftBeats: number; rightBeats: number } | null;
  onCommitGesture?: (payload: AutomationGestureCommitPayload) => void;
  onWriteModeRevert?: (laneId: string) => void;
}

export function useAutomationTouchRecorder({
  songIndex,
  lanes,
  isPlaying,
  getCurrentBeats,
  cycleRange,
  onCommitGesture,
  onWriteModeRevert,
}: UseAutomationTouchRecorderProps) {
  const controllerRef = useRef<AutomationTouchController>(new AutomationTouchController());
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const getCurrentBeatsRef = useRef(getCurrentBeats);
  getCurrentBeatsRef.current = getCurrentBeats;
  const lastBeatsRef = useRef(0);

  const commitPayload = useCallback(
    (payload: AutomationGestureCommitPayload) => {
      if (onCommitGesture) {
        onCommitGesture(payload);
      } else {
        void builder.automationRecordGesture({
          songIndex,
          laneId: payload.laneId,
          punchInBeats: payload.punchInBeats,
          releaseBeats: payload.releaseBeats,
          releaseValue: payload.releaseValue,
          returnRampBeats: payload.returnRampBeats,
          underlyingValue: payload.underlyingValue,
          rdpTolerance: 0.002,
          points: payload.points,
          gestureId: payload.gestureId,
        });
      }

      if (payload.shouldRevertWriteMode && onWriteModeRevert) {
        onWriteModeRevert(payload.laneId);
      }
    },
    [songIndex, onCommitGesture, onWriteModeRevert],
  );

  const startGesture = useCallback(
    (target: AutomationGestureTarget, initialValue: number) => {
      if (!isPlayingRef.current) return;
      const currentBeats = getCurrentBeatsRef.current();
      controllerRef.current.startGesture(
        target,
        initialValue,
        currentBeats,
        lanesRef.current,
      );
    },
    [],
  );

  const recordValue = useCallback(
    (target: AutomationGestureTarget, value: number) => {
      if (!isPlayingRef.current) return;
      const currentBeats = getCurrentBeatsRef.current();
      controllerRef.current.recordValue(target, value, currentBeats);
    },
    [],
  );

  const finishGesture = useCallback(
    (target: AutomationGestureTarget, releaseValue?: number, returnRampBeats = 1.0) => {
      const currentBeats = getCurrentBeatsRef.current();
      const payload = controllerRef.current.finishGesture(
        target,
        releaseValue ?? 0,
        currentBeats,
        returnRampBeats,
      );
      if (payload) {
        commitPayload(payload);
      }
    },
    [commitPayload],
  );

  const punchOut = useCallback(
    (laneId: string, returnRampBeats = 0.5) => {
      const currentBeats = getCurrentBeatsRef.current();
      const payload = controllerRef.current.punchOut(laneId, currentBeats, returnRampBeats);
      if (payload) {
        commitPayload(payload);
      }
    },
    [commitPayload],
  );

  // Transport stop: punch out and commit all active/held sessions
  useEffect(() => {
    if (!isPlaying) {
      const currentBeats = getCurrentBeatsRef.current();
      const payloads = controllerRef.current.stopAll(currentBeats);
      for (const p of payloads) {
        commitPayload(p);
      }
    }
  }, [isPlaying, commitPayload]);

  // Loop cycle wrap: split and continue held/active sessions across boundaries
  useEffect(() => {
    if (!isPlaying || !cycleRange) return;
    const current = getCurrentBeatsRef.current();
    if (
      lastBeatsRef.current > cycleRange.leftBeats &&
      current < lastBeatsRef.current &&
      lastBeatsRef.current >= cycleRange.rightBeats - 0.5
    ) {
      const payloads = controllerRef.current.handleCycleWrap(
        cycleRange.leftBeats,
        cycleRange.rightBeats,
      );
      for (const p of payloads) {
        commitPayload(p);
      }
    }
    lastBeatsRef.current = current;
  }, [isPlaying, cycleRange, commitPayload]);

  // Project/song change: cancel all gestures without sending stale commits
  useEffect(() => {
    const controller = controllerRef.current;
    return () => {
      controller.cancelAll();
    };
  }, [songIndex]);

  return {
    startGesture,
    recordValue,
    finishGesture,
    punchOut,
    isLaneActive: (laneId: string) => controllerRef.current.isLaneActive(laneId),
    hasHoldingLatch: () => controllerRef.current.hasHoldingLatch(),
  };
}
