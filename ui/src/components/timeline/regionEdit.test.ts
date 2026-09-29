import { afterEach, describe, expect, it, vi } from "vitest";
import { builder } from "../../lib/state/api";
import type { SongRow } from "../../lib/state/types";
import {
  deleteSelectedRegions,
  resolveSelectedRegions,
  splitRegionsAtPlayhead,
} from "./regionEdit";
import { regionSelKey } from "./regionUtils";

const midiSong = {
  bpm: 120,
  midiRegions: [
    {
      id: "midi-1",
      trackId: "track-1",
      name: "Verse",
      startBeats: 4,
      durationBeats: 8,
      clipOffsetBeats: 1,
      loop: true,
      loopLengthBeats: 4,
      muted: false,
      color: "#8844ff",
      notes: [
        {
          id: 42,
          pitch: 64,
          startBeats: 1,
          durationBeats: 2,
          velocity: 0.75,
          releaseVelocity: 0.5,
          probability: 1,
        },
      ],
      events: [
        { beat: 1, status: 0xb0, data: [64, 127] },
        { beat: 3, status: 0xb0, data: [64, 0] },
      ],
      umpEvents: [{ beat: 2, words: [0x40903c80, 0, 0, 0], wordCount: 1 }],
      automationLanes: [],
    },
  ],
  regions: [],
} as unknown as SongRow;

afterEach(() => vi.restoreAllMocks());

describe("MIDI region timeline editing", () => {
  it("copies the complete MIDI source instead of an empty shell", () => {
    const [entry] = resolveSelectedRegions(
      [regionSelKey(0, "midi-1")],
      [midiSong],
    );
    expect(entry).toMatchObject({
      kind: "midi",
      startSeconds: 2,
      clipOffsetBeats: 1,
      loop: true,
      loopLengthBeats: 4,
    });
    if (entry.kind !== "midi") throw new Error("expected MIDI clipboard entry");
    expect(entry.notes).toEqual(midiSong.midiRegions![0].notes);
    expect(entry.notes).not.toBe(midiSong.midiRegions![0].notes);
    expect(entry.events).toEqual(midiSong.midiRegions![0].events);
    expect(entry.umpEvents).toEqual(midiSong.midiRegions![0].umpEvents);
  });

  it("splits by changing the source offset while retaining notes and loop data", async () => {
    const update = vi
      .spyOn(builder, "midiRegionUpdate")
      .mockResolvedValue({} as never);
    const add = vi
      .spyOn(builder, "midiRegionAdd")
      .mockResolvedValue({} as never);

    const count = await splitRegionsAtPlayhead(
      [regionSelKey(0, "midi-1")],
      [midiSong],
      [0],
      [30],
      4,
    );

    expect(count).toBe(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "midi-1", durationBeats: 4 }),
    );
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        startBeats: 8,
        durationBeats: 4,
        clipOffsetBeats: 5,
        loop: true,
        loopLengthBeats: 4,
        notes: midiSong.midiRegions![0].notes,
        events: midiSong.midiRegions![0].events,
        umpEvents: midiSong.midiRegions![0].umpEvents,
      }),
    );
  });

  it("routes delete to the MIDI endpoint", () => {
    const remove = vi
      .spyOn(builder, "midiRegionRemove")
      .mockResolvedValue({} as never);
    deleteSelectedRegions([regionSelKey(0, "midi-1")], [midiSong]);
    expect(remove).toHaveBeenCalledWith(0, "midi-1", expect.any(String));
  });
});
