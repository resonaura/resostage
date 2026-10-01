// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import type { PointerEvent as ReactPointerEvent } from "react";

export type VerticalValueDragOptions = {
  min: number;
  max: number;
  sensitivity: number;
  step: number;
  fineSensitivity: number;
  fineStep: number;
  precision?: number;
  capturePointer?: boolean;
};

/** Calculate the value produced by a vertical value-control drag. */
export function getVerticalDragValue(
  startValue: number,
  deltaY: number,
  fine: boolean,
  options: VerticalValueDragOptions,
): number {
  const sensitivity = fine ? options.fineSensitivity : options.sensitivity;
  const step = fine ? options.fineStep : options.step;
  const raw = startValue + deltaY * sensitivity;
  const stepped = Math.round(raw / step) * step;
  const bounded = Math.max(options.min, Math.min(options.max, stepped));

  return options.precision === undefined
    ? bounded
    : Math.round(bounded * 10 ** options.precision) / 10 ** options.precision;
}

/**
 * Build the shared pointer handler used by compact vertical mixer controls.
 * Each control supplies its own range, sensitivity, and fine-adjustment steps.
 */
export function createVerticalValueDragHandler(
  value: number,
  onChange: (value: number) => void,
  options: VerticalValueDragOptions,
): (event: ReactPointerEvent<HTMLElement>) => void {
  return (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const target = event.currentTarget;
    if (options.capturePointer) {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {}
    }

    const startY = event.clientY;
    const startValue = value;

    const onPointerMove = (pointerEvent: PointerEvent) => {
      const deltaY = startY - pointerEvent.clientY;
      onChange(
        getVerticalDragValue(
          startValue,
          deltaY,
          pointerEvent.shiftKey,
          options,
        ),
      );
    };

    const onPointerUp = (pointerEvent: PointerEvent) => {
      if (options.capturePointer) {
        try {
          if (target.hasPointerCapture(pointerEvent.pointerId)) {
            target.releasePointerCapture(pointerEvent.pointerId);
          }
        } catch {}
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };
}
