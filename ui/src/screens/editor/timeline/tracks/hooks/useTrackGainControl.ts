/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useRef } from "react";
import { beginCancellableDrag, type CancellableDrag } from "@/lib/interaction/dragCancel";
import { useLiveValue } from "@/lib/state/optimistic";
import { mixer } from "@/lib/state/api";
import type { TrackRow } from "@/lib/state/types";

/** Owns optimistic gain state and the timeline's vertical dB readout gesture. */
export function useTrackGainControl(
  track: TrackRow,
  index: number,
  options?: {
    onDragStart?: (value: number) => void;
    onDragMove?: (value: number) => void;
    onDragEnd?: (value: number) => void;
    onDragCancel?: (originalValue: number) => void;
  },
) {
  const readoutDragRef = useRef<{
    drag: CancellableDrag;
    dispose: () => void;
  } | null>(null);
  const onDragCancelRef = useRef(options?.onDragCancel);
  onDragCancelRef.current = options?.onDragCancel;
  const gainRef = useRef(0);
  const [gain, setGain] = useLiveValue(track.gainDb ?? 0, (value) => {
    mixer.setTrackGain(index, value);
    options?.onDragMove?.(value);
  });
  gainRef.current = gain;

  const onReadoutPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || readoutDragRef.current !== null) return;
    event.preventDefault();
    const startY = event.clientY;
    const startValue = Number.isFinite(gain) ? gain : -60;
    options?.onDragStart?.(startValue);
    const pointerId = event.pointerId;

    let lastVal = startValue;
    const onPointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const deltaY = startY - pointerEvent.clientY;
      const step = pointerEvent.shiftKey ? 0.1 : 0.5;
      const next = Math.max(
        -60,
        Math.min(12, Math.round((startValue + deltaY * 0.15) / step) * step),
      );
      lastVal = next;
      setGain(next);
    };

    const onPointerUp = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (!readoutDragRef.current) return;
      const active = readoutDragRef.current;
      readoutDragRef.current = null;
      active.dispose();
      options?.onDragEnd?.(lastVal);
    };

    const dispose = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
    };
    const cancel = () => {
      if (!readoutDragRef.current) return;
      const active = readoutDragRef.current;
      readoutDragRef.current = null;
      active.dispose();
      setGain(startValue);
      options?.onDragCancel?.(startValue);
    };
    const drag = beginCancellableDrag(cancel);
    const onPointerCancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) drag.cancel();
    };
    const onWindowBlur = () => drag.cancel();
    readoutDragRef.current = { drag, dispose };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onWindowBlur);
  };

  useEffect(() => () => {
    const active = readoutDragRef.current;
    if (!active) return;
    readoutDragRef.current = null;
    active.dispose();
    active.drag.end();
    onDragCancelRef.current?.(gainRef.current);
  }, []);

  const onReadoutDoubleClick = (event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    setGain(0);
  };

  return {
    gain,
    setGain,
    onDragStart: options?.onDragStart,
    onDragEnd: options?.onDragEnd,
    onDragCancel: options?.onDragCancel,
    onReadoutPointerDown,
    onReadoutDoubleClick,
  };
}
