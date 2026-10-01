/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { midiRegionPlacementAt } from "@/screens/editor/timeline/regions/logic/midiRegionPlacement";

describe("MIDI pencil placement", () => {
  it("snaps the start and creates one bar in 4/4", () => {
    expect(midiRegionPlacementAt(1.12, 20, 120, 4, 100, true)).toEqual({
      startBeats: 2,
      durationBeats: 4,
    });
  });

  it("uses the song signature and clips the region at the song end", () => {
    expect(midiRegionPlacementAt(9, 10, 60, 3, 100, false)).toEqual({
      startBeats: 9,
      durationBeats: 1,
    });
  });
});
