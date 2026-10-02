/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { beginCancellableDrag, type CancellableDrag } from "@/lib/interaction/dragCancel";
import { createEditGesture } from "@/lib/interaction/editGesture";
import { subscribeHistoryBoundary } from "@/lib/state/historyNavigation";
import type { AutomationLaneRow } from "@/lib/state/types";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";
import { useAutomationCommit } from "@/screens/editor/timeline/automation/hooks/useAutomationCommit";
import { beatToPixel, hitTestAutomation, pixelDeltaToBeats, pixelToBeat, pixelToValue,
  valueToPixel } from "@/screens/editor/timeline/automation/logic/automationCoordinates";
import { replaceAutomationStroke, setAutomationSelectionCurve,
  smoothAutomationSelection } from "@/screens/editor/timeline/automation/logic/automationEditing";
import { adjustCurvature, insertAutomationPoint, moveSegment, moveSelectedPoints,
  removeAutomationPoints, selectPointsInRect,
  toggleSelectPoint } from "@/screens/editor/timeline/automation/logic/automationSelection";
import type { AutomationDragSession, AutomationPointViewModel,
  AutomationTargetOption } from "@/screens/editor/timeline/automation/logic/types";

type Surface = SVGSVGElement | HTMLDivElement;
type PointerEvent = React.PointerEvent<Surface>;
type SelectionRect = { left: number; top: number; width: number; height: number };
type Session = AutomationDragSession & {
  pointerId: number;
  target: Surface;
  startLocalX: number;
  startLocalY: number;
  initialSelection: Set<number>;
  additiveMarquee: boolean;
  stroke: AutomationPointViewModel[];
};
const MAX_STROKE_POINTS = 4096;

/**
 * One overlay owns one exclusive pointer gesture. Drafts stay local until
 * release, so Esc/blur/capture loss cannot leave partial history mutations.
 */
export function useAutomationDrag({ songIndex, lane, bpm, pxPerSec, laneHeight,
  snapToGrid = true, snapStepBeats = 0.25, tool = "pointer", readOnly = false,
  targetOption, resetKey }: {
  songIndex: number;
  lane: AutomationLaneRow;
  bpm: number;
  pxPerSec: number;
  laneHeight: number;
  snapToGrid?: boolean;
  snapStepBeats?: number;
  tool?: TimelineTool;
  readOnly?: boolean;
  targetOption?: AutomationTargetOption;
  /** Core project epoch/name identity, independent of reusable lane IDs. */
  resetKey?: string;
}) {
  const commit = useAutomationCommit(songIndex, lane, readOnly, resetKey);
  const { draftPoints, setDraftPoints, pendingRef, commitPoints, setError } = commit;
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [hoverInfo, setHoverInfo] = useState<{
    x: number; y: number; timeBeats: number; value: number; type: string;
  } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<SelectionRect | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const cancellableRef = useRef<CancellableDrag | null>(null);
  const editGesture = useRef(createEditGesture()).current;
  const lastClick = useRef({ time: 0, x: 0, y: 0 });
  const activePoints = draftPoints ?? lane.points;
  const minValue = targetOption?.minValue ?? lane.target.minValue;
  const maxValue = targetOption?.maxValue ?? lane.target.maxValue;
  const step = Number.isFinite(snapStepBeats) && snapStepBeats > 0 ? snapStepBeats : 0.25;
  const snap = (beat: number) => snapToGrid ? Math.round(beat / step) * step : beat;
  const position = (event: React.MouseEvent<Surface>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const hitAt = (x: number, y: number) => hitTestAutomation(
    activePoints, bpm, pxPerSec, laneHeight, x, y, 8, 6, minValue, maxValue,
  );
  const releaseCapture = (session: Session | null) => {
    if (session?.target.hasPointerCapture?.(session.pointerId)) {
      session.target.releasePointerCapture(session.pointerId);
    }
  };

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    cancellableRef.current?.end();
    cancellableRef.current = null;
    releaseCapture(session);
    if (session) setSelectedIndices(session.initialSelection);
    setDraftPoints(null);
    setMarqueeRect(null);
    setHoverInfo(null);
    lastClick.current.time = 0;
    editGesture.end();
  }, [editGesture, setDraftPoints]);

  useEffect(() => {
    const onBlur = () => { if (sessionRef.current) cancel(); };
    window.addEventListener("blur", onBlur);
    const unsubscribe = subscribeHistoryBoundary(() => {
      cancel();
      setSelectedIndices(new Set());
    });
    return () => { window.removeEventListener("blur", onBlur); unsubscribe(); cancel(); };
  }, [cancel]);
  useEffect(() => {
    cancel();
    setSelectedIndices(new Set());
  }, [songIndex, lane.id, readOnly, resetKey, cancel]);

  const commitOperation = (points: AutomationPointViewModel[]) => {
    const id = editGesture.id();
    editGesture.end();
    return commitPoints(points, activePoints, id);
  };
  const deleteSelectedPoints = () => {
    if (readOnly || pendingRef.current || selectedIndices.size === 0) return;
    void commitOperation(removeAutomationPoints(activePoints, selectedIndices));
    setSelectedIndices(new Set());
  };
  const smoothSelectedPoints = () => {
    if (readOnly || pendingRef.current) return;
    void commitOperation(smoothAutomationSelection(activePoints, selectedIndices, minValue, maxValue));
  };
  const setSelectedCurve = (curve: number) => {
    if (readOnly || pendingRef.current) return;
    void commitOperation(setAutomationSelectionCurve(activePoints, selectedIndices, curve));
  };
  const selectAllPoints = () => setSelectedIndices(new Set(activePoints.map((_, index) => index)));
  const clearSelection = () => setSelectedIndices(new Set());

  const onPointerDown = (event: PointerEvent) => {
    // Automation mode claims the complete surface, including empty/read-only
    // space: bubbling into the arrangement starts its independent marquee.
    event.stopPropagation();
    if (event.button !== 0) return;
    event.preventDefault();
    if (readOnly || pendingRef.current || sessionRef.current) return;
    const { x, y } = position(event);
    const hit = hitAt(x, y);
    const multi = event.shiftKey || event.metaKey || event.ctrlKey;
    const now = Date.now();
    const double = tool === "pointer" && !multi && !event.altKey
      && now - lastClick.current.time < 300
      && Math.hypot(x - lastClick.current.x, y - lastClick.current.y) < 8;
    lastClick.current = { time: now, x, y };

    if ((tool === "eraser" || event.altKey || double) && hit.type === "point") {
      void commitOperation(removeAutomationPoints(activePoints, [hit.pointIndex]));
      setSelectedIndices(new Set());
      return;
    }
    if (tool === "eraser") return;
    if (double) {
      const inserted = insertAutomationPoint(activePoints, snap(pixelToBeat(x, bpm, pxPerSec)),
        pixelToValue(y, laneHeight, minValue, maxValue));
      setSelectedIndices(new Set([inserted.insertedIndex]));
      void commitOperation(inserted.points);
      return;
    }

    let mode: Session["mode"] = "marquee";
    let selection = multi ? new Set(selectedIndices) : new Set<number>();
    let segmentBefore: number | undefined;
    let segmentAfter: number | undefined;
    let pointIndex: number | undefined;
    let stroke: AutomationPointViewModel[] = [];
    if (hit.type === "point") {
      selection = multi ? toggleSelectPoint(selectedIndices, hit.pointIndex, true)
        : selectedIndices.has(hit.pointIndex) ? new Set(selectedIndices) : new Set([hit.pointIndex]);
      setSelectedIndices(selection);
      if (!selection.has(hit.pointIndex)) return;
      mode = selection.size > 1 ? "points" : "point";
      pointIndex = hit.pointIndex;
    } else if (!event.shiftKey && tool === "pencil") {
      mode = "draw";
      stroke = [{ timeBeats: snap(pixelToBeat(x, bpm, pxPerSec)),
        value: pixelToValue(y, laneHeight, minValue, maxValue), curve: 0 }];
    } else if (!event.shiftKey && hit.type !== "none") {
      mode = hit.type === "curveHandle" || event.altKey ? "curve" : "segment";
      segmentBefore = hit.segmentIndexBefore;
      segmentAfter = hit.segmentIndexAfter;
      selection = new Set([segmentBefore, segmentAfter]);
    }

    const initialSelection = new Set(selectedIndices);
    setSelectedIndices(selection);
    const session: Session = {
      mode, songIndex, laneId: lane.id, gestureId: editGesture.id(),
      startClientX: event.clientX, startClientY: event.clientY,
      currentClientX: event.clientX, currentClientY: event.clientY,
      startLocalX: x, startLocalY: y, pointerId: event.pointerId,
      target: event.currentTarget, initialPoints: activePoints,
      draftPoints: mode === "draw" ? replaceAutomationStroke(activePoints, stroke) : activePoints,
      selectedIndices: selection, initialSelection, additiveMarquee: multi,
      activePointIndex: pointIndex, activeSegmentIndexBefore: segmentBefore,
      activeSegmentIndexAfter: segmentAfter, stroke,
    };
    sessionRef.current = session;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    cancellableRef.current = beginCancellableDrag(cancel);
    if (mode === "draw") setDraftPoints(session.draftPoints);
  };

  const updateSession = (event: PointerEvent, session: Session) => {
    const { x, y } = position(event);
    session.currentClientX = event.clientX;
    session.currentClientY = event.clientY;
    if (Math.hypot(x - session.startLocalX, y - session.startLocalY) > 4) lastClick.current.time = 0;
    const deltaValue = -(y - session.startLocalY) / Math.max(1, laneHeight) * (maxValue - minValue);
    if (session.mode === "marquee") {
      const rect = { left: Math.min(session.startLocalX, x), top: Math.min(session.startLocalY, y),
        width: Math.abs(x - session.startLocalX), height: Math.abs(y - session.startLocalY) };
      setMarqueeRect(rect);
      const selected = selectPointsInRect(session.initialPoints, bpm, pxPerSec, laneHeight,
        { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }, minValue, maxValue);
      if (session.additiveMarquee) for (const index of session.initialSelection) selected.add(index);
      setSelectedIndices(selected);
      return;
    }
    if (session.mode === "point" || session.mode === "points") {
      const delta = snap(pixelDeltaToBeats(x - session.startLocalX, bpm, pxPerSec));
      session.draftPoints = moveSelectedPoints(session.initialPoints, session.selectedIndices,
        delta, deltaValue, minValue, maxValue);
    } else if (session.mode === "curve" && session.activeSegmentIndexBefore !== undefined) {
      session.draftPoints = adjustCurvature(session.initialPoints, session.activeSegmentIndexBefore,
        -(y - session.startLocalY) / 50);
    } else if (session.mode === "segment" && session.activeSegmentIndexBefore !== undefined
      && session.activeSegmentIndexAfter !== undefined) {
      session.draftPoints = moveSegment(session.initialPoints, session.activeSegmentIndexBefore,
        session.activeSegmentIndexAfter, deltaValue, minValue, maxValue);
    } else if (session.mode === "draw") {
      const beat = snap(pixelToBeat(x, bpm, pxPerSec));
      const value = pixelToValue(y, laneHeight, minValue, maxValue);
      const exists = session.stroke.some((point) => Math.abs(point.timeBeats - beat) < 1e-6);
      if (session.stroke.length >= MAX_STROKE_POINTS && !exists) {
        setError("This stroke reached the point limit. Release and start another stroke.");
        return;
      }
      session.stroke = insertAutomationPoint(session.stroke, beat, value).points;
      session.draftPoints = replaceAutomationStroke(session.initialPoints, session.stroke);
    }
    setDraftPoints(session.draftPoints);
  };

  const onPointerMove = (event: PointerEvent) => {
    event.stopPropagation();
    const session = sessionRef.current;
    if (session) {
      if (session.pointerId !== event.pointerId) return;
      event.preventDefault();
      updateSession(event, session);
      return;
    }
    const { x, y } = position(event);
    const hit = hitAt(x, y);
    if (hit.type === "point") setHoverInfo({
      x: beatToPixel(hit.point.timeBeats, bpm, pxPerSec),
      y: valueToPixel(hit.point.value, laneHeight, minValue, maxValue),
      timeBeats: hit.point.timeBeats, value: hit.point.value, type: "point",
    });
    else if (hit.type === "curveHandle") setHoverInfo({ x: hit.handleX, y: hit.handleY,
      timeBeats: 0, value: hit.currentCurve, type: "curveHandle" });
    else setHoverInfo(null);
  };

  const onPointerUp = (event: PointerEvent) => {
    event.stopPropagation();
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    updateSession(event, session);
    sessionRef.current = null;
    cancellableRef.current?.end();
    cancellableRef.current = null;
    releaseCapture(session);
    setMarqueeRect(null);
    editGesture.end();
    if (session.mode === "marquee") return;
    void commitPoints(session.draftPoints, session.initialPoints, session.gestureId);
  };
  const onPointerCancel = (event?: PointerEvent) => {
    event?.stopPropagation();
    // Normal release also emits lostpointercapture; the completed optimistic
    // edit already belongs to the commit coordinator and must survive it.
    if (sessionRef.current && (!event || sessionRef.current.pointerId === event.pointerId)) cancel();
  };
  const onContextMenu = (event: React.MouseEvent<Surface>) => {
    event.stopPropagation();
    event.preventDefault();
    if (sessionRef.current) cancel();
    const { x, y } = position(event);
    const hit = hitAt(x, y);
    if (hit.type === "point" && !selectedIndices.has(hit.pointIndex)) {
      setSelectedIndices(new Set([hit.pointIndex]));
    } else if ((hit.type === "segment" || hit.type === "curveHandle") && selectedIndices.size === 0) {
      setSelectedIndices(new Set([hit.segmentIndexBefore, hit.segmentIndexAfter]));
    }
  };

  return { activePoints, draftPoints, selectedIndices, setSelectedIndices, hoverInfo, marqueeRect,
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu,
    onPointerLeave: () => { if (!sessionRef.current) setHoverInfo(null); },
    deleteSelectedPoints, smoothSelectedPoints, setSelectedCurve, selectAllPoints, clearSelection,
    isPending: commit.isPending, error: commit.error, selectionCount: selectedIndices.size };
}
