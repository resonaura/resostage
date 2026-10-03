/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/**
 * Resolve the value a DAW control should display without feeding it back to
 * Core. A pending local edit wins over both stale server state and playback
 * automation until the shared optimistic value hook reconciles with Core.
 */
export function automatableValueForDisplay(
  authoritativeValue: number,
  automatedValue: number | null | undefined,
  optimisticValue: number,
): number {
  if (optimisticValue !== authoritativeValue) return optimisticValue;
  return automatedValue != null && Number.isFinite(automatedValue)
    ? automatedValue
    : authoritativeValue;
}
