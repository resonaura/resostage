/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { clamp } from "@/screens/editor/timeline/automation/logic/automationCoordinates";
import type { AutomationPointViewModel } from "@/screens/editor/timeline/automation/logic/types";

/** Core stores values/curves as floats; reconciliation tolerates that round trip. */
export function automationPointsEqual(
  left: AutomationPointViewModel[],
  right: AutomationPointViewModel[],
): boolean {
  return left.length === right.length && left.every((point, index) => {
    const other = right[index];
    return Math.abs(point.timeBeats - other.timeBeats) < 1e-7
      && Math.abs(point.value - other.value) < 1e-5
      && Math.abs(point.curve - other.curve) < 1e-5;
  });
}

/** Replace only the drawn time span; curves and points outside it remain intact. */
export function replaceAutomationStroke(
  initial: AutomationPointViewModel[],
  stroke: AutomationPointViewModel[],
): AutomationPointViewModel[] {
  if (stroke.length === 0) return initial;
  const sorted = stroke.slice().sort((left, right) => left.timeBeats - right.timeBeats);
  const start = sorted[0].timeBeats - 1e-6;
  const end = sorted[sorted.length - 1].timeBeats + 1e-6;
  return initial.filter((point) => point.timeBeats < start || point.timeBeats > end)
    .concat(sorted)
    .sort((left, right) => left.timeBeats - right.timeBeats);
}

/**
 * Two weighted smoothing passes over each contiguous selected run. Endpoints
 * are fixed, so smoothing never shifts time or changes unselected neighbours.
 * Time-weighting avoids bias when freehand points have irregular spacing.
 */
export function smoothAutomationSelection(
  points: AutomationPointViewModel[],
  selected: Set<number>,
  minValue = 0,
  maxValue = 1,
  passes = 2,
): AutomationPointViewModel[] {
  const count = clamp(Math.floor(passes), 1, 8);
  let result = points.map((point) => ({ ...point }));
  for (let pass = 0; pass < count; ++pass) {
    const previous = result;
    result = previous.map((point, index) => {
      if (!selected.has(index - 1) || !selected.has(index) || !selected.has(index + 1)) return point;
      const before = previous[index - 1];
      const after = previous[index + 1];
      if (!before || !after || after.timeBeats <= before.timeBeats) return point;
      const fraction = (point.timeBeats - before.timeBeats) / (after.timeBeats - before.timeBeats);
      const neighbourValue = before.value + fraction * (after.value - before.value);
      return { ...point, value: clamp((point.value + neighbourValue) * 0.5, minValue, maxValue) };
    });
  }
  return result;
}

/** Set the outgoing curvature only for selected segments, matching region fades. */
export function setAutomationSelectionCurve(
  points: AutomationPointViewModel[],
  selected: Set<number>,
  curve: number,
): AutomationPointViewModel[] {
  const value = clamp(curve, -1, 1);
  return points.map((point, index) => (
    index < points.length - 1 && selected.has(index)
      && (selected.size === 1 || selected.has(index + 1))
      ? { ...point, curve: value }
      : point
  ));
}
