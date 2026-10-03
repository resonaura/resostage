/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

export type ControlMotionProperty =
  | "height"
  | "left"
  | "stroke-dashoffset"
  | "top"
  | "transform";

/** Short enough to stay attached to live telemetry, long enough to hide frame steps. */
export const CONTROL_DISPLAY_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
export const CONTROL_DISPLAY_DURATION_MS = 120;

/**
 * CSS-only interpolation keeps telemetry display smooth without scheduling
 * React renders or work on the audio callback. Direct pointer gestures always
 * bypass interpolation so the control remains attached to the user's hand.
 */
export function controlDisplayTransition(
  property: ControlMotionProperty,
  interacting: boolean,
): string {
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return interacting || reducedMotion
    ? "none"
    : `${property} ${CONTROL_DISPLAY_DURATION_MS}ms ${CONTROL_DISPLAY_EASING}`;
}
