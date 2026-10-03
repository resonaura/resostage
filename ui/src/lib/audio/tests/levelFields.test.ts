/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { sameExceptLevels } from "@/lib/audio/levelFields";

describe("telemetry row comparisons", () => {
  it("ignores meter-only changes but keeps automation values render-significant", () => {
    const previous = {
      peakDb: -12,
      automatedGainDb: null as number | null,
      automatedPan: null as number | null,
    };
    expect(sameExceptLevels(previous, {
      ...previous,
      peakDb: -6,
    })).toBe(true);
    expect(sameExceptLevels(previous, {
      ...previous,
      automatedGainDb: -9,
    })).toBe(false);
    expect(sameExceptLevels(previous, {
      ...previous,
      automatedPan: 0.25,
    })).toBe(false);
  });
});
