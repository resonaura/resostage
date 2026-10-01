/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { barBeat, globalBarBeat } from "@/screens/player/logic/timeDisplay";

describe("player time display", () => {
  it("formats song-local seconds as one-based bars and beats", () => {
    expect(barBeat(0, 120, 4)).toBe("1 | 1");
    expect(barBeat(1.5, 120, 4)).toBe("1 | 4");
    expect(barBeat(2, 120, 4)).toBe("2 | 1");
  });

  it("formats accumulated project beats and rejects invalid positions", () => {
    expect(globalBarBeat(0, 4)).toBe("1 | 1");
    expect(globalBarBeat(4, 4)).toBe("2 | 1");
    expect(globalBarBeat(7.9, 4)).toBe("2 | 4");
    expect(globalBarBeat(Number.NaN, 4)).toBe("—");
    expect(globalBarBeat(-1, 4)).toBe("—");
    expect(globalBarBeat(0, 0)).toBe("—");
    expect(barBeat(-0.1, 120, 4)).toBe("—");
    expect(barBeat(1, 0, 4)).toBe("—");
  });
});
