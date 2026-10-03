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

let reducedMotionQuery: MediaQueryList | null = null;

/** Check the current OS preference without allocating a query per control. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  reducedMotionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotionQuery.matches;
}

/** Ease a telemetry-driven numeric readout with a bounded ease-out curve. */
export function easeControlValue(
  start: number,
  target: number,
  progress: number,
): number {
  if (!Number.isFinite(target)) return Number.isFinite(start) ? start : 0;
  if (!Number.isFinite(start)) return target;
  const t = Math.max(0, Math.min(1, progress));
  const eased = 1 - (1 - t) ** 3;
  return start + (target - start) * eased;
}

/**
 * Shared motion policy for UI-only telemetry presentation. It never schedules
 * work on the audio callback; direct pointer gestures always bypass easing.
 */
export function controlDisplayTransition(
  property: ControlMotionProperty,
  interacting: boolean,
): string {
  const reducedMotion = prefersReducedMotion();
  return interacting || reducedMotion
    ? "none"
    : `${property} ${CONTROL_DISPLAY_DURATION_MS}ms ${CONTROL_DISPLAY_EASING}`;
}
