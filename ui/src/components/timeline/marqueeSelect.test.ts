import { describe, expect, it } from "vitest";
import type { SongRow } from "../../lib/state/types";
import { marqueeHitRegions } from "./marqueeSelect";

describe("timeline region marquee", () => {
  it("selects MIDI regions using beat placement and the song tempo", () => {
    const song = {
      bpm: 120,
      regions: [],
      midiRegions: [
        {
          id: "midi-1",
          trackId: "track-1",
          name: "Pattern",
          startBeats: 4,
          durationBeats: 8,
          clipOffsetBeats: 0,
          loop: false,
          loopLengthBeats: 8,
          notes: [],
        },
      ],
    } as unknown as SongRow;

    expect(
      marqueeHitRegions(
        { left: 19, top: 0, width: 5, height: 40 },
        [{ name: "Instrument", color: "#00ff00", headerIndex: 0 }],
        [song],
        [0],
        [30],
        10,
        40,
        [{ id: "track-1", name: "Instrument" }],
      ),
    ).toEqual(["0:midi-1"]);
  });

  it("does not select a MIDI region from another track lane", () => {
    const song = {
      bpm: 120,
      regions: [],
      midiRegions: [
        {
          id: "midi-1",
          trackId: "track-2",
          name: "Other Pattern",
          startBeats: 0,
          durationBeats: 8,
          clipOffsetBeats: 0,
          loop: false,
          loopLengthBeats: 8,
          notes: [],
        },
      ],
    } as unknown as SongRow;

    expect(
      marqueeHitRegions(
        { left: 0, top: 0, width: 100, height: 40 },
        [{ name: "Instrument", color: "#00ff00", headerIndex: 0 }],
        [song],
        [0],
        [30],
        10,
        40,
        [{ id: "track-1", name: "Instrument" }],
      ),
    ).toEqual([]);
  });
});
