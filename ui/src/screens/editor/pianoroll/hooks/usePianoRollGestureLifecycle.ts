/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { AutomationLaneRow, MidiNoteRow } from "@/lib/state/types";
import { beginCancellableDrag, type CancellableDrag } from "@/lib/interaction/dragCancel";
import type {
  DraggingState,
  PianoRollControllerGesture,
  PianoRollPendingAutomationCommit,
  PianoRollVelocityPaintState,
} from "@/screens/editor/pianoroll/logic/types";

export interface PianoRollGestureSnapshot {
  notes: MidiNoteRow[] | null;
  pendingNotes: MidiNoteRow[] | null;
  lanes: AutomationLaneRow[] | null;
  selection: Set<number>;
}

interface PianoRollGestureLifecycleOptions {
  regionId: string;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  draggingRef: MutableRefObject<DraggingState | null>;
  pendingCommitRef: MutableRefObject<MidiNoteRow[] | null>;
  pendingAutomationCommitRef: MutableRefObject<PianoRollPendingAutomationCommit | null>;
  controllerGestureRef: MutableRefObject<PianoRollControllerGesture | null>;
  velocityPaintRef: MutableRefObject<PianoRollVelocityPaintState | null>;
  lastDragDetentRef: MutableRefObject<string | null>;
  stopAutoScroll: () => void;
  setLocalNotes: (notes: MidiNoteRow[] | null) => void;
  setControllerPreview: (lanes: AutomationLaneRow[] | null) => void;
  setHoveredPitch: (pitch: number | null) => void;
  onSelectionChange: (ids: Set<number>) => void;
}

/**
 * Owns Escape/pointer-cancel and region-switch cleanup. A draft belongs to one
 * region only; it must never be rendered or committed into the next region.
 */
export function usePianoRollGestureLifecycle(options: PianoRollGestureLifecycleOptions) {
  const currentRef = useRef(options);
  currentRef.current = options;
  const handleRef = useRef<CancellableDrag | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  const endGesture = useCallback(() => {
    handleRef.current?.end();
    handleRef.current = null;
    // Clear identity before releasePointerCapture dispatches its lost event.
    pointerIdRef.current = null;
  }, []);

  const releaseCapture = useCallback(() => {
    const pointerId = pointerIdRef.current;
    const canvas = currentRef.current.canvasRef.current;
    pointerIdRef.current = null;
    if (pointerId !== null && canvas?.hasPointerCapture(pointerId))
      canvas.releasePointerCapture(pointerId);
  }, []);

  const clearGesture = useCallback(() => {
    const current = currentRef.current;
    current.stopAutoScroll();
    releaseCapture();
    current.draggingRef.current = null;
    current.controllerGestureRef.current = null;
    current.velocityPaintRef.current = null;
    current.lastDragDetentRef.current = null;
    current.setHoveredPitch(null);
  }, [releaseCapture]);

  const beginGesture = useCallback((pointerId: number, snapshot: PianoRollGestureSnapshot) => {
    endGesture();
    pointerIdRef.current = pointerId;
    handleRef.current = beginCancellableDrag(() => {
      handleRef.current = null;
      const current = currentRef.current;
      clearGesture();
      // Preserve an earlier in-flight edit when cancelling a later gesture.
      current.pendingCommitRef.current = snapshot.pendingNotes;
      current.setLocalNotes(snapshot.notes);
      current.setControllerPreview(snapshot.lanes);
      current.onSelectionChange(snapshot.selection);
    });
  }, [clearGesture, endGesture]);

  const cancelGesture = useCallback(() => {
    handleRef.current?.cancel();
  }, []);

  const lostPointerCapture = useCallback((pointerId: number) => {
    if (pointerIdRef.current === pointerId) cancelGesture();
  }, [cancelGesture]);

  useLayoutEffect(() => {
    const current = currentRef.current;
    handleRef.current?.end();
    handleRef.current = null;
    clearGesture();
    current.pendingCommitRef.current = null;
    current.pendingAutomationCommitRef.current = null;
    current.setLocalNotes(null);
    current.setControllerPreview(null);
    return () => {
      handleRef.current?.end();
      handleRef.current = null;
      current.stopAutoScroll();
      releaseCapture();
    };
  }, [options.regionId, clearGesture, releaseCapture]);

  return { beginGesture, endGesture, cancelGesture, lostPointerCapture };
}
