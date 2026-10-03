/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { SignaturePointRow } from "@/lib/state/types";
import { getMusicalRulerMarks } from "@/screens/editor/timeline/ruler/logic/beatGeometry";

const metricModulation: SignaturePointRow[] = [
  { beat: 0, numerator: 4, denominator: 4, bar: 1 },
  { beat: 16, numerator: 3, denominator: 4, bar: 5 },
  { beat: 22, numerator: 7, denominator: 8, bar: 7 },
];

describe("getMusicalRulerMarks", () => {
  it("keeps bar numbers and starts aligned through meter changes", () => {
    const marks = getMusicalRulerMarks({
      startBeat: 0,
      endBeat: 28,
      pixelsPerBeat: 80,
      defaultNumerator: 4,
      signaturePoints: metricModulation,
    }).filter((mark) => mark.major);

    expect(marks.map(({ beat, bar }) => [beat, bar])).toEqual([
      [0, 1], [4, 2], [8, 3], [12, 4], [16, 5], [19, 6], [22, 7], [25.5, 8],
    ]);
  });

  it("reduces major labels at low zoom while retaining actual meter bar starts", () => {
    const marks = getMusicalRulerMarks({
      startBeat: 0,
      endBeat: 24,
      pixelsPerBeat: 10,
      defaultNumerator: 4,
    }).filter((mark) => mark.major);

    expect(marks.map(({ beat, bar }) => [beat, bar])).toEqual([
      [0, 1], [8, 3], [16, 5], [24, 7],
    ]);
  });

  it("bounds dense mark generation and rejects invalid axes", () => {
    const marks = getMusicalRulerMarks({
      startBeat: 0,
      endBeat: 100,
      pixelsPerBeat: 400,
      defaultNumerator: 4,
      maxMarks: 12,
    });
    expect(marks).toHaveLength(12);
    expect(getMusicalRulerMarks({
      startBeat: 0,
      endBeat: 8,
      pixelsPerBeat: 0,
      defaultNumerator: 4,
    })).toEqual([]);
  });

  it("uses the project meter before its first explicit signature point", () => {
    const marks = getMusicalRulerMarks({
      startBeat: 0,
      endBeat: 8,
      pixelsPerBeat: 80,
      defaultNumerator: 3,
      signaturePoints: [{ beat: 6, numerator: 5, denominator: 4, bar: 3 }],
    }).filter((mark) => mark.major);

    expect(marks.map(({ beat, bar }) => [beat, bar])).toEqual([
      [0, 1], [3, 2], [6, 3],
    ]);
  });

  it("uses the project's default denominator when no signature point starts at zero", () => {
    const marks = getMusicalRulerMarks({
      startBeat: 0,
      endBeat: 6,
      pixelsPerBeat: 80,
      defaultNumerator: 6,
      defaultDenominator: 8,
    }).filter((mark) => mark.major);

    expect(marks.map(({ beat, bar }) => [beat, bar])).toEqual([
      [0, 1], [3, 2], [6, 3],
    ]);
  });
});
