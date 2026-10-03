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
  projectIdentity?: string | null;
  lanes: AutomationLaneRow[];
  isPlaying: boolean;
  getCurrentBeats: () => number;
  cycleRange?: { leftBeats: number; rightBeats: number } | null;
  onCommitGesture?: (payload: AutomationGestureCommitPayload) => void;
  onWriteModeRevert?: (laneId: string) => void;
}

interface ManualOverrideOwner {
  songIndex: number;
  projectIdentity: string;
}

export function useAutomationTouchRecorder({
  songIndex,
  projectIdentity = null,
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
  const projectIdentityRef = useRef<string | null>(projectIdentity);
  projectIdentityRef.current = projectIdentity;
  const sessionIdentityRef = useRef(new Map<string, string>());
  const manualOverrideOwnersRef = useRef(new Map<string, ManualOverrideOwner>());

  const setManualOverride = useCallback((laneId: string, owner: ManualOverrideOwner, active: boolean) => {
    if (owner.projectIdentity !== projectIdentityRef.current) return;
    void builder.automationManualOverride({
      songIndex: owner.songIndex,
      laneId,
      active,
    }).catch((error: unknown) => {
      console.warn("Could not update Core-owned automation gesture state", error);
    });
  }, []);

  const commitPayload = useCallback(
    (payload: AutomationGestureCommitPayload) => {
      const capturedIdentity = sessionIdentityRef.current.get(payload.laneId);
      if (!capturedIdentity || capturedIdentity !== projectIdentityRef.current) {
        controllerRef.current.cancelAll();
        sessionIdentityRef.current.clear();
        manualOverrideOwnersRef.current.clear();
        return;
      }

      let recording: Promise<void>;
      if (onCommitGesture) {
        onCommitGesture(payload);
        recording = Promise.resolve();
      } else {
        recording = builder.automationRecordGesture({
          songIndex,
          laneId: payload.laneId,
          punchInBeats: payload.punchInBeats,
          releaseBeats: payload.releaseBeats,
          releaseValue: payload.releaseValue,
          returnRampBeats: payload.returnRampBeats,
          underlyingValue: payload.underlyingValue,
          rdpTolerance: 0.002,
          points: payload.points,
          pointsCompacted: payload.pointsCompacted,
          gestureId: payload.gestureId,
        });
      }

      if (payload.shouldRevertWriteMode && onWriteModeRevert) {
        onWriteModeRevert(payload.laneId);
      }

      if (!controllerRef.current.isLaneActive(payload.laneId)) {
        sessionIdentityRef.current.delete(payload.laneId);
        const owner = manualOverrideOwnersRef.current.get(payload.laneId);
        if (owner) {
          manualOverrideOwnersRef.current.delete(payload.laneId);
          void recording.then(
            () => setManualOverride(payload.laneId, owner, false),
            () => setManualOverride(payload.laneId, owner, false),
          );
        } else {
          void recording.catch(() => {});
        }
      } else {
        void recording.catch(() => {});
      }
    },
    [songIndex, onCommitGesture, onWriteModeRevert, setManualOverride],
  );

  const startGesture = useCallback(
    (target: AutomationGestureTarget, initialValue: number) => {
      if (!isPlayingRef.current || !projectIdentityRef.current) return;
      if ([...sessionIdentityRef.current.values()].some(
        (identity) => identity !== projectIdentityRef.current,
      )) {
        controllerRef.current.cancelAll();
        sessionIdentityRef.current.clear();
      }
      const currentBeats = getCurrentBeatsRef.current();
      const session = controllerRef.current.startGesture(
        target,
        initialValue,
        currentBeats,
        lanesRef.current,
      );
      if (session) {
        const identity = projectIdentityRef.current;
        sessionIdentityRef.current.set(session.laneId, identity);
        const lane = lanesRef.current.find((candidate) => candidate.id === session.laneId);
        if (identity && lane?.target.domain === "strip" && lane.scope === "track"
          && (lane.target.parameterId === "faderGainDb" || lane.target.parameterId === "pan")
          && !manualOverrideOwnersRef.current.has(session.laneId)) {
          const owner = { songIndex, projectIdentity: identity };
          manualOverrideOwnersRef.current.set(session.laneId, owner);
          setManualOverride(session.laneId, owner, true);
        }
      }
    },
    [songIndex, setManualOverride],
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
        releaseValue,
        currentBeats,
        returnRampBeats,
      );
      if (payload) {
        commitPayload(payload);
      }
    },
    [commitPayload],
  );

  const cancelGesture = useCallback(
    (target: AutomationGestureTarget) => {
      const cancelledLaneIds = controllerRef.current.cancelGesture(target);
      for (const laneId of cancelledLaneIds) {
        sessionIdentityRef.current.delete(laneId);
        const owner = manualOverrideOwnersRef.current.get(laneId);
        if (!owner) continue;
        manualOverrideOwnersRef.current.delete(laneId);
        setManualOverride(laneId, owner, false);
      }
      return cancelledLaneIds;
    },
    [setManualOverride],
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

  // A document/session transition cancels old capture before a stopped-transport
  // effect can accidentally commit those points against the replacement project.
  useEffect(() => {
    for (const [laneId, owner] of manualOverrideOwnersRef.current) {
      if (owner.projectIdentity === projectIdentity && owner.songIndex !== songIndex)
        setManualOverride(laneId, owner, false);
    }
    manualOverrideOwnersRef.current.clear();
    controllerRef.current.cancelAll();
    sessionIdentityRef.current.clear();
    lastBeatsRef.current = getCurrentBeatsRef.current();
  }, [projectIdentity, songIndex, setManualOverride]);

  const currentBeats = getCurrentBeatsRef.current();

  // Transport stop: punch out and commit all active/held sessions
  useEffect(() => {
    if (!isPlaying) {
      const payloads = controllerRef.current.stopAll(currentBeats);
      for (const p of payloads) {
        commitPayload(p);
      }
    }
  }, [isPlaying, currentBeats, commitPayload]);

  // Loop cycle wrap: split and continue held/active sessions across boundaries
  useEffect(() => {
    const previous = lastBeatsRef.current;
    if (!isPlaying || !cycleRange) {
      lastBeatsRef.current = currentBeats;
      return;
    }
    const current = currentBeats;
    const cycleLength = cycleRange.rightBeats - cycleRange.leftBeats;
    const edgeWindow = Math.min(0.5, Math.max(0.002, cycleLength * 0.25));
    const crossedRight = previous >= cycleRange.rightBeats - edgeWindow
      && previous <= cycleRange.rightBeats + edgeWindow;
    const wrappedToLeft = current >= cycleRange.leftBeats - edgeWindow
      && current <= cycleRange.leftBeats + edgeWindow;
    if (previous > cycleRange.leftBeats && current < previous
      && crossedRight && wrappedToLeft) {
      const payloads = controllerRef.current.handleCycleWrap(
        cycleRange.leftBeats,
        cycleRange.rightBeats,
      );
      for (const p of payloads) {
        commitPayload(p);
      }
    }
    lastBeatsRef.current = current;
  }, [isPlaying, cycleRange, currentBeats, commitPayload]);

  // Component unmount: discard any incomplete gesture without stale commits.
  useEffect(() => () => {
    for (const [laneId, owner] of manualOverrideOwnersRef.current)
      setManualOverride(laneId, owner, false);
    manualOverrideOwnersRef.current.clear();
    controllerRef.current.cancelAll();
    sessionIdentityRef.current.clear();
  }, [setManualOverride]);

  return {
    startGesture,
    recordValue,
    finishGesture,
    cancelGesture,
    punchOut,
    isLaneActive: (laneId: string) => controllerRef.current.isLaneActive(laneId),
    hasHoldingLatch: () => controllerRef.current.hasHoldingLatch(),
  };
}
