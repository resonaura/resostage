/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { automationPointsEqual, replaceAutomationStroke, setAutomationSelectionCurve,
  smoothAutomationSelection } from "@/screens/editor/timeline/automation/logic/automationEditing";
import { decimatePointsForViewport,
  pixelDeltaToBeats } from "@/screens/editor/timeline/automation/logic/automationCoordinates";
import { moveSelectedPoints } from "@/screens/editor/timeline/automation/logic/automationSelection";
import type { AutomationPointViewModel } from "@/screens/editor/timeline/automation/logic/types";

const point = (timeBeats: number, value: number, curve = 0): AutomationPointViewModel =>
  ({ timeBeats, value, curve });

describe("automation editing operations", () => {
  it("uses signed musical displacement for a leftward drag", () => {
    expect(pixelDeltaToBeats(-100, 120, 100)).toBe(-2);
    expect(pixelDeltaToBeats(100, 120, 100)).toBe(2);
    expect(pixelDeltaToBeats(NaN, 120, 100)).toBe(0);
  });

  it("clamps a group as a whole, preserving pitch-independent value offsets", () => {
    const points = [point(0, 0.1), point(2, 0.4), point(4, 0.9)];
    const moved = moveSelectedPoints(points, new Set([1, 2]), 0, 0.3);
    expect(moved[1].value).toBeCloseTo(0.5);
    expect(moved[2].value).toBe(1);
    expect(moved[0]).toEqual(points[0]);
    expect(moveSelectedPoints(points, new Set([99]), 1, 1)).toBe(points);
  });

  it("replaces only a drawn span while retaining outside points and curvature", () => {
    const original = [point(0, 0.2, -0.5), point(2, 0.8, 0.75), point(4, 0.2, 0.5), point(8, 0.7)];
    const stroke = [point(3, 0.5), point(1, 0.4)];
    const result = replaceAutomationStroke(original, stroke);
    expect(result).toEqual([original[0], stroke[1], stroke[0], original[2], original[3]]);
    expect(original[1].curve).toBe(0.75);
    expect(replaceAutomationStroke(original, [])).toBe(original);
  });

  it("smooths selected interior values and fixes each run's boundary anchors", () => {
    const points = [point(0, 0), point(1, 1), point(2, 0), point(3, 0.7), point(4, 0.3)];
    const result = smoothAutomationSelection(points, new Set([0, 1, 2, 4]));
    expect(result[1].value).toBeLessThan(1);
    expect(result[1].value).toBeGreaterThan(0);
    expect(result[0]).toEqual(points[0]);
    expect(result[2]).toEqual(points[2]);
    expect(result[3]).toEqual(points[3]);
    expect(result[4]).toEqual(points[4]);
    expect(result.map((entry) => entry.timeBeats)).toEqual(points.map((entry) => entry.timeBeats));
  });

  it("does not distort a linear ramp with uneven time spacing", () => {
    const points = [point(0, 0), point(1, 0.1), point(10, 1)];
    expect(smoothAutomationSelection(points, new Set([0, 1, 2]))).toEqual(points);
  });

  it("sets only the curves of selected segments and clamps curvature", () => {
    const points = [point(0, 0), point(2, 0.5), point(4, 1), point(6, 0)];
    const result = setAutomationSelectionCurve(points, new Set([1, 2]), 8);
    expect(result.map((entry) => entry.curve)).toEqual([0, 1, 0, 0]);
    expect(setAutomationSelectionCurve(points, new Set([0]), -1)[0].curve).toBe(-1);
    expect(setAutomationSelectionCurve(points, new Set([3]), 1)).toEqual(points);
  });

  it("reconciles float storage without accepting meaningfully different edits", () => {
    const points = [point(0.125, 0.7, 0.33)];
    expect(automationPointsEqual(points, [point(0.125, Math.fround(0.7), Math.fround(0.33))])).toBe(true);
    expect(automationPointsEqual(points, [point(0.126, 0.7, 0.33)])).toBe(false);
    expect(automationPointsEqual(points, [])).toBe(false);
  });
});

describe("automation viewport budget", () => {
  const dense = Array.from({ length: 2000 }, (_, index) => point(index / 10, index % 2));

  it("has a strict budget even when every sample is an extremum", () => {
    const visible = decimatePointsForViewport(dense, 120, 100, 0, 10000, 40);
    expect(visible).toHaveLength(40);
    expect(visible[0]).toBe(dense[0]);
    expect(visible[visible.length - 1]).toBe(dense[dense.length - 1]);
  });

  it("retains the constant tail or head when all points are outside the view", () => {
    expect(decimatePointsForViewport(dense, 120, 100, 20000, 21000, 40)).toEqual([dense[dense.length - 1]]);
    const shifted = dense.map((entry) => ({ ...entry, timeBeats: entry.timeBeats + 200 }));
    expect(decimatePointsForViewport(shifted, 120, 100, 0, 500, 40)).toEqual([shifted[0]]);
  });
});
