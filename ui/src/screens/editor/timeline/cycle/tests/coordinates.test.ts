/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { createPianoRollProjectAxis } from "@/screens/editor/pianoroll/logic/projectAxis";
import { moveCycleRangeOnAxis } from "@/screens/editor/timeline/cycle/logic/coordinates";

const axis = createPianoRollProjectAxis({
  bpm: 120,
  tempoPoints: [
    { beat: 0, bpm: 120, timeSeconds: 0, curve: 0 },
    { beat: 4, bpm: 60, timeSeconds: 2, curve: 0 },
  ],
});

describe("moveCycleRangeOnAxis", () => {
  it("preserves musical span while the seconds-per-beat changes", () => {
    const moved = moveCycleRangeOnAxis({
      leftSeconds: 0,
      rightSeconds: 2,
      deltaCoordinate: 2,
      songLengthSeconds: 8,
      timeToCoordinate: axis.secondsToBeats,
      coordinateToTime: axis.beatsToSeconds,
    });
    expect(moved.left).toBeCloseTo(1);
    expect(moved.right).toBeCloseTo(4);
    expect(axis.secondsToBeats(moved.right) - axis.secondsToBeats(moved.left)).toBeCloseTo(4);
  });

  it("snaps in project beats and clamps at project boundaries", () => {
    const moved = moveCycleRangeOnAxis({
      leftSeconds: 1,
      rightSeconds: 4,
      deltaCoordinate: 0.13,
      songLengthSeconds: 8,
      timeToCoordinate: axis.secondsToBeats,
      coordinateToTime: axis.beatsToSeconds,
      snapTime: (seconds) => axis.snapSeconds(seconds, 0.25),
    });
    expect(axis.secondsToBeats(moved.left)).toBeCloseTo(2.25);
    expect(axis.secondsToBeats(moved.right) - axis.secondsToBeats(moved.left)).toBeCloseTo(4);

    const clamped = moveCycleRangeOnAxis({
      leftSeconds: 4,
      rightSeconds: 6,
      deltaCoordinate: 10,
      songLengthSeconds: 8,
      timeToCoordinate: axis.secondsToBeats,
      coordinateToTime: axis.beatsToSeconds,
    });
    expect(clamped.left).toBeCloseTo(6);
    expect(clamped.right).toBeCloseTo(8);
  });

  it("retains the existing uniform-seconds behavior for the arrangement timeline", () => {
    const moved = moveCycleRangeOnAxis({
      leftSeconds: 2,
      rightSeconds: 4,
      deltaCoordinate: 1.5,
      songLengthSeconds: 8,
      timeToCoordinate: (seconds) => seconds,
      coordinateToTime: (coordinate) => coordinate,
    });
    expect(moved).toEqual({ left: 3.5, right: 5.5 });
  });
});
