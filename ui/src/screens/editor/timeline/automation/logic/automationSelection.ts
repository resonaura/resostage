/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import {
  beatToPixel,
  clamp,
  valueToPixel,
} from "@/screens/editor/timeline/automation/logic/automationCoordinates";
import type { AutomationPointViewModel } from "@/screens/editor/timeline/automation/logic/types";

/**
 * Toggles single or multi-point selection.
 */
export function toggleSelectPoint(
  selected: Set<number>,
  index: number,
  isMulti: boolean,
): Set<number> {
  const next = isMulti ? new Set(selected) : new Set<number>();
  if (isMulti && next.has(index)) {
    next.delete(index);
  } else {
    next.add(index);
  }
  return next;
}

/**
 * Selects all points within a contiguous index range.
 */
export function selectRangePoints(
  selected: Set<number>,
  startIdx: number,
  endIdx: number,
): Set<number> {
  const next = new Set(selected);
  const min = Math.min(startIdx, endIdx);
  const max = Math.max(startIdx, endIdx);
  for (let i = min; i <= max; i++) {
    next.add(i);
  }
  return next;
}

/**
 * Marquee selection: returns set of indices whose points lie within the bounding box.
 */
export function selectPointsInRect(
  points: AutomationPointViewModel[],
  bpm: number,
  pxPerSec: number,
  height: number,
  rect: { left: number; top: number; right: number; bottom: number },
  minValue = 0,
  maxValue = 1,
): Set<number> {
  const selected = new Set<number>();
  const minX = Math.min(rect.left, rect.right);
  const maxX = Math.max(rect.left, rect.right);
  const minY = Math.min(rect.top, rect.bottom);
  const maxY = Math.max(rect.top, rect.bottom);

  points.forEach((point, index) => {
    const px = beatToPixel(point.timeBeats, bpm, pxPerSec);
    const py = valueToPixel(point.value, height, minValue, maxValue);
    if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
      selected.add(index);
    }
  });

  return selected;
}

/**
 * Moves selected points preserving order and relative offsets.
 * Points cannot cross unselected neighboring points or reverse order.
 */
export function moveSelectedPoints(
  points: AutomationPointViewModel[],
  selected: Set<number>,
  deltaBeats: number,
  deltaValue: number,
  minValue = 0,
  maxValue = 1,
): AutomationPointViewModel[] {
  if (points.length === 0 || selected.size === 0) return points;

  // Clone points
  const updated = points.map((p) => ({ ...p }));
  const sortedIndices = Array.from(selected)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < points.length)
    .sort((a, b) => a - b);
  if (sortedIndices.length === 0) return points;

  // 1. Calculate permissible deltaBeats bounds for the entire selection block
  let minAllowedDeltaBeats = -Infinity;
  let maxAllowedDeltaBeats = Infinity;

  // Selection cannot move earlier than 0 beats
  const earliestSelectedBeat = Math.min(
    ...sortedIndices.map((i) => updated[i].timeBeats),
  );
  minAllowedDeltaBeats = Math.max(minAllowedDeltaBeats, -earliestSelectedBeat);

  for (const idx of sortedIndices) {
    // If previous neighbor is unselected, we cannot move past it
    if (idx > 0 && !selected.has(idx - 1)) {
      const bound = updated[idx - 1].timeBeats - updated[idx].timeBeats + 1e-4;
      minAllowedDeltaBeats = Math.max(minAllowedDeltaBeats, bound);
    }
    // If next neighbor is unselected, we cannot move past it
    if (idx < updated.length - 1 && !selected.has(idx + 1)) {
      const bound = updated[idx + 1].timeBeats - updated[idx].timeBeats - 1e-4;
      maxAllowedDeltaBeats = Math.min(maxAllowedDeltaBeats, bound);
    }
  }

  if (minAllowedDeltaBeats > maxAllowedDeltaBeats) {
    minAllowedDeltaBeats = 0;
    maxAllowedDeltaBeats = 0;
  }

  const effectiveDeltaBeats = clamp(
    deltaBeats,
    minAllowedDeltaBeats,
    maxAllowedDeltaBeats,
  );

  // Clamp the entire group's value displacement, not each point separately:
  // pinned points must retain their relative values while moving together.
  let minAllowedDeltaValue = -Infinity;
  let maxAllowedDeltaValue = Infinity;
  for (const idx of sortedIndices) {
    minAllowedDeltaValue = Math.max(minAllowedDeltaValue, minValue - updated[idx].value);
    maxAllowedDeltaValue = Math.min(maxAllowedDeltaValue, maxValue - updated[idx].value);
  }
  const effectiveDeltaValue = clamp(deltaValue, minAllowedDeltaValue, maxAllowedDeltaValue);

  for (const idx of sortedIndices) {
    updated[idx].timeBeats = Math.max(
      0,
      updated[idx].timeBeats + effectiveDeltaBeats,
    );
    updated[idx].value = clamp(
      updated[idx].value + effectiveDeltaValue,
      minValue,
      maxValue,
    );
  }

  // Stable sort by timeBeats just in case
  updated.sort((a, b) => a.timeBeats - b.timeBeats);
  return updated;
}

/**
 * Displaces a segment between two points vertically.
 */
export function moveSegment(
  points: AutomationPointViewModel[],
  beforeIdx: number,
  afterIdx: number,
  deltaValue: number,
  minValue = 0,
  maxValue = 1,
): AutomationPointViewModel[] {
  if (beforeIdx < 0 || afterIdx >= points.length) return points;
  return moveSelectedPoints(points, new Set([beforeIdx, afterIdx]), 0, deltaValue, minValue, maxValue);
}

/**
 * Adjusts curvature of a curve segment.
 */
export function adjustCurvature(
  points: AutomationPointViewModel[],
  segmentBeforeIdx: number,
  deltaCurve: number,
): AutomationPointViewModel[] {
  if (segmentBeforeIdx < 0 || segmentBeforeIdx >= points.length) return points;
  const updated = points.map((p) => ({ ...p }));
  updated[segmentBeforeIdx].curve = clamp(
    updated[segmentBeforeIdx].curve + deltaCurve,
    -1.0,
    1.0,
  );
  return updated;
}

/**
 * Inserts a new point into the lane or updates existing if within 1e-4 beats.
 */
export function insertAutomationPoint(
  points: AutomationPointViewModel[],
  timeBeats: number,
  value: number,
  curve = 0,
): { points: AutomationPointViewModel[]; insertedIndex: number } {
  const safeTime = Math.max(0, timeBeats);
  const updated = points.map((p) => ({ ...p }));

  const existingIdx = updated.findIndex(
    (p) => Math.abs(p.timeBeats - safeTime) < 1e-4,
  );

  if (existingIdx >= 0) {
    updated[existingIdx].value = value;
    updated[existingIdx].curve = curve;
    return { points: updated, insertedIndex: existingIdx };
  }

  const newPoint: AutomationPointViewModel = {
    timeBeats: safeTime,
    value,
    curve,
  };

  updated.push(newPoint);
  updated.sort((a, b) => a.timeBeats - b.timeBeats);

  const insertedIndex = updated.indexOf(newPoint);
  return { points: updated, insertedIndex };
}

/**
 * Removes points at specified indices.
 */
export function removeAutomationPoints(
  points: AutomationPointViewModel[],
  indicesToRemove: Set<number> | number[],
): AutomationPointViewModel[] {
  const removeSet =
    indicesToRemove instanceof Set
      ? indicesToRemove
      : new Set(indicesToRemove);
  return points.filter((_, idx) => !removeSet.has(idx));
}
