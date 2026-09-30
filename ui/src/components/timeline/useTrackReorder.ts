import { useCallback, useEffect, useRef } from "react";
import { builder, lighting } from "../../lib/state/api";
import { beginCancellableDrag, type CancellableDrag } from "../../lib/interaction/dragCancel";
import { triggerHaptic } from "../../lib/interaction/haptics";
import type { TrackRow } from "../../lib/state/types";
import { trackSelectionGesture, type TrackSelectionGesture } from "./trackSelection";

export type TrackReorderKind = "audio" | "light";

export interface TrackReorderPreview {
  index: number;
  kind: TrackReorderKind;
  dropSlot: number;
}

interface TrackReorderOptions {
  tracks: TrackRow[];
  songIndex: number;
  sidebarContentRef: React.RefObject<HTMLDivElement | null>;
  onSelectTrack?: (id: string | null, gesture?: TrackSelectionGesture) => void;
  setSidePanelTrackIndex: (index: number | null) => void;
  setCueSelection: (value: null) => void;
  onAutoScroll?: (deltaY: number) => void;
  onTrackReorderPreview?: (preview: TrackReorderPreview | null) => void;
}

/** Owns the cancellable drag, preview, and auto-scroll lifecycle for track reordering. */
export function useTrackReorder({
  tracks,
  songIndex,
  sidebarContentRef,
  onSelectTrack,
  setSidePanelTrackIndex,
  setCueSelection,
  onAutoScroll,
  onTrackReorderPreview,
}: TrackReorderOptions) {
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    index: number;
    kind: TrackReorderKind;
    dropSlot: number;
    lastY: number;
    pointerId: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRafRef = useRef<number | null>(null);
  const cancellableDragRef = useRef<CancellableDrag | null>(null);

  const clearDrag = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    cancellableDragRef.current?.end();
    cancellableDragRef.current = null;
    dragRef.current = null;
    onTrackReorderPreview?.(null);
  }, [onTrackReorderPreview]);

  useEffect(() => {
    const cancel = () => cancellableDragRef.current?.cancel();
    window.addEventListener("blur", cancel);
    const onVisibilityChange = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearDrag();
    };
  }, [clearDrag]);

  const calculateSlot = useCallback(
    (clientY: number, kind: TrackReorderKind): number => {
      const selector =
        kind === "audio" ? "[data-track-index]" : "[data-light-track-index]";
      const els = Array.from(
        sidebarContentRef.current?.querySelectorAll<HTMLElement>(selector) ?? [],
      );
      if (els.length === 0) return 0;
      // Rows move during preview, but their slots stay on a fixed grid. Use
      // geometry rather than row identity to avoid preview oscillation.
      const first = els[0].getBoundingClientRect();
      return Math.max(
        0,
        Math.min(els.length, Math.floor((clientY - first.top) / first.height + 0.5)),
      );
    },
    [sidebarContentRef],
  );

  const startAutoScrollLoop = useCallback(() => {
    if (autoScrollRafRef.current)
      cancelAnimationFrame(autoScrollRafRef.current);
    const tick = () => {
      const drag = dragRef.current;
      if (!drag || !drag.active) {
        autoScrollRafRef.current = null;
        return;
      }
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const y = drag.lastY;
        const EDGE = 65;
        const MIN_SPEED = 2;
        const MAX_SPEED = 28;
        let speed = 0;

        if (y < rect.top + EDGE && y >= rect.top - 30) {
          const prox = Math.max(0, Math.min(1, (rect.top + EDGE - y) / EDGE));
          speed = -(MIN_SPEED + (MAX_SPEED - MIN_SPEED) * (prox * prox));
        } else if (y > rect.bottom - EDGE && y <= rect.bottom + 30) {
          const prox = Math.max(
            0,
            Math.min(1, (y - (rect.bottom - EDGE)) / EDGE),
          );
          speed = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * (prox * prox);
        }

        if (speed !== 0) {
          onAutoScroll?.(speed);
          const slot = calculateSlot(y, drag.kind);
          if (slot !== drag.dropSlot) {
            drag.dropSlot = slot;
            triggerHaptic("alignment");
            onTrackReorderPreview?.({
              index: drag.index,
              kind: drag.kind,
              dropSlot: slot,
            });
          }
        }
      }
      autoScrollRafRef.current = requestAnimationFrame(tick);
    };
    autoScrollRafRef.current = requestAnimationFrame(tick);
  }, [onAutoScroll, calculateSlot, onTrackReorderPreview]);

  const handleTrackPointerDown = (
    event: React.PointerEvent,
    index: number,
    kind: TrackReorderKind,
  ) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "button, input, select, textarea, [role='slider'], [role='button']",
      )
    ) {
      return;
    }

    dragRef.current = {
      active: false,
      startX: event.clientX,
      startY: event.clientY,
      index,
      kind,
      dropSlot: index,
      lastY: event.clientY,
      pointerId: event.pointerId,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    cancellableDragRef.current?.end();
    const captureTarget = event.currentTarget as HTMLElement;
    cancellableDragRef.current = beginCancellableDrag(() => {
      try {
        if (captureTarget.hasPointerCapture(event.pointerId))
          captureTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* Pointer capture may already be gone. */
      }
      clearDrag();
    });
  };

  const handleTrackPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.lastY = event.clientY;

    if (!drag.active) {
      const dist = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (dist > 5) {
        drag.active = true;
        triggerHaptic("generic");
        const slot = calculateSlot(event.clientY, drag.kind);
        drag.dropSlot = slot;
        onTrackReorderPreview?.({
          index: drag.index,
          kind: drag.kind,
          dropSlot: slot,
        });
        startAutoScrollLoop();
      }
      return;
    }

    const slot = calculateSlot(event.clientY, drag.kind);
    if (slot !== drag.dropSlot) {
      drag.dropSlot = slot;
      triggerHaptic("alignment");
      onTrackReorderPreview?.({
        index: drag.index,
        kind: drag.kind,
        dropSlot: slot,
      });
    }
  };

  const handleTrackPointerUp = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (autoScrollRafRef.current) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }

    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }

    if (drag.active) {
      const fromIndex = drag.index;
      const slotIndex = drag.dropSlot;
      const toIndex = slotIndex > fromIndex ? slotIndex - 1 : slotIndex;
      if (toIndex !== fromIndex) {
        triggerHaptic("generic");
        if (drag.kind === "audio") {
          const currentSongIndex = songIndex >= 0 ? songIndex : 0;
          void builder.trackMove(currentSongIndex, fromIndex, { to: toIndex });
        } else {
          void lighting.trackMove(fromIndex, { to: toIndex });
        }
      }
    } else if (event.type === "pointerup") {
      // Pointer capture suppresses the usual click path in some browsers;
      // treat a sub-threshold gesture as selection, not as a no-op.
      if (drag.kind === "audio") {
        onSelectTrack?.(tracks[drag.index]?.id ?? null, trackSelectionGesture(event));
      } else {
        setSidePanelTrackIndex(drag.index);
        setCueSelection(null);
      }
    }

    clearDrag();
  };

  const handleTrackPointerCancel = (event: React.PointerEvent) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture has already been released.
    }
    clearDrag();
  };

  return {
    containerRef,
    handleTrackPointerDown,
    handleTrackPointerMove,
    handleTrackPointerUp,
    handleTrackPointerCancel,
  };
}
