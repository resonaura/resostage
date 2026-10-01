/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { emptyState, type SongRow } from "@/lib/state/types";
import {
  formatBytes,
  formatDuration,
  resolveRange,
  songDuration,
} from "@/transfer/render/logic/renderModel";

function createSong(overrides: Partial<SongRow> = {}): SongRow {
  return {
    name: "Song",
    bpm: 120,
    mode: "auto",
    tsNum: 4,
    tsDen: 4,
    click: false,
    clickBusId: "",
    clickSends: [],
    events: [],
    ...overrides,
  };
}

describe("audio render model", () => {
  it("uses the authored song end before deriving a range from content", () => {
    const song = createSong({
      endSeconds: 24,
      regions: [
        {
          id: "region",
          trackId: "audio::track:1",
          startSeconds: 2,
          durationSeconds: 8,
          gainDb: 0,
          source: { file: "audio.wav", offsetSeconds: 0 },
        },
      ],
    });

    expect(songDuration(song)).toBe(24);
  });

  it("derives song length from audio, events, and tempo-mapped MIDI content", () => {
    const audioAndEvents = createSong({
      regions: [
        {
          id: "region",
          trackId: "audio::track:1",
          startSeconds: 1,
          durationSeconds: 2,
          gainDb: 0,
          source: { file: "audio.wav", offsetSeconds: 0 },
        },
      ],
      events: [
        {
          id: "event",
          type: "http",
          timeSeconds: 5,
          triggerOnLoad: false,
          latencyMs: 0,
          midiChannel: 0,
          midiProgram: 0,
          midiCC: 0,
          midiCCValue: 0,
          midiNote: 0,
          midiVelocity: 0,
          httpUrl: "",
        },
      ],
    });
    const midi = createSong({
      bpm: 120,
      tempoPoints: [
        { beat: 0, bpm: 120, timeSeconds: 0, curve: 0 },
        { beat: 4, bpm: 60, timeSeconds: 2, curve: 0 },
      ],
      midiRegions: [
        {
          id: "midi",
          trackId: "audio::track:2",
          name: "MIDI",
          startBeats: 4,
          durationBeats: 4,
          clipOffsetBeats: 0,
          loop: false,
          loopLengthBeats: 0,
          notes: [],
        },
      ],
    });

    expect(songDuration(audioAndEvents)).toBe(5);
    expect(songDuration(midi)).toBe(6);
    expect(songDuration(undefined)).toBe(0);
  });

  it("resolves song, cycle, and bounded custom ranges", () => {
    const state = {
      ...emptyState,
      cycle: {
        active: true,
        skip: false,
        startSeconds: 3,
        endSeconds: 9,
        songIndex: 1,
      },
    };

    expect(resolveRange("song", 20, state, 1, "0", "0")).toEqual({
      start: 0,
      end: 20,
    });
    expect(resolveRange("cycle", 20, state, 1, "0", "0")).toEqual({
      start: 3,
      end: 9,
    });
    expect(resolveRange("cycle", 20, state, 0, "0", "0")).toEqual({
      start: 0,
      end: 20,
    });
    expect(resolveRange("custom", 20, state, 1, "-4", "28")).toEqual({
      start: 0,
      end: 20,
    });
  });

  it("formats durations and output-size estimates consistently", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(-1)).toBe("0:00");
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(1024 ** 2)).toBe("1 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });
});
