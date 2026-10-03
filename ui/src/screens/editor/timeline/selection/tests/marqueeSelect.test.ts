/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { SongRow } from "@/lib/state/types";
import {
  marqueeHitRegions,
  resolveMarqueeSelection,
} from "@/screens/editor/timeline/selection/logic/marqueeSelect";

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

  it("uses cumulative row offsets when automation pseudo-tracks expand a row", () => {
    const song = {
      bpm: 120,
      regions: [],
      midiRegions: [{
        id: "midi-2",
        trackId: "track-2",
        name: "Second Pattern",
        startBeats: 0,
        durationBeats: 8,
        clipOffsetBeats: 0,
        loop: false,
        loopLengthBeats: 8,
        notes: [],
      }],
    } as unknown as SongRow;

    expect(marqueeHitRegions(
      { left: 0, top: 125, width: 40, height: 5 },
      [
        { name: "Instrument", color: "#00ff00", headerIndex: 0 },
        { name: "Bass", color: "#0000ff", headerIndex: 1 },
      ],
      [song],
      [0],
      [30],
      10,
      56,
      [
        { id: "track-1", name: "Instrument" },
        { id: "track-2", name: "Bass" },
      ],
      [120, 56],
    )).toEqual(["0:midi-2"]);
  });

  it("merges additive region hits and clears cue selection", () => {
    const song = {
      bpm: 120,
      regions: [],
      midiRegions: [
        {
          id: "midi-1",
          trackId: "track-1",
          name: "Pattern",
          startBeats: 0,
          durationBeats: 4,
          clipOffsetBeats: 0,
          loop: false,
          loopLengthBeats: 4,
          notes: [],
        },
      ],
    } as unknown as SongRow;

    expect(
      resolveMarqueeSelection({
        mode: "audio",
        marquee: { left: 0, top: 0, width: 40, height: 40 },
        additive: true,
        baseCueKeys: [{ songIndex: 1, cueId: "old-cue" }],
        baseRegionKeys: ["2:old-region", "0:midi-1"],
        lightTrackIds: [],
        songs: [song],
        songOffsets: [0],
        songLengths: [30],
        pxPerSec: 10,
        laneHeight: 40,
        rows: [{ name: "Instrument", color: "#00ff00", headerIndex: 0 }],
        tracks: [{ id: "track-1", name: "Instrument" }],
      }),
    ).toEqual({
      cueKeys: [],
      selectedCue: null,
      regionKeys: ["2:old-region", "0:midi-1"],
    });
  });

  it("merges additive light-cue hits and clears region selection", () => {
    const song = {
      bpm: 120,
      regions: [],
      midiRegions: [],
      lightCues: [
        {
          id: "cue-1",
          trackId: "light-1",
          startSeconds: 1,
          durationSeconds: 2,
        },
      ],
    } as unknown as SongRow;

    expect(
      resolveMarqueeSelection({
        mode: "light",
        marquee: { left: 0, top: 0, width: 40, height: 40 },
        additive: true,
        baseCueKeys: [{ songIndex: 1, cueId: "old-cue" }],
        baseRegionKeys: ["2:old-region"],
        lightTrackIds: ["light-1"],
        songs: [song],
        songOffsets: [0],
        songLengths: [30],
        pxPerSec: 10,
        laneHeight: 40,
        rows: [],
        tracks: [],
      }),
    ).toEqual({
      cueKeys: [
        { songIndex: 1, cueId: "old-cue" },
        { songIndex: 0, cueId: "cue-1" },
      ],
      selectedCue: { songIndex: 0, cueId: "cue-1" },
      regionKeys: [],
    });
  });
});
