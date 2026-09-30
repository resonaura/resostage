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
