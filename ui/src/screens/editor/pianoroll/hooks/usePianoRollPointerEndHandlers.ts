/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { triggerHaptic } from "@/lib/interaction/haptics";
import type { AutomationLaneRow, MidiNoteRow, MidiRegionRow } from "@/lib/state/types";
import { DEFAULT_NOTE_VELOCITY } from "@/screens/editor/pianoroll/logic/canvasUtils";
import type { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";
import type {
  DraggingState,
  PianoRollBottomLane,
  PianoRollControllerGesture,
  PianoRollPendingAutomationCommit,
  PianoRollViewport,
  PianoRollVelocityPaintState,
} from "@/screens/editor/pianoroll/logic/types";

interface PianoRollPointerEndHandlerOptions {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  draggingRef: MutableRefObject<DraggingState | null>;
  pendingCommitRef: MutableRefObject<MidiNoteRow[] | null>;
  pendingAutomationCommitRef: MutableRefObject<PianoRollPendingAutomationCommit | null>;
  controllerGestureRef: MutableRefObject<PianoRollControllerGesture | null>;
  localAutomationLanesRef: MutableRefObject<AutomationLaneRow[] | null>;
  velocityPaintRef: MutableRefObject<PianoRollVelocityPaintState | null>;
  lastDragDetentRef: MutableRefObject<string | null>;
  localNotes: MidiNoteRow[] | null;
  notesToRender: MidiNoteRow[];
  region: MidiRegionRow;
  viewport: PianoRollViewport;
  bottomLane: PianoRollBottomLane;
  spatialIndex: MutableRefObject<SpatialNoteIndex>;
  stopAutoScroll: () => void;
  render: () => void;
  sourceBeatAt: (beat: number) => number;
  xToBeat: (x: number) => number;
  setLocalNotes: Dispatch<SetStateAction<MidiNoteRow[] | null>>;
  setHoveredPitch: Dispatch<SetStateAction<number | null>>;
  setControllerPreview: (lanes: AutomationLaneRow[] | null) => void;
  onNotesChange: (notes: MidiNoteRow[]) => void;
  onSelectionChange: (ids: Set<number>) => void;
  onRegionChange?: (region: MidiRegionRow) => void;
}

/** Commits, cancels, or finalizes a Piano Roll pointer gesture. */
export function usePianoRollPointerEndHandlers({
  canvasRef,
  draggingRef,
  pendingCommitRef,
  pendingAutomationCommitRef,
  controllerGestureRef,
  localAutomationLanesRef,
  velocityPaintRef,
  lastDragDetentRef,
  localNotes,
  notesToRender,
  region,
  viewport,
  bottomLane,
  spatialIndex,
  stopAutoScroll,
  render,
  sourceBeatAt,
  xToBeat,
  setLocalNotes,
  setHoveredPitch,
  setControllerPreview,
  onNotesChange,
  onSelectionChange,
  onRegionChange,
}: PianoRollPointerEndHandlerOptions) {
  // ── Pointer Up Interaction ─────────────────────────────────────────────
  const handlePointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    stopAutoScroll();

    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }

    const dragging = draggingRef.current;
    if (dragging) {
      const isNoteGesture =
        dragging.type === "move" ||
        dragging.type === "resize" ||
        dragging.type === "draw" ||
        dragging.type === "velocity" ||
        dragging.type === "brush";

      const finalNotes = dragging.type === "velocity"
        ? velocityPaintRef.current?.notes ?? localNotes
        : localNotes;

      if (isNoteGesture && finalNotes) {
        onNotesChange(finalNotes);
        triggerHaptic("generic");
      } else if (dragging.type === "cc" && controllerGestureRef.current?.changed &&
                 localAutomationLanesRef.current && onRegionChange) {
        const lanes = localAutomationLanesRef.current;
        const lane = controllerGestureRef.current && lanes[controllerGestureRef.current.laneIndex];
        if (lane) {
          pendingAutomationCommitRef.current = {
            parameterId: lane.target.parameterId,
            points: lane.points,
          };
          onRegionChange({ ...region, automationLanes: lanes });
          triggerHaptic("generic");
        }
      }
      pendingCommitRef.current = null;
      setLocalNotes(null);
    }
    draggingRef.current = null;
    controllerGestureRef.current = null;
    velocityPaintRef.current = null;
    setHoveredPitch(null);
    render();
  };

  const handlePointerCancel = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    stopAutoScroll();
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    // A cancelled gesture must not leave a speculative local preview or a
    // running RAF loop behind. The authoritative notes were not committed.
    setLocalNotes(null);
    pendingCommitRef.current = null;
    if (controllerGestureRef.current)
      setControllerPreview(controllerGestureRef.current.beforeLanes);
    controllerGestureRef.current = null;
    draggingRef.current = null;
    velocityPaintRef.current = null;
    lastDragDetentRef.current = null;
    render();
  };

  const handleDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (bottomLane !== "velocity") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < rect.height - viewport.velocityLaneHeight) return;

    e.preventDefault();
    e.stopPropagation();
    const hit = spatialIndex.current.hitTestStart(
      sourceBeatAt(xToBeat(x)),
      Math.max(0.08, 8 / viewport.pixelsPerBeat),
    );
    if (!hit) return;
    const updated = notesToRender.map((note) =>
      note.id === hit.id ? { ...note, velocity: DEFAULT_NOTE_VELOCITY } : note,
    );
    setLocalNotes(updated);
    pendingCommitRef.current = updated;
    onNotesChange(updated);
    onSelectionChange(new Set([hit.id]));
    velocityPaintRef.current = null;
    draggingRef.current = null;
    render();
  };

  return {
    handlePointerUp,
    handlePointerCancel,
    handleDoubleClick,
  };
}
