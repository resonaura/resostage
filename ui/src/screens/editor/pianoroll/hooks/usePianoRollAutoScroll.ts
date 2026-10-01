// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { MidiNoteRow } from "@/lib/state/types";
import { RULER_HEIGHT } from "@/screens/editor/timeline/ruler/logic/constants";
import { resolveDrawNoteDuration } from "@/screens/editor/pianoroll/logic/pianoRollModel";
import type {
  DraggingState,
  GridSnapValue,
  PianoRollViewport,
} from "@/screens/editor/pianoroll/logic/types";

interface PianoRollAutoScrollOptions {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  viewportRef: MutableRefObject<PianoRollViewport>;
  draggingRef: MutableRefObject<DraggingState | null>;
  pendingCommitRef: MutableRefObject<MidiNoteRow[] | null>;
  notesToRender: MidiNoteRow[];
  keyWidth: number;
  velocityLaneHeight: number;
  snap: GridSnapValue;
  snapBeat: (beat: number) => number;
  sourceBeatAt: (beat: number) => number;
  onViewportChange: Dispatch<SetStateAction<PianoRollViewport>>;
  setLocalNotes: Dispatch<SetStateAction<MidiNoteRow[] | null>>;
}

/**
 * Keeps note drags moving when the pointer reaches a canvas edge. The RAF
 * uses elapsed time, not frame count, so scroll speed stays bounded across
 * displays with different refresh rates.
 */
export function usePianoRollAutoScroll({
  canvasRef,
  viewportRef,
  draggingRef,
  pendingCommitRef,
  notesToRender,
  keyWidth,
  velocityLaneHeight,
  snap,
  snapBeat,
  sourceBeatAt,
  onViewportChange,
  setLocalNotes,
}: PianoRollAutoScrollOptions) {
  // Auto-scroll loop state while dragging notes near canvas edges
  const autoScrollRafRef = useRef<number | null>(null);
  const lastPointerPosRef = useRef<{ clientX: number; clientY: number }>({
    clientX: 0,
    clientY: 0,
  });
  const autoScrollTimeRef = useRef<number | null>(null);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  // ── Edge Auto-Scroll Engine (time-based, bounded speed) ─────────────────
  const startAutoScroll = useCallback(() => {
    stopAutoScroll();
    autoScrollTimeRef.current = null;
    const tick = (now: number) => {
      const dragging = draggingRef.current;
      const canvas = canvasRef.current;
      if (
        !dragging ||
        !canvas ||
        (dragging.type !== "move" && dragging.type !== "resize"
          && dragging.type !== "draw")
      ) {
        autoScrollRafRef.current = null;
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const { clientX, clientY } = lastPointerPosRef.current;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const width = rect.width;
      const gridBottom = rect.height - velocityLaneHeight;

      const dt = Math.min(
        0.05,
        Math.max(0, (now - (autoScrollTimeRef.current ?? now)) / 1000),
      );
      autoScrollTimeRef.current = now;
      const EDGE_X = 55;
      const MIN_SPEED_X = 35; // pixels / second
      const MAX_SPEED_X = 420;
      let speedX = 0;

      if (x > width - EDGE_X) {
        const prox = Math.max(0, Math.min(1, (x - (width - EDGE_X)) / EDGE_X));
        speedX = MIN_SPEED_X + (MAX_SPEED_X - MIN_SPEED_X) * (prox * prox);
      } else if (
        x < keyWidth + EDGE_X &&
        x >= keyWidth - 20
      ) {
        const prox = Math.max(
          0,
          Math.min(1, (keyWidth + EDGE_X - x) / EDGE_X),
        );
        speedX = -(MIN_SPEED_X + (MAX_SPEED_X - MIN_SPEED_X) * (prox * prox));
      }

      const EDGE_Y = 45;
      const MIN_SPEED_Y = 20; // pixels / second
      const MAX_SPEED_Y = 180;
      let speedY = 0;

      if (y > gridBottom - EDGE_Y && y <= gridBottom + 30) {
        const prox = Math.max(
          0,
          Math.min(1, (y - (gridBottom - EDGE_Y)) / EDGE_Y),
        );
        speedY = -(MIN_SPEED_Y + (MAX_SPEED_Y - MIN_SPEED_Y) * (prox * prox));
      } else if (y < RULER_HEIGHT + EDGE_Y && y >= RULER_HEIGHT - 20) {
        const prox = Math.max(
          0,
          Math.min(1, (RULER_HEIGHT + EDGE_Y - y) / EDGE_Y),
        );
        speedY = MIN_SPEED_Y + (MAX_SPEED_Y - MIN_SPEED_Y) * (prox * prox);
      }

      if (speedX !== 0 || speedY !== 0) {
        onViewportChange((v) => {
          const deltaBeats = (speedX * dt) / v.pixelsPerBeat;
          const nextBeats = Math.max(0, v.scrollBeats + deltaBeats);
          const deltaPitch = (speedY * dt) / v.pixelsPerPitch;
          const nextPitch = Math.max(
            0,
            Math.min(127 - 5, v.scrollPitch + deltaPitch),
          );
          return {
            ...v,
            scrollBeats: nextBeats,
            scrollPitch: nextPitch,
          };
        });

        if (dragging.type === "draw") {
          const liveViewport = viewportRef.current;
          const pointerBeat = liveViewport.scrollBeats
            + (x - liveViewport.keyWidth) / liveViewport.pixelsPerBeat;
          const initialNote = dragging.initialNotesSnapshot.values()
            .next().value as MidiNoteRow | undefined;
          if (initialNote) {
            const duration = resolveDrawNoteDuration(
              dragging.startBeat,
              pointerBeat,
              snap,
              initialNote.durationBeats,
              3 / liveViewport.pixelsPerBeat,
            );
            const startBeat = sourceBeatAt(snapBeat(
              Math.max(0, Math.min(dragging.startBeat, pointerBeat)),
            ));
            const baseNotes = pendingCommitRef.current ?? notesToRender;
            const updated = baseNotes.map((note) =>
              dragging.targetNoteIds?.has(note.id)
                ? { ...note, startBeats: startBeat, durationBeats: duration }
                : note,
            );
            pendingCommitRef.current = updated;
            setLocalNotes(updated);
          }
        }
      }

      autoScrollRafRef.current = requestAnimationFrame(tick);
    };

    autoScrollRafRef.current = requestAnimationFrame(tick);
  }, [
    canvasRef,
    draggingRef,
    keyWidth,
    notesToRender,
    onViewportChange,
    pendingCommitRef,
    setLocalNotes,
    snap,
    snapBeat,
    sourceBeatAt,
    stopAutoScroll,
    velocityLaneHeight,
    viewportRef,
  ]);

  useEffect(() => {
    return () => stopAutoScroll();
  }, [stopAutoScroll]);

  return { lastPointerPosRef, startAutoScroll, stopAutoScroll };
}
