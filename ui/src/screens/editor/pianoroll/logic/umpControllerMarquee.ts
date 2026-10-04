/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { PianoRollUmpMarqueeCandidate } from "@/screens/editor/pianoroll/logic/types";

const MAX_CANDIDATES = 12_000;

/** Selects source UMP points enclosed by a canvas-space marquee rectangle. */
export function selectPianoRollUmpMarqueeCandidates(
  candidates: PianoRollUmpMarqueeCandidate[],
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  additiveSelection: ReadonlySet<number> = new Set(),
): Set<number> {
  const selected = new Set(additiveSelection);
  if (candidates.length > MAX_CANDIDATES
      || ![startX, startY, currentX, currentY].every(Number.isFinite))
    return selected;

  const minX = Math.min(startX, currentX);
  const maxX = Math.max(startX, currentX);
  const minY = Math.min(startY, currentY);
  const maxY = Math.max(startY, currentY);
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.sourceEventIndex) || candidate.sourceEventIndex < 0
        || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) continue;
    if (candidate.x >= minX && candidate.x <= maxX
        && candidate.y >= minY && candidate.y <= maxY)
      selected.add(candidate.sourceEventIndex);
  }
  return selected;
}

/** Compare source-index sets before publishing a new selection render. */
export function samePianoRollUmpControllerSelection(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const sourceIndex of left) {
    if (!right.has(sourceIndex)) return false;
  }
  return true;
}
