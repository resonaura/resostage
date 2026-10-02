/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { builder } from "@/lib/state/api";
import type { SongRow } from "@/lib/state/types";
import {
  deleteSelectedRegions,
  resolveSelectedRegions,
  splitRegionsAtPlayhead,
} from "@/screens/editor/timeline/regions/logic/regionEdit";
import { regionSelKey } from "@/screens/editor/timeline/regions/logic/regionUtils";

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
      loopStartBeats: 0,
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
      loopStartBeats: 0,
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
        loopStartBeats: 0,
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

  it("splits automation lanes with exact boundary points on both halves", async () => {
    const songWithAuto: SongRow = {
      ...midiSong,
      midiRegions: [
        {
          ...midiSong.midiRegions![0],
          automationLanes: [
            {
              id: "auto-1",
              target: {
                domain: "midiCC",
                entityId: "track-1",
                parameterId: "cc:1",
                valueType: "integer",
                defaultValue: 0,
                minValue: 0,
                maxValue: 127,
              },
              scope: "region",
              writeMode: "read",
              enabled: true,
              muted: false,
              points: [
                { timeBeats: 0, value: 0, curve: 0 },
                { timeBeats: 8, value: 100, curve: 0 },
              ],
            },
          ],
        },
      ],
    };

    const update = vi
      .spyOn(builder, "midiRegionUpdate")
      .mockResolvedValue({} as never);
    const add = vi
      .spyOn(builder, "midiRegionAdd")
      .mockResolvedValue({} as never);

    // Split at playhead = 4s (8 beats at 120 bpm; region starts at 4 beats, so splitBeats = 4)
    await splitRegionsAtPlayhead(
      [regionSelKey(0, "midi-1")],
      [songWithAuto],
      [0],
      [30],
      4,
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        regionId: "midi-1",
        automationLanes: expect.arrayContaining([
          expect.objectContaining({
            id: "auto-1",
            points: expect.arrayContaining([
              { timeBeats: 0, value: 0, curve: 0 },
              { timeBeats: 4, value: 50, curve: 0 },
            ]),
          }),
        ]),
      }),
    );

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        automationLanes: expect.arrayContaining([
          expect.objectContaining({
            points: expect.arrayContaining([
              { timeBeats: 0, value: 50, curve: 0 },
              { timeBeats: 4, value: 100, curve: 0 },
            ]),
          }),
        ]),
      }),
    );
  });
});
