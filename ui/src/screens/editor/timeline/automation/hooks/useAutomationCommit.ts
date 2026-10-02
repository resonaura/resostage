/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { builder } from "@/lib/state/api";
import { subscribeHistoryBoundary } from "@/lib/state/historyNavigation";
import type { AutomationLaneRow } from "@/lib/state/types";
import { automationPointsEqual } from "@/screens/editor/timeline/automation/logic/automationEditing";
import type { AutomationPointViewModel } from "@/screens/editor/timeline/automation/logic/types";

/** Local drafts survive command admission until the matching Core snapshot arrives. */
export function useAutomationCommit(songIndex: number, lane: AutomationLaneRow, readOnly: boolean,
  resetKey?: string) {
  const [draftPoints, setDraftPoints] = useState<AutomationPointViewModel[] | null>(null);
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const identity = `${resetKey ?? ""}\u0000${songIndex}\u0000${lane.id}\u0000${readOnly}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const stateIdentity = useRef(identity);
  const expected = useRef<AutomationPointViewModel[] | null>(null);
  const laneRef = useRef(lane);
  laneRef.current = lane;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const reset = useCallback(() => {
    ++generation.current;
    clearTimer();
    expected.current = null;
    stateIdentity.current = identityRef.current;
    pendingRef.current = false;
    setPending(false);
    setDraftPoints(null);
    setError(null);
  }, [clearTimer]);
  const dispose = useCallback(() => {
    mounted.current = false;
    ++generation.current;
    clearTimer();
  }, [clearTimer]);

  useEffect(() => {
    mounted.current = true;
    return dispose;
  }, [dispose]);
  useEffect(reset, [identity, reset]);
  useEffect(() => subscribeHistoryBoundary(reset), [reset]);
  useEffect(() => {
    if (stateIdentity.current === identity && expected.current
      && automationPointsEqual(lane.points, expected.current)) reset();
  }, [identity, lane.points, reset]);
  const setOwnedDraft = useCallback((points: AutomationPointViewModel[] | null) => {
    stateIdentity.current = identity;
    setDraftPoints(points);
  }, [identity]);

  const commitPoints = useCallback(async (
    points: AutomationPointViewModel[],
    initialPoints: AutomationPointViewModel[],
    gestureId: string,
  ) => {
    if (readOnly || pendingRef.current || automationPointsEqual(points, initialPoints)) {
      if (!pendingRef.current) setDraftPoints(null);
      return;
    }
    const token = ++generation.current;
    stateIdentity.current = identity;
    pendingRef.current = true;
    expected.current = points;
    setPending(true);
    setError(null);
    setDraftPoints(points);
    // Bound both command admission and subsequent structural confirmation.
    // A late response cannot revive a draft invalidated by history or timeout.
    timer.current = setTimeout(() => {
      if (!mounted.current || generation.current !== token || identityRef.current !== identity) return;
      ++generation.current;
      clearTimer();
      pendingRef.current = false;
      setPending(false);
      setDraftPoints(null);
      // Retain just the expected bounded snapshot: a delayed Core echo can
      // clear the uncertainty message without resurrecting an optimistic edit.
      setError("Core did not confirm the automation edit. It may still be queued.");
    }, 3000);
    try {
      if (lane.id.startsWith("temp:")) {
        await builder.automationLaneAdd({ songIndex, ...lane.target, scope: lane.scope,
          writeMode: "read", points, gestureId });
      } else {
        await builder.automationPointsReplace({ songIndex, laneId: lane.id, points, gestureId });
      }
      if (!mounted.current || generation.current !== token || identityRef.current !== identity) return;
      if (automationPointsEqual(laneRef.current.points, points)) {
        reset();
        return;
      }
      // HTTP acknowledges admission, not execution. Keep the draft until the
      // matching structural snapshot arrives or the bounded timer expires.
    } catch (cause) {
      if (!mounted.current || generation.current !== token || identityRef.current !== identity) return;
      reset();
      setError(cause instanceof Error ? cause.message : "Automation edit failed. Please retry.");
    }
  }, [clearTimer, identity, lane.id, lane.scope, lane.target, readOnly, reset, songIndex]);

  const belongsToView = stateIdentity.current === identity;
  return { draftPoints: belongsToView ? draftPoints : null, setDraftPoints: setOwnedDraft,
    isPending: belongsToView && isPending, pendingRef, error: belongsToView ? error : null,
    setError, commitPoints };
}
