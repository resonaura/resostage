/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  adjustCurvature,
  insertAutomationPoint,
  moveSegment,
  moveSelectedPoints,
  removeAutomationPoints,
  selectPointsInRect,
  selectRangePoints,
  toggleSelectPoint,
} from "../automationSelection";
import type { AutomationPointViewModel } from "../types";

describe("automationSelection", () => {
  it("toggles single and multi-selection correctly", () => {
    let sel = new Set<number>();
    sel = toggleSelectPoint(sel, 2, false);
    expect(Array.from(sel)).toEqual([2]);

    // Single select switches to new point
    sel = toggleSelectPoint(sel, 5, false);
    expect(Array.from(sel)).toEqual([5]);

    // Multi-select adds
    sel = toggleSelectPoint(sel, 1, true);
    expect(Array.from(sel).sort()).toEqual([1, 5]);

    // Multi-select toggles off
    sel = toggleSelectPoint(sel, 5, true);
    expect(Array.from(sel)).toEqual([1]);
  });

  it("selects range contiguous points", () => {
    const sel = selectRangePoints(new Set([0]), 2, 5);
    expect(Array.from(sel).sort()).toEqual([0, 2, 3, 4, 5]);
  });

  it("selects points in bounding rectangle", () => {
    const points: AutomationPointViewModel[] = [
      { timeBeats: 0, value: 0, curve: 0 },
      { timeBeats: 2, value: 0.5, curve: 0 }, // x=100, y=50
      { timeBeats: 4, value: 1.0, curve: 0 }, // x=200, y=0
    ];

    const inRect = selectPointsInRect(
      points,
      120,
      100,
      100,
      { left: 50, top: 20, right: 150, bottom: 80 },
    );
    expect(Array.from(inRect)).toEqual([1]);
  });

  it("moves selected points without reversing order or crossing neighbors", () => {
    const points: AutomationPointViewModel[] = [
      { timeBeats: 0, value: 0.2, curve: 0 },
      { timeBeats: 2, value: 0.4, curve: 0 },
      { timeBeats: 6, value: 0.6, curve: 0 },
      { timeBeats: 10, value: 0.8, curve: 0 },
    ];

    // Move index 1 (beat 2) by +5 beats. Neighbor is at beat 6, so it cannot cross 6!
    const moved = moveSelectedPoints(points, new Set([1]), 5, 0.1);
    expect(moved[1].timeBeats).toBeLessThan(6);
    expect(moved[1].timeBeats).toBeGreaterThanOrEqual(2);
    expect(moved[1].value).toBeCloseTo(0.5, 4);

    // Cannot move earlier than 0
    const movedBack = moveSelectedPoints(points, new Set([0]), -5, 0);
    expect(movedBack[0].timeBeats).toBe(0);
  });

  it("moves a segment vertically", () => {
    const points: AutomationPointViewModel[] = [
      { timeBeats: 0, value: 0.2, curve: 0 },
      { timeBeats: 4, value: 0.2, curve: 0 },
    ];
    const moved = moveSegment(points, 0, 1, 0.3);
    expect(moved[0].value).toBeCloseTo(0.5, 4);
    expect(moved[1].value).toBeCloseTo(0.5, 4);
  });

  it("adjusts curvature within [-1, 1]", () => {
    const points: AutomationPointViewModel[] = [
      { timeBeats: 0, value: 0.2, curve: 0 },
      { timeBeats: 4, value: 0.8, curve: 0 },
    ];
    let adjusted = adjustCurvature(points, 0, 0.5);
    expect(adjusted[0].curve).toBeCloseTo(0.5, 4);

    adjusted = adjustCurvature(adjusted, 0, 1.0);
    expect(adjusted[0].curve).toBe(1.0); // clamped at 1.0
  });

  it("inserts points stably and updates existing if at identical beat", () => {
    const points: AutomationPointViewModel[] = [
      { timeBeats: 0, value: 0.2, curve: 0 },
      { timeBeats: 4, value: 0.8, curve: 0 },
    ];

    const { points: pAfterInsert, insertedIndex } = insertAutomationPoint(
      points,
      2,
      0.5,
    );
    expect(pAfterInsert.length).toBe(3);
    expect(insertedIndex).toBe(1);
    expect(pAfterInsert[1].timeBeats).toBe(2);

    // Updating existing point at beat 2
    const { points: pUpdated, insertedIndex: updatedIndex } =
      insertAutomationPoint(pAfterInsert, 2, 0.9);
    expect(pUpdated.length).toBe(3);
    expect(updatedIndex).toBe(1);
    expect(pUpdated[1].value).toBe(0.9);
  });

  it("removes specified points", () => {
    const points: AutomationPointViewModel[] = [
      { timeBeats: 0, value: 0.2, curve: 0 },
      { timeBeats: 2, value: 0.5, curve: 0 },
      { timeBeats: 4, value: 0.8, curve: 0 },
    ];
    const remaining = removeAutomationPoints(points, [1]);
    expect(remaining.length).toBe(2);
    expect(remaining.map((p) => p.timeBeats)).toEqual([0, 4]);
  });

  it("handles tightly pinned points without reversing or crashing", () => {
    const points: AutomationPointViewModel[] = [
      { timeBeats: 1.0, value: 0.2, curve: 0 },
      { timeBeats: 1.00005, value: 0.5, curve: 0 },
      { timeBeats: 1.0001, value: 0.8, curve: 0 },
    ];
    // Move middle point with extreme tight bounds
    const moved = moveSelectedPoints(points, new Set([1]), 1.0, 0);
    expect(Number.isFinite(moved[1].timeBeats)).toBe(true);
    expect(moved[1].timeBeats).toBeGreaterThanOrEqual(1.0);
    expect(moved[1].timeBeats).toBeLessThanOrEqual(1.0001);
  });
});
