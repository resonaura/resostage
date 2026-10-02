/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { builder } from "@/lib/state/api";
import { beginCancellableDrag, type CancellableDrag } from "@/lib/interaction/dragCancel";
import { createEditGesture } from "@/lib/interaction/editGesture";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";
import type { AutomationLaneRow } from "@/lib/state/types";
import {
  beatToPixel,
  hitTestAutomation,
  pixelToBeat,
  pixelToValue,
  valueToPixel,
} from "../logic/automationCoordinates";
import {
  adjustCurvature,
  insertAutomationPoint,
  moveSegment,
  moveSelectedPoints,
  selectPointsInRect,
  toggleSelectPoint,
} from "../logic/automationSelection";
import type {
  AutomationDragSession,
  AutomationPointViewModel,
  AutomationTargetOption,
} from "../logic/types";

export function useAutomationDrag({
  songIndex,
  lane,
  bpm,
  pxPerSec,
  laneHeight,
  snapToGrid = true,
  tool = "pointer",
  readOnly = false,
  targetOption,
}: {
  songIndex: number;
  lane: AutomationLaneRow;
  bpm: number;
  pxPerSec: number;
  laneHeight: number;
  snapToGrid?: boolean;
  tool?: TimelineTool;
  readOnly?: boolean;
  targetOption?: AutomationTargetOption;
}) {
  const [draftPoints, setDraftPoints] = useState<AutomationPointViewModel[] | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    timeBeats: number;
    value: number;
    type: string;
  } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const editGesture = useRef(createEditGesture()).current;
  const cancellableRef = useRef<CancellableDrag | null>(null);
  const sessionRef = useRef<AutomationDragSession | null>(null);
  const lastClickRef = useRef<{ time: number; x: number; y: number }>({
    time: 0,
    x: 0,
    y: 0,
  });

  const minValue = targetOption?.minValue ?? 0;
  const maxValue = targetOption?.maxValue ?? 1;

  // Active points: optimistic draft takes priority over authoritative lane state
  const activePoints = draftPoints ?? lane.points;

  // Window blur / disconnect reverts any in-progress draft
  useEffect(() => {
    const onBlur = () => {
      if (sessionRef.current) {
        cancellableRef.current?.cancel();
        sessionRef.current = null;
        setDraftPoints(null);
        setMarqueeRect(null);
      }
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      cancellableRef.current?.end();
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement | HTMLDivElement>) => {
      if (readOnly || e.button !== 0) return;
      const target = e.currentTarget;
      const bounds = target.getBoundingClientRect();
      const localX = e.clientX - bounds.left;
      const localY = e.clientY - bounds.top;

      const hit = hitTestAutomation(
        activePoints,
        bpm,
        pxPerSec,
        laneHeight,
        localX,
        localY,
        8,
        6,
        minValue,
        maxValue,
      );

      // Tool: Eraser
      if (tool === "eraser") {
        if (hit.type === "point") {
          e.preventDefault();
          const pt = activePoints[hit.pointIndex];
          void builder.automationPointRemove(
            songIndex,
            lane.id,
            pt.timeBeats,
            editGesture.id(),
          );
        }
        return;
      }

      // Check double click for point creation/removal
      const now = Date.now();
      const isDoubleClick =
        now - lastClickRef.current.time < 300 &&
        Math.hypot(
          localX - lastClickRef.current.x,
          localY - lastClickRef.current.y,
        ) < 8;
      lastClickRef.current = { time: now, x: localX, y: localY };

      if (isDoubleClick) {
        e.preventDefault();
        if (hit.type === "point") {
          // Double click on point: remove it
          const pt = activePoints[hit.pointIndex];
          void builder.automationPointRemove(
            songIndex,
            lane.id,
            pt.timeBeats,
            editGesture.id(),
          );
        } else {
          // Double click on segment or empty lane: insert point
          let insertBeat = pixelToBeat(localX, bpm, pxPerSec);
          if (snapToGrid) {
            insertBeat = Math.round(insertBeat * 4) / 4; // 16th note snap
          }
          const insertVal = pixelToValue(localY, laneHeight, minValue, maxValue);
          if (lane.id.startsWith("temp:")) {
            void builder.automationLaneAdd({
              songIndex,
              domain: lane.target.domain,
              entityId: lane.target.entityId,
              parameterId: lane.target.parameterId,
              valueType: lane.target.valueType,
              defaultValue: lane.target.defaultValue,
              minValue: lane.target.minValue,
              maxValue: lane.target.maxValue,
              scope: "track",
              writeMode: "read",
              initialTimeBeats: insertBeat,
              initialValue: insertVal,
              gestureId: editGesture.id(),
            });
          } else {
            void builder.automationPointAdd({
              songIndex,
              laneId: lane.id,
              timeBeats: insertBeat,
              value: insertVal,
              curve: 0,
              gestureId: editGesture.id(),
            });
          }
        }
        return;
      }

      // Alt/Option + click: remove point
      if (e.altKey && hit.type === "point") {
        e.preventDefault();
        const pt = activePoints[hit.pointIndex];
        void builder.automationPointRemove(
          songIndex,
          lane.id,
          pt.timeBeats,
          editGesture.id(),
        );
        return;
      }

      // Alt/Option + click on segment: insert point and start dragging
      if (e.altKey && hit.type === "segment") {
        e.preventDefault();
        const insertBeat = hit.timeBeats;
        const insertVal = hit.interpolatedValue;
        const { points: newPoints, insertedIndex } = insertAutomationPoint(
          activePoints,
          insertBeat,
          insertVal,
          0,
        );

        target.setPointerCapture(e.pointerId);
        cancellableRef.current = beginCancellableDrag(() => {
          setDraftPoints(null);
          sessionRef.current = null;
        });

        sessionRef.current = {
          mode: "point",
          songIndex,
          laneId: lane.id,
          gestureId: editGesture.id(),
          startClientX: e.clientX,
          startClientY: e.clientY,
          currentClientX: e.clientX,
          currentClientY: e.clientY,
          initialPoints: activePoints,
          draftPoints: newPoints,
          selectedIndices: new Set([insertedIndex]),
          activePointIndex: insertedIndex,
        };
        setDraftPoints(newPoints);
        setSelectedIndices(new Set([insertedIndex]));
        return;
      }

      // Pencil tool: freehand draw
      if (tool === "pencil") {
        e.preventDefault();
        target.setPointerCapture(e.pointerId);
        const beat = pixelToBeat(localX, bpm, pxPerSec);
        const val = pixelToValue(localY, laneHeight, minValue, maxValue);
        const { points: initialPoints } = insertAutomationPoint(
          activePoints,
          beat,
          val,
          0,
        );

        cancellableRef.current = beginCancellableDrag(() => {
          setDraftPoints(null);
          sessionRef.current = null;
        });

        sessionRef.current = {
          mode: "draw",
          songIndex,
          laneId: lane.id,
          gestureId: editGesture.id(),
          startClientX: e.clientX,
          startClientY: e.clientY,
          currentClientX: e.clientX,
          currentClientY: e.clientY,
          initialPoints: activePoints,
          draftPoints: initialPoints,
          selectedIndices: new Set(),
        };
        setDraftPoints(initialPoints);
        return;
      }

      // Pointer tool: standard point / curve / segment / marquee drag
      if (hit.type === "point") {
        e.preventDefault();
        target.setPointerCapture(e.pointerId);
        const isMulti = e.shiftKey || e.metaKey || e.ctrlKey;
        const nextSel = toggleSelectPoint(selectedIndices, hit.pointIndex, isMulti);
        setSelectedIndices(nextSel);

        cancellableRef.current = beginCancellableDrag(() => {
          setDraftPoints(null);
          sessionRef.current = null;
        });

        sessionRef.current = {
          mode: nextSel.size > 1 ? "points" : "point",
          songIndex,
          laneId: lane.id,
          gestureId: editGesture.id(),
          startClientX: e.clientX,
          startClientY: e.clientY,
          currentClientX: e.clientX,
          currentClientY: e.clientY,
          initialPoints: activePoints,
          draftPoints: activePoints,
          selectedIndices: nextSel,
          activePointIndex: hit.pointIndex,
        };
        return;
      }

      if (hit.type === "curveHandle") {
        e.preventDefault();
        target.setPointerCapture(e.pointerId);
        cancellableRef.current = beginCancellableDrag(() => {
          setDraftPoints(null);
          sessionRef.current = null;
        });

        sessionRef.current = {
          mode: "curve",
          songIndex,
          laneId: lane.id,
          gestureId: editGesture.id(),
          startClientX: e.clientX,
          startClientY: e.clientY,
          currentClientX: e.clientX,
          currentClientY: e.clientY,
          initialPoints: activePoints,
          draftPoints: activePoints,
          selectedIndices: new Set(),
          activeSegmentIndexBefore: hit.segmentIndexBefore,
          activeSegmentIndexAfter: hit.segmentIndexAfter,
        };
        return;
      }

      if (hit.type === "segment") {
        e.preventDefault();
        target.setPointerCapture(e.pointerId);
        cancellableRef.current = beginCancellableDrag(() => {
          setDraftPoints(null);
          sessionRef.current = null;
        });

        sessionRef.current = {
          mode: "segment",
          songIndex,
          laneId: lane.id,
          gestureId: editGesture.id(),
          startClientX: e.clientX,
          startClientY: e.clientY,
          currentClientX: e.clientX,
          currentClientY: e.clientY,
          initialPoints: activePoints,
          draftPoints: activePoints,
          selectedIndices: new Set([
            hit.segmentIndexBefore,
            hit.segmentIndexAfter,
          ]),
          activeSegmentIndexBefore: hit.segmentIndexBefore,
          activeSegmentIndexAfter: hit.segmentIndexAfter,
        };
        return;
      }

      // Empty space: Marquee selection or clear selection
      if (!e.shiftKey) {
        setSelectedIndices(new Set());
      }
      target.setPointerCapture(e.pointerId);
      cancellableRef.current = beginCancellableDrag(() => {
        setMarqueeRect(null);
        sessionRef.current = null;
      });

      sessionRef.current = {
        mode: "marquee",
        songIndex,
        laneId: lane.id,
        gestureId: editGesture.id(),
        startClientX: localX,
        startClientY: localY,
        currentClientX: localX,
        currentClientY: localY,
        initialPoints: activePoints,
        draftPoints: activePoints,
        selectedIndices: e.shiftKey ? selectedIndices : new Set(),
      };
    },
    [
      activePoints,
      bpm,
      editGesture,
      lane.id,
      lane.target,
      laneHeight,
      maxValue,
      minValue,
      pxPerSec,
      readOnly,
      selectedIndices,
      snapToGrid,
      songIndex,
      tool,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement | HTMLDivElement>) => {
      const bounds = e.currentTarget.getBoundingClientRect();
      const localX = e.clientX - bounds.left;
      const localY = e.clientY - bounds.top;

      const session = sessionRef.current;
      if (!session) {
        // Hover inspection
        const hit = hitTestAutomation(
          activePoints,
          bpm,
          pxPerSec,
          laneHeight,
          localX,
          localY,
          8,
          6,
          minValue,
          maxValue,
        );
        if (hit.type === "point") {
          const pt = activePoints[hit.pointIndex];
          setHoverInfo({
            x: beatToPixel(pt.timeBeats, bpm, pxPerSec),
            y: valueToPixel(pt.value, laneHeight, minValue, maxValue),
            timeBeats: pt.timeBeats,
            value: pt.value,
            type: "point",
          });
        } else if (hit.type === "curveHandle") {
          setHoverInfo({
            x: hit.handleX,
            y: hit.handleY,
            timeBeats: 0,
            value: hit.currentCurve,
            type: "curveHandle",
          });
        } else {
          setHoverInfo(null);
        }
        return;
      }

      session.currentClientX = e.clientX;
      session.currentClientY = e.clientY;

      if (session.mode === "point" || session.mode === "points") {
        const deltaPxX = e.clientX - session.startClientX;
        const deltaPxY = e.clientY - session.startClientY;

        let deltaBeats = pixelToBeat(deltaPxX, bpm, pxPerSec);
        if (snapToGrid) {
          deltaBeats = Math.round(deltaBeats * 4) / 4;
        }

        const deltaValNorm = -deltaPxY / Math.max(1, laneHeight);
        const deltaValue = deltaValNorm * (maxValue - minValue);

        const moved = moveSelectedPoints(
          session.initialPoints,
          session.selectedIndices,
          deltaBeats,
          deltaValue,
          minValue,
          maxValue,
        );
        session.draftPoints = moved;
        setDraftPoints(moved);
        return;
      }

      if (session.mode === "curve" && session.activeSegmentIndexBefore !== undefined) {
        const deltaPxY = -(e.clientY - session.startClientY);
        const deltaCurve = (deltaPxY / 50.0) * 1.0;
        const curved = adjustCurvature(
          session.initialPoints,
          session.activeSegmentIndexBefore,
          deltaCurve,
        );
        session.draftPoints = curved;
        setDraftPoints(curved);
        return;
      }

      if (
        session.mode === "segment" &&
        session.activeSegmentIndexBefore !== undefined &&
        session.activeSegmentIndexAfter !== undefined
      ) {
        const deltaPxY = -(e.clientY - session.startClientY);
        const deltaValNorm = deltaPxY / Math.max(1, laneHeight);
        const deltaValue = deltaValNorm * (maxValue - minValue);

        const moved = moveSegment(
          session.initialPoints,
          session.activeSegmentIndexBefore,
          session.activeSegmentIndexAfter,
          deltaValue,
          minValue,
          maxValue,
        );
        session.draftPoints = moved;
        setDraftPoints(moved);
        return;
      }

      if (session.mode === "draw") {
        const beat = pixelToBeat(localX, bpm, pxPerSec);
        const val = pixelToValue(localY, laneHeight, minValue, maxValue);
        const { points: nextPoints } = insertAutomationPoint(
          session.draftPoints,
          beat,
          val,
          0,
        );
        session.draftPoints = nextPoints;
        setDraftPoints(nextPoints);
        return;
      }

      if (session.mode === "marquee") {
        const left = Math.min(session.startClientX, localX);
        const top = Math.min(session.startClientY, localY);
        const width = Math.abs(localX - session.startClientX);
        const height = Math.abs(localY - session.startClientY);
        setMarqueeRect({ left, top, width, height });

        const inBox = selectPointsInRect(
          session.initialPoints,
          bpm,
          pxPerSec,
          laneHeight,
          { left, top, right: left + width, bottom: top + height },
          minValue,
          maxValue,
        );
        setSelectedIndices(inBox);
      }
    },
    [
      activePoints,
      bpm,
      laneHeight,
      maxValue,
      minValue,
      pxPerSec,
      snapToGrid,
    ],
  );

  const onPointerUp = useCallback(
    async (e: React.PointerEvent<SVGSVGElement | HTMLDivElement>) => {
      const session = sessionRef.current;
      cancellableRef.current?.end();
      sessionRef.current = null;
      setMarqueeRect(null);

      if (!session || !session.draftPoints) {
        setDraftPoints(null);
        return;
      }

      const target = e.currentTarget;
      try {
        if (target && "hasPointerCapture" in target && target.hasPointerCapture(e.pointerId)) {
          target.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore uncaptured pointer
      }

      // Commit changes to backend under single gesture transaction
      const finalPoints = session.draftPoints;
      try {
        if (lane.id.startsWith("temp:")) {
          const pt =
            session.activePointIndex !== undefined &&
            finalPoints[session.activePointIndex]
              ? finalPoints[session.activePointIndex]
              : finalPoints[0];
          await builder.automationLaneAdd({
            songIndex,
            domain: lane.target.domain,
            entityId: lane.target.entityId,
            parameterId: lane.target.parameterId,
            valueType: lane.target.valueType,
            defaultValue: lane.target.defaultValue,
            minValue: lane.target.minValue,
            maxValue: lane.target.maxValue,
            scope: "track",
            writeMode: "read",
            initialTimeBeats: pt?.timeBeats ?? 0,
            initialValue: pt?.value ?? lane.target.defaultValue,
            gestureId: session.gestureId,
          });
        } else if (
          session.mode === "point" &&
          session.activePointIndex !== undefined &&
          finalPoints[session.activePointIndex]
        ) {
          const pt = finalPoints[session.activePointIndex];
          const initialPt = session.initialPoints[session.activePointIndex];
          if (initialPt && Math.abs(initialPt.timeBeats - pt.timeBeats) >= 1e-4) {
            await builder.automationPointRemove(
              songIndex,
              lane.id,
              initialPt.timeBeats,
              session.gestureId,
            );
          }
          await builder.automationPointAdd({
            songIndex,
            laneId: lane.id,
            timeBeats: pt.timeBeats,
            value: pt.value,
            curve: pt.curve,
            gestureId: session.gestureId,
          });
        } else if (
          session.mode === "curve" &&
          session.activeSegmentIndexBefore !== undefined &&
          finalPoints[session.activeSegmentIndexBefore]
        ) {
          const pt = finalPoints[session.activeSegmentIndexBefore];
          await builder.automationPointAdd({
            songIndex,
            laneId: lane.id,
            timeBeats: pt.timeBeats,
            value: pt.value,
            curve: pt.curve,
            gestureId: session.gestureId,
          });
        } else if (
          session.mode === "segment" &&
          session.activeSegmentIndexBefore !== undefined &&
          session.activeSegmentIndexAfter !== undefined
        ) {
          const p1 = finalPoints[session.activeSegmentIndexBefore];
          const p2 = finalPoints[session.activeSegmentIndexAfter];
          if (p1) {
            await builder.automationPointAdd({
              songIndex,
              laneId: lane.id,
              timeBeats: p1.timeBeats,
              value: p1.value,
              curve: p1.curve,
              gestureId: session.gestureId,
            });
          }
          if (p2) {
            await builder.automationPointAdd({
              songIndex,
              laneId: lane.id,
              timeBeats: p2.timeBeats,
              value: p2.value,
              curve: p2.curve,
              gestureId: session.gestureId,
            });
          }
        } else if (session.mode === "points") {
          for (const idx of session.selectedIndices) {
            const initialPt = session.initialPoints[idx];
            const pt = finalPoints[idx];
            if (!pt || !initialPt) continue;
            if (Math.abs(initialPt.timeBeats - pt.timeBeats) >= 1e-4) {
              await builder.automationPointRemove(
                songIndex,
                lane.id,
                initialPt.timeBeats,
                session.gestureId,
              );
            }
            await builder.automationPointAdd({
              songIndex,
              laneId: lane.id,
              timeBeats: pt.timeBeats,
              value: pt.value,
              curve: pt.curve,
              gestureId: session.gestureId,
            });
          }
        } else if (session.mode === "draw") {
          // Bounded multi-point recording gesture
          const punchIn = finalPoints[0]?.timeBeats ?? 0;
          const release = finalPoints[finalPoints.length - 1]?.timeBeats ?? punchIn;
          const releaseVal = finalPoints[finalPoints.length - 1]?.value ?? 0;

          await builder.automationRecordGesture({
            songIndex,
            laneId: lane.id,
            punchInBeats: punchIn,
            releaseBeats: release,
            releaseValue: releaseVal,
            points: finalPoints.map((p) => ({
              timeBeats: p.timeBeats,
              value: p.value,
            })),
            gestureId: session.gestureId,
          });
        }
      } catch {
        // Backend failure: revert optimistic preview safely
        setDraftPoints(null);
      } finally {
        editGesture.end();
        setDraftPoints(null);
      }
    },
    [editGesture, lane.id, lane.target, songIndex],
  );

  const onPointerCancel = useCallback(() => {
    cancellableRef.current?.cancel();
    sessionRef.current = null;
    setDraftPoints(null);
    setMarqueeRect(null);
    setHoverInfo(null);
  }, []);

  return {
    activePoints,
    draftPoints,
    selectedIndices,
    setSelectedIndices,
    hoverInfo,
    marqueeRect,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
