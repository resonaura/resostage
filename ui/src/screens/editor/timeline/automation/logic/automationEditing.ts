/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { clamp } from "@/screens/editor/timeline/automation/logic/automationCoordinates";
import type { AutomationPointViewModel } from "@/screens/editor/timeline/automation/logic/types";
import type { AutomationPointClipboard } from "@/screens/editor/timeline/automation/logic/automationClipboard";

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

/**
 * Copies selected points and computes their normalized beat offsets relative to the first selected point.
 */
export function copySelectedAutomationPoints(
  points: AutomationPointViewModel[],
  selected: Set<number>,
  sourceTarget?: { domain: string; parameterId: string },
): AutomationPointClipboard | null {
  if (selected.size === 0) return null;
  const selectedPoints = points
    .filter((_, index) => selected.has(index))
    .sort((a, b) => a.timeBeats - b.timeBeats);
  if (selectedPoints.length === 0) return null;

  const minBeats = selectedPoints[0].timeBeats;
  const maxBeats = selectedPoints[selectedPoints.length - 1].timeBeats;
  const spanBeats = Math.max(0, maxBeats - minBeats);

  return {
    spanBeats,
    points: selectedPoints.map((p) => ({
      offsetBeats: p.timeBeats - minBeats,
      value: p.value,
      curve: p.curve,
    })),
    sourceDomain: sourceTarget?.domain,
    sourceParameterId: sourceTarget?.parameterId,
  };
}

/**
 * Pastes clipboard points at target beat offset, replacing underlying points across the pasted span.
 */
export function pasteAutomationClipboard(
  existing: AutomationPointViewModel[],
  clipboard: AutomationPointClipboard,
  targetBeats: number,
  minValue = 0,
  maxValue = 1,
): { points: AutomationPointViewModel[]; newIndices: Set<number> } {
  if (clipboard.points.length === 0) {
    return { points: existing, newIndices: new Set() };
  }

  const baseBeats = Math.max(0, targetBeats);
  const pasted: AutomationPointViewModel[] = clipboard.points.map((p) => ({
    timeBeats: Math.max(0, baseBeats + p.offsetBeats),
    value: clamp(p.value, minValue, maxValue),
    curve: clamp(p.curve, -1, 1),
  }));

  const updated = replaceAutomationStroke(existing, pasted);

  const newIndices = new Set<number>();
  pasted.forEach((pt) => {
    const idx = updated.findIndex(
      (u) => Math.abs(u.timeBeats - pt.timeBeats) < 1e-6 && Math.abs(u.value - pt.value) < 1e-5,
    );
    if (idx !== -1) newIndices.add(idx);
  });

  return { points: updated, newIndices };
}

/**
 * Duplicates selected points immediately following the selection span, aligned to grid step.
 */
export function duplicateAutomationSelection(
  existing: AutomationPointViewModel[],
  selected: Set<number>,
  gridStepBeats = 1,
  minValue = 0,
  maxValue = 1,
): { points: AutomationPointViewModel[]; newIndices: Set<number> } | null {
  const clip = copySelectedAutomationPoints(existing, selected);
  if (!clip || clip.points.length === 0) return null;

  const selectedPoints = existing.filter((_, idx) => selected.has(idx));
  const minBeats = Math.min(...selectedPoints.map((p) => p.timeBeats));
  const shiftBeats = clip.spanBeats > 0
    ? (gridStepBeats > 0 ? Math.ceil(clip.spanBeats / gridStepBeats) * gridStepBeats : clip.spanBeats)
    : Math.max(0.25, gridStepBeats);

  const destinationBeats = minBeats + shiftBeats;
  return pasteAutomationClipboard(existing, clip, destinationBeats, minValue, maxValue);
}

