/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { builder, EditorMutationError } from "@/lib/state/api";
import type { AutomationLaneRow } from "@/lib/state/types";
import {
  AutomationTouchController,
  findRecordableLane,
  type AutomationGestureCommitPayload,
  type AutomationGestureTarget,
} from "../logic/automationTouchController";
import {
  automationGestureRecoveryLimits,
  clearAutomationGestureDraftStorage,
  loadAutomationGestureDrafts,
  persistAutomationGestureDrafts,
  removeAutomationGestureDraft,
  type AutomationGestureRecoveryDraft,
} from "../logic/automationGestureRecovery";

export interface UseAutomationTouchRecorderProps {
  songIndex: number;
  projectIdentity?: string | null;
  lanes: AutomationLaneRow[];
  isPlaying: boolean;
  getCurrentBeats: () => number;
  cycleRange?: { leftBeats: number; rightBeats: number } | null;
  cyclePassSequence?: number;
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
  cyclePassSequence,
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
  const lastCyclePassSequenceRef = useRef<number | null>(null);
  const cycleContextRef = useRef<string | null>(null);
  const projectIdentityRef = useRef<string | null>(projectIdentity);
  projectIdentityRef.current = projectIdentity;
  const sessionIdentityRef = useRef(new Map<string, string>());
  const manualOverrideOwnersRef = useRef(new Map<string, ManualOverrideOwner>());
  const [recoveryDrafts, setRecoveryDrafts] = useState(loadAutomationGestureDrafts);
  const recoveryDraftsRef = useRef(recoveryDrafts);
  recoveryDraftsRef.current = recoveryDrafts;

  const publishRecoveryDrafts = useCallback((next: AutomationGestureRecoveryDraft[]) => {
    const persisted = persistAutomationGestureDrafts(next);
    if (!persisted) clearAutomationGestureDraftStorage();
    const published = next.map((draft) => ({ ...draft, persisted }));
    recoveryDraftsRef.current = published;
    setRecoveryDrafts(published);
  }, []);

  const beginGestureRecovery = useCallback((
    payload: AutomationGestureCommitPayload,
    identity: string,
    ownerSongIndex: number,
  ): AutomationGestureRecoveryDraft | null => {
    const existing = recoveryDraftsRef.current;
    const duplicate = existing.find((draft) => draft.payload.gestureId === payload.gestureId
      && draft.projectIdentity === identity);
    if (duplicate) return duplicate;
    if (existing.length >= automationGestureRecoveryLimits.drafts) {
      console.error("Automation recovery queue is full; export or dismiss a saved draft before recording again");
      return null;
    }
    const draft: AutomationGestureRecoveryDraft = {
      id: `${Date.now()}-${payload.gestureId}`,
      projectIdentity: identity,
      songIndex: ownerSongIndex,
      createdAt: Date.now(),
      outcome: "unknown",
      error: "Recording submitted; awaiting an exact Core outcome. Do not retry while the result is unknown.",
      payload,
      persisted: false,
    };
    publishRecoveryDrafts([...existing, draft]);
    return draft;
  }, [publishRecoveryDrafts]);

  const dismissRecoveryDraft = useCallback((draftId: string) => {
    publishRecoveryDrafts(removeAutomationGestureDraft(recoveryDraftsRef.current, draftId));
  }, [publishRecoveryDrafts]);

  const settleGestureRecovery = useCallback((draftId: string, cause?: unknown) => {
    if (cause === undefined) {
      dismissRecoveryDraft(draftId);
      return;
    }
    const outcome = cause instanceof EditorMutationError ? cause.outcome : "unknown";
    publishRecoveryDrafts(recoveryDraftsRef.current.map((candidate) => candidate.id === draftId
      ? {
          ...candidate,
          outcome,
          error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 320),
        }
      : candidate));
  }, [dismissRecoveryDraft, publishRecoveryDrafts]);

  const retryRecoveryDraft = useCallback(async (draftId: string) => {
    const draft = recoveryDraftsRef.current.find((candidate) => candidate.id === draftId);
    if (!draft || (draft.outcome !== "not-sent" && draft.outcome !== "rejected")
      || draft.projectIdentity !== projectIdentityRef.current
      || draft.songIndex !== songIndex
      || !lanesRef.current.some((lane) => lane.id === draft.payload.laneId)) return;
    // Mark this non-idempotent request unknown before sending. If the app exits
    // mid-flight, the stored draft must never invite a blind duplicate replay.
    publishRecoveryDrafts(recoveryDraftsRef.current.map((candidate) => candidate.id === draft.id
      ? { ...candidate, outcome: "unknown", error: "Retry submitted; awaiting Core confirmation" }
      : candidate));
    try {
      await builder.automationRecordGesture({ songIndex: draft.songIndex, ...draft.payload });
      dismissRecoveryDraft(draft.id);
    } catch (cause) {
      const outcome = cause instanceof EditorMutationError ? cause.outcome : "unknown";
      publishRecoveryDrafts(recoveryDraftsRef.current.map((candidate) => candidate.id === draft.id
        ? { ...candidate, outcome, error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 320) }
        : candidate));
    }
  }, [songIndex, dismissRecoveryDraft, publishRecoveryDrafts]);

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

      const stillActive = controllerRef.current.isLaneActive(payload.laneId);
      if (!stillActive) sessionIdentityRef.current.delete(payload.laneId);
      if (payload.shouldRevertWriteMode && onWriteModeRevert)
        onWriteModeRevert(payload.laneId);

      // A looping Latch can produce another transaction while earlier exact
      // acknowledgements are still pending. If its reserved recovery slot is
      // the last one, stop that lane at this boundary and retain this completed
      // pass locally instead of submitting an unprotected write.
      if (!onCommitGesture && stillActive
        && recoveryDraftsRef.current.length + sessionIdentityRef.current.size
          >= automationGestureRecoveryLimits.drafts) {
        const lane = lanesRef.current.find((candidate) => candidate.id === payload.laneId);
        if (lane) controllerRef.current.cancelGesture({
          domain: lane.target.domain === "lighting" ? "light"
            : lane.target.domain === "midiCC" ? "midi" : lane.target.domain,
          entityId: lane.target.entityId,
          parameterId: lane.target.parameterId,
        });
        sessionIdentityRef.current.delete(payload.laneId);
        const owner = manualOverrideOwnersRef.current.get(payload.laneId);
        manualOverrideOwnersRef.current.delete(payload.laneId);
        if (owner) setManualOverride(payload.laneId, owner, false);
        const draft = beginGestureRecovery(payload, capturedIdentity, songIndex);
        if (draft) settleGestureRecovery(draft.id, new EditorMutationError(
          "Recording paused at a cycle boundary because the bounded recovery queue is full; this pass was not sent.",
          "not-sent",
          "/api/v1/builder/automation/record-gesture",
        ));
        return;
      }

      // Save an unknown-outcome draft before the POST begins. If the renderer or
      // Core exits while awaiting its exact result, the gesture remains
      // exportable after reload and is not mistaken for a safe retry.
      const recoveryDraft = onCommitGesture
        ? null
        : beginGestureRecovery(payload, capturedIdentity, songIndex);

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

      void recording.then(
        () => {
          if (recoveryDraft) settleGestureRecovery(recoveryDraft.id);
        },
        (cause: unknown) => {
          if (recoveryDraft) settleGestureRecovery(recoveryDraft.id, cause);
        },
      );

      if (!stillActive) {
        sessionIdentityRef.current.delete(payload.laneId);
        const owner = manualOverrideOwnersRef.current.get(payload.laneId);
        if (owner) {
          manualOverrideOwnersRef.current.delete(payload.laneId);
          void recording.then(
            () => setManualOverride(payload.laneId, owner, false),
            () => setManualOverride(payload.laneId, owner, false),
          );
        }
      }
    },
    [songIndex, onCommitGesture, onWriteModeRevert, setManualOverride,
      beginGestureRecovery, settleGestureRecovery],
  );

  const startGesture = useCallback(
    (target: AutomationGestureTarget, initialValue: number) => {
      if (!isPlayingRef.current || !projectIdentityRef.current) return;
      const recordableLane = findRecordableLane(lanesRef.current, target);
      const continuesActiveLane = recordableLane
        && sessionIdentityRef.current.has(recordableLane.id);
      if (recoveryDraftsRef.current.length + sessionIdentityRef.current.size
        >= automationGestureRecoveryLimits.drafts && !continuesActiveLane) return;
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

  // Core's monotonic pass counter is authoritative: telemetry can skip an
  // entire short loop and a seek can move the playhead backwards without being
  // a loop pass. Keep playhead inference only for older Core versions that do
  // not publish this counter yet.
  useEffect(() => {
    const cycleContext = JSON.stringify([
      projectIdentity,
      songIndex,
      cycleRange?.leftBeats ?? null,
      cycleRange?.rightBeats ?? null,
    ]);
    const sequence = Number.isSafeInteger(cyclePassSequence) && cyclePassSequence! >= 0
      ? cyclePassSequence!
      : null;
    const previous = lastBeatsRef.current;
    const previousSequence = lastCyclePassSequenceRef.current;
    const contextChanged = cycleContextRef.current !== cycleContext;
    cycleContextRef.current = cycleContext;
    lastCyclePassSequenceRef.current = sequence;

    if (contextChanged) {
      lastBeatsRef.current = currentBeats;
      return;
    }
    if (!isPlaying || !cycleRange) {
      lastBeatsRef.current = currentBeats;
      return;
    }
    const current = currentBeats;
    if (sequence !== null && previousSequence !== null) {
      const missedPasses = sequence >= previousSequence ? sequence - previousSequence : 0;
      if (missedPasses > 4) {
        // Preserve points we actually sampled, then resume at the current
        // cycle phase instead of flooding Core or inventing lost pass data.
        const payloads = controllerRef.current.handleTransportDiscontinuity(current);
        for (const payload of payloads) commitPayload(payload);
      } else {
        for (let pass = 0; pass < missedPasses; pass += 1) {
          const payloads = controllerRef.current.handleCycleWrap(
            cycleRange.leftBeats,
            cycleRange.rightBeats,
          );
          for (const payload of payloads) commitPayload(payload);
        }
        if (missedPasses === 0 && current < previous - 1e-6) {
          const payloads = controllerRef.current.handleTransportDiscontinuity(current);
          for (const payload of payloads) commitPayload(payload);
        }
      }
    } else if (sequence === null && previousSequence === null) {
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
        for (const payload of payloads) commitPayload(payload);
      } else if (current < previous - 1e-6) {
        const payloads = controllerRef.current.handleTransportDiscontinuity(current);
        for (const payload of payloads) commitPayload(payload);
      }
    }
    lastBeatsRef.current = current;
  }, [isPlaying, cycleRange, cyclePassSequence, currentBeats, projectIdentity,
    songIndex, commitPayload]);

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
    recoveryDrafts,
    retryRecoveryDraft,
    dismissRecoveryDraft,
  };
}
