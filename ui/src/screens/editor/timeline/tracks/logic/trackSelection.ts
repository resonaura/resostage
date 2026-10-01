/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/** Track-row selection modifiers shared by arrangement rows and headers. */
export type TrackSelectionGesture = "replace" | "range" | "toggle";

export interface TrackSelectionState {
  selectedIds: string[];
  primaryId: string | null;
  anchorId: string | null;
}

export function trackSelectionGesture(event: {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): TrackSelectionGesture {
  if (event.shiftKey === true) return "range";
  if (event.metaKey === true || event.ctrlKey === true) return "toggle";
  return "replace";
}

/** Apply standard DAW selection semantics against the visible track order. */
export function resolveTrackSelection(
  current: TrackSelectionState,
  orderedTrackIds: string[],
  targetId: string | null,
  gesture: TrackSelectionGesture,
): TrackSelectionState {
  if (!targetId) return { selectedIds: [], primaryId: null, anchorId: null };
  if (gesture === "replace")
    return { selectedIds: [targetId], primaryId: targetId, anchorId: targetId };

  if (gesture === "toggle") {
    const selected = current.selectedIds.includes(targetId);
    const selectedIds = selected
      ? current.selectedIds.filter((id) => id !== targetId)
      : [...current.selectedIds, targetId];
    return {
      selectedIds,
      primaryId: selected
        ? selectedIds.at(-1) ?? null
        : targetId,
      anchorId:
        selectedIds.length === 0
          ? null
          : current.anchorId ?? targetId,
    };
  }

  const anchorId = current.anchorId ?? current.primaryId ?? targetId;
  const anchorIndex = orderedTrackIds.indexOf(anchorId);
  const targetIndex = orderedTrackIds.indexOf(targetId);
  if (anchorIndex < 0 || targetIndex < 0)
    return { selectedIds: [targetId], primaryId: targetId, anchorId: targetId };
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return {
    selectedIds: orderedTrackIds.slice(start, end + 1),
    primaryId: targetId,
    anchorId,
  };
}
