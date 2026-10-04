/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/**
 * Evaluate the shared editor curve law: position^(2^(-curve * 2)).
 * Curve is clamped to [-1, 1], matching Core automation and region fades.
 */
export function evaluateEditorCurve(position: number, curve: number): number {
  const normalizedPosition = Number.isFinite(position)
    ? Math.max(0, Math.min(1, position))
    : 0;
  if (normalizedPosition <= 0 || normalizedPosition >= 1) return normalizedPosition;
  const normalizedCurve = Number.isFinite(curve)
    ? Math.max(-1, Math.min(1, curve))
    : 0;
  if (Math.abs(normalizedCurve) < 1e-6) return normalizedPosition;
  return Math.pow(normalizedPosition, Math.pow(2, -normalizedCurve * 2));
}
