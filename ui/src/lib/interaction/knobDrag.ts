/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/** What a pointermove should do, given which pointer owns the drag. */
export type KnobMoveGate = "ignore" | "apply" | "abort";

export function gateKnobMove(
  activePointerId: number | null,
  ev: { pointerId: number; buttons: number },
): KnobMoveGate {
  if (activePointerId === null) return "ignore";
  if (ev.pointerId !== activePointerId) return "ignore";
  // Buttons released without us ever seeing the pointerup: the drag is over
  // and must not be resumed by the next stray move.
  if (ev.buttons === 0) return "abort";
  return "apply";
}

/**
 * Vertical drag mapped onto the value range. Up is louder/right, and
 * `sensitivityPx` is how far you travel for the full sweep.
 */
export function knobValueAt({
  startValue,
  startY,
  clientY,
  min,
  max,
  sensitivityPx,
}: {
  startValue: number;
  startY: number;
  clientY: number;
  min: number;
  max: number;
  sensitivityPx: number;
}): number {
  const dy = startY - clientY;
  const next = startValue + (dy / sensitivityPx) * (max - min);
  return Math.max(min, Math.min(max, next));
}
