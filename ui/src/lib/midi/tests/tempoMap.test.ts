/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { createSongTempoMap } from "@/lib/midi/tempoMap";

describe("song tempo map", () => {
  it("round-trips a constant tempo and extrapolates pre-roll", () => {
    const map = createSongTempoMap({ bpm: 120, tempoPoints: [] });
    expect(map.beatsToSeconds(8)).toBeCloseTo(4, 10);
    expect(map.secondsToBeats(4)).toBeCloseTo(8, 10);
    expect(map.secondsToBeats(-0.5)).toBeCloseTo(-1, 10);
  });

  it("uses the song BPM before the first authored tempo point", () => {
    const map = createSongTempoMap({
      bpm: 120,
      tempoPoints: [{ beat: 4, bpm: 60, timeSeconds: 0, curve: 0 }],
    });
    expect(map.beatsToSeconds(4)).toBeCloseTo(2, 10);
    expect(map.beatsToSeconds(8)).toBeCloseTo(6, 10);
    expect(map.secondsToBeats(3.5)).toBeCloseTo(5.5, 10);
  });

  it("round-trips through a linear BPM ramp with Core's logarithmic timing", () => {
    const map = createSongTempoMap({
      bpm: 120,
      tempoPoints: [
        { beat: 0, bpm: 120, timeSeconds: 0, curve: 1 },
        { beat: 4, bpm: 60, timeSeconds: 0, curve: 0 },
      ],
    });
    const rampEndSeconds = 4 * Math.log(2);
    expect(map.beatsToSeconds(4)).toBeCloseTo(rampEndSeconds, 10);
    expect(map.secondsToBeats(rampEndSeconds)).toBeCloseTo(4, 10);
    expect(map.secondsToBeats(map.beatsToSeconds(2.375))).toBeCloseTo(2.375, 9);
  });

  it("uses the last tempo point at a duplicate beat, like Core's upper-bound lookup", () => {
    const map = createSongTempoMap({
      bpm: 120,
      tempoPoints: [
        { beat: 0, bpm: 90, timeSeconds: 0, curve: 0 },
        { beat: 0, bpm: 60, timeSeconds: 0, curve: 0 },
      ],
    });
    expect(map.beatsToSeconds(2)).toBeCloseTo(2, 10);
    expect(map.secondsToBeats(2)).toBeCloseTo(2, 10);
  });
});
