/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

export function automationLaneCollapseKey(scope: string, laneId: string): string {
  return `${scope}\u0000${laneId}`;
}

export function automationPseudoTrackHeightPx(
  trackLaneHeightPx: number,
  collapsed: boolean,
): number {
  if (collapsed) return Math.max(22, Math.min(26, Math.round(trackLaneHeightPx * 0.42)));
  return Math.max(36, Math.min(52, Math.round(trackLaneHeightPx * 0.78)));
}

export function automationTrackHeightPx(
  trackLaneHeightPx: number,
  laneIds: readonly string[],
  scope: string,
  collapsedKeys: ReadonlySet<string>,
): number {
  return trackLaneHeightPx + laneIds.reduce(
    (height, laneId) => height + automationPseudoTrackHeightPx(
      trackLaneHeightPx,
      collapsedKeys.has(automationLaneCollapseKey(scope, laneId)),
    ),
    0,
  );
}

export function timelineRowTopPx(rowIndex: number, rowHeights: readonly number[]): number {
  let top = 0;
  for (let index = 0; index < Math.min(rowIndex, rowHeights.length); index++) {
    top += rowHeights[index] ?? 0;
  }
  return top;
}

/** Map any point in a track row, including an automation pseudo-row, to its owning track. */
export function timelineRowIndexAtY(
  y: number,
  rowHeights: readonly number[],
  fallbackHeight: number,
): number {
  if (rowHeights.length === 0) return 0;
  const boundedY = Math.max(0, y);
  let top = 0;
  for (let index = 0; index < rowHeights.length; index++) {
    const height = Math.max(1, rowHeights[index] ?? fallbackHeight);
    if (boundedY < top + height) return index;
    top += height;
  }
  return rowHeights.length - 1;
}

export function timelineRowsHeightPx(rowHeights: readonly number[]): number {
  return rowHeights.reduce((total, height) => total + Math.max(0, height), 0);
}
