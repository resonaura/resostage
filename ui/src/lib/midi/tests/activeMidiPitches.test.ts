// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { describe, expect, it } from "vitest";
import type { MidiRegionRow, WebUiState } from "@/lib/state/types";
import { getActiveMidiPitches } from "@/lib/midi/activeMidiPitches";

function midiRegion(
  id: string,
  trackId: string,
  pitch: number,
): MidiRegionRow {
  return {
    id,
    trackId,
    name: id,
    startBeats: 0,
    durationBeats: 4,
    clipOffsetBeats: 0,
    loop: false,
    loopLengthBeats: 4,
    notes: [
      {
        id: 1,
        pitch,
        startBeats: 0,
        durationBeats: 4,
        velocity: 100,
        releaseVelocity: 0,
        probability: 1,
      },
    ],
  };
}

describe("getActiveMidiPitches", () => {
  it("projects sequenced, routed, and recording notes for only the focused track", () => {
    const state = {
      playing: true,
      bpm: 120,
      songIndex: 0,
      playheadSeconds: 0.5,
      songs: [
        {
          midiRegions: [
            midiRegion("one", "track-1", 60),
            midiRegion("two", "track-2", 72),
          ],
        },
      ],
      activeMidiNotes: [
        { trackId: "track-1", pitch: 61 },
        { trackId: "track-2", pitch: 73 },
      ],
      liveRecordings: [
        {
          trackId: "track-1",
          midiNotes: [{ pitch: 62, active: true }],
        },
        {
          trackId: "track-2",
          midiNotes: [{ pitch: 74, active: true }],
        },
      ],
    } as unknown as WebUiState;

    expect([...getActiveMidiPitches(state, "track-1")].sort()).toEqual([
      60, 61, 62,
    ]);
    expect([...getActiveMidiPitches(state, "track-2")].sort()).toEqual([
      72, 73, 74,
    ]);
  });

  it("stops previewing a loop note at the cropped source-window edge", () => {
    const cropped = {
      ...midiRegion("cropped", "track-1", 67),
      durationBeats: 8,
      clipOffsetBeats: 2,
      loop: true,
      loopStartBeats: 2,
      loopLengthBeats: 2,
      notes: [{
        id: 2,
        pitch: 67,
        startBeats: 3.5,
        durationBeats: 1,
        velocity: 100,
        releaseVelocity: 0,
        probability: 1,
      }],
    };
    const state = {
      playing: true,
      bpm: 120,
      songIndex: 0,
      playheadSeconds: 0.875, // 1.75 beats: source is 3.75, still in the note
      songs: [{ midiRegions: [cropped] }],
      activeMidiNotes: [],
      liveRecordings: [],
    } as unknown as WebUiState;
    expect([...getActiveMidiPitches(state, "track-1")]).toEqual([67]);

    const afterLoopEdge = { ...state, playheadSeconds: 1 } as WebUiState;
    expect([...getActiveMidiPitches(afterLoopEdge, "track-1")]).toEqual([]);
  });
});
