/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { createPianoRollProjectAxis } from "@/screens/editor/pianoroll/logic/projectAxis";

describe("Piano Roll project axis", () => {
  const axis = createPianoRollProjectAxis({
    bpm: 120,
    tempoPoints: [
      { beat: 0, bpm: 120, timeSeconds: 0, curve: 0 },
      { beat: 4, bpm: 60, timeSeconds: 2, curve: 0 },
    ],
  });

  it("maps the project header and cycle seconds through tempo changes", () => {
    expect(axis.durationBeats(6)).toBeCloseTo(8);
    expect(axis.secondsToBeats(4)).toBeCloseTo(6);
    expect(axis.beatsToSeconds(6)).toBeCloseTo(4);
  });

  it("snaps cycle time to the Piano Roll beat grid across tempo changes", () => {
    expect(axis.snapSeconds(2.37, 0.25)).toBeCloseTo(2.25);
    expect(axis.snapSeconds(2.37, 0)).toBe(2.37);
    expect(axis.snapSeconds(Number.NaN, 0.25)).toBeNaN();
  });
});
