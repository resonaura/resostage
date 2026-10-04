/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { buildImportedSongTiming } from "@/transfer/midi/logic/importTiming";

describe("MIDI import tempo and meter map", () => {
  it("uses Standard MIDI defaults when the selected sequence has no initial map", () => {
    const timing = buildImportedSongTiming([], []);

    expect(timing.bpm).toBe(120);
    expect(timing.tempoPoints[0]).toMatchObject({ beat: 0, bpm: 120, timeSeconds: 0 });
    expect(timing.signaturePoints[0]).toMatchObject({ beat: 0, numerator: 4, denominator: 4, bar: 1 });
  });

  it("does not promote a later change to the song's initial tempo or signature", () => {
    const timing = buildImportedSongTiming(
      [{ beat: 4, bpm: 90 }],
      [{ beat: 4, numerator: 3, denominator: 4 }],
    );

    expect(timing.bpm).toBe(120);
    expect(timing.tempoPoints.map(({ beat, bpm }) => [beat, bpm])).toEqual([[0, 120], [4, 90]]);
    expect(timing.signaturePoints.map(({ beat, numerator, denominator, bar }) =>
      [beat, numerator, denominator, bar])).toEqual([[0, 4, 4, 1], [4, 3, 4, 2]]);
  });

  it("uses the selected sequence's beat-zero changes", () => {
    const timing = buildImportedSongTiming(
      [{ beat: 0, bpm: 80 }, { beat: 4, bpm: 100 }],
      [{ beat: 0, numerator: 7, denominator: 8 }],
    );

    expect(timing.bpm).toBe(80);
    expect(timing.tempoPoints[0].timeSeconds).toBe(0);
    expect(timing.signaturePoints[0]).toMatchObject({ numerator: 7, denominator: 8, bar: 1 });
  });
});
