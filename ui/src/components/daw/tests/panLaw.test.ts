// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { describe, expect, it } from "vitest";
import { formatPan, TRACK_PAN_LAWS } from "@/components/daw/logic/panLaw";

describe("formatPan", () => {
  it("uses center notation for values within the dead zone", () => {
    expect(formatPan(0)).toBe("C");
    expect(formatPan(0.049)).toBe("C");
    expect(formatPan(-0.049)).toBe("C");
  });

  it("formats left and right positions as percentages", () => {
    expect(formatPan(-1)).toBe("L100");
    expect(formatPan(-0.5)).toBe("L50");
    expect(formatPan(0.5)).toBe("R50");
    expect(formatPan(1)).toBe("R100");
  });
});

describe("TRACK_PAN_LAWS", () => {
  it("keeps legacy balance as the first and default law", () => {
    expect(TRACK_PAN_LAWS[0]).toEqual({
      id: 0,
      value: "0dB",
      label: "0 dB · Legacy balance",
    });
  });
});
