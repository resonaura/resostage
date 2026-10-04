/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  samePianoRollUmpControllerSelection,
  selectPianoRollUmpMarqueeCandidates,
} from "@/screens/editor/pianoroll/logic/umpControllerMarquee";

const points = [
  { sourceEventIndex: 4, x: 100, y: 200 },
  { sourceEventIndex: 7, x: 150, y: 250 },
  { sourceEventIndex: 9, x: 201, y: 250 },
  { sourceEventIndex: 11, x: 150, y: 261 },
];

describe("Piano Roll UMP controller marquee", () => {
  it("selects points inside a rectangle in either drag direction", () => {
    expect([...selectPianoRollUmpMarqueeCandidates(points, 160, 260, 90, 190)].sort())
      .toEqual([4, 7]);
    expect([...selectPianoRollUmpMarqueeCandidates(points, 90, 190, 160, 260)].sort())
      .toEqual([4, 7]);
  });

  it("adds enclosed points to the selection captured at pointer-down", () => {
    const selected = selectPianoRollUmpMarqueeCandidates(
      points, 90, 190, 160, 260, new Set([99]),
    );
    expect([...selected].sort((left, right) => left - right)).toEqual([4, 7, 99]);
  });

  it("includes rectangle edges and deduplicates repeated loop occurrences", () => {
    const repeated = [...points.slice(0, 1), { ...points[0] }];
    expect([...selectPianoRollUmpMarqueeCandidates(repeated, 100, 200, 100, 200)])
      .toEqual([4]);
  });

  it("ignores invalid projected coordinates and fails closed on oversized candidates", () => {
    const invalid = [{ sourceEventIndex: 1, x: Number.NaN, y: 3 }, ...points];
    expect([...selectPianoRollUmpMarqueeCandidates(invalid, 0, 0, 500, 500)]).toEqual([4, 7, 9, 11]);
    expect([...selectPianoRollUmpMarqueeCandidates(
      Array(12_001).fill(points[0]), 0, 0, 500, 500, new Set([88]),
    )]).toEqual([88]);
  });

  it("compares source-index selection without depending on insertion order", () => {
    expect(samePianoRollUmpControllerSelection(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(samePianoRollUmpControllerSelection(new Set([1]), new Set([2]))).toBe(false);
  });
});
