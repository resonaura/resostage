// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { describe, expect, it } from "vitest";
import { recordTempoTap } from "@/transport/logic/tapTempo";

describe("tap tempo", () => {
  it("waits for a second tap and computes BPM from the interval", () => {
    expect(recordTempoTap([], 1000)).toEqual({ times: [1000] });
    expect(recordTempoTap([1000], 1500)).toEqual({
      times: [1000, 1500],
      bpm: 120,
    });
  });

  it("uses the median of recent taps and retains only six timestamps", () => {
    const result = recordTempoTap([0, 500, 1010, 1500, 2000, 2500], 3000);
    expect(result.times).toEqual([500, 1010, 1500, 2000, 2500, 3000]);
    expect(result.bpm).toBe(120);
  });

  it("starts a new run after an idle gap and ignores implausible intervals", () => {
    expect(recordTempoTap([0, 500], 3000)).toEqual({ times: [3000] });
    expect(recordTempoTap([100, 200], 220)).toEqual({
      times: [100, 200, 220],
    });
  });
});
