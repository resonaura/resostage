/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { ImportedMidiFile } from "@/lib/midi/standardMidiFile";
import {
  assertMidiBatchEventDataLimit,
  assertMidiBatchContentItemLimit,
  assertMidiRegionEventDataLimits,
  buildMidiRegionImportPatch,
  countMidiEventDataBytes,
  countMidiContentItems,
  MAX_MIDI_BATCH_EVENT_DATA_BYTES,
  MAX_MIDI_BATCH_CONTENT_ITEMS,
} from "@/transfer/midi/logic/importBatch";

describe("MIDI import batch bounds", () => {
  it("counts retained note, MIDI 1.0, and UMP items across tracks", () => {
    const midi: ImportedMidiFile = {
      format: 1,
      tracks: [
        { name: "Notes", notes: Array(2).fill({
          id: 1, pitch: 60, startBeats: 0, durationBeats: 1,
          velocity: 1, releaseVelocity: 0, probability: 1,
        }), events: [{ beat: 0, status: 0xb0, data: [1, 2] }], durationBeats: 1 },
        { name: "UMP", notes: [], umpEvents: [{ beat: 0, words: [0], wordCount: 1 }], durationBeats: 1 },
      ],
      tempoEvents: [],
      meterEvents: [],
    };

    expect(countMidiContentItems(midi)).toBe(4);
  });

  it("counts retained tempo and meter points in the aggregate batch budget", () => {
    const mapRows = {
      tempoEvents: [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 90 }],
      meterEvents: [{ beat: 0, numerator: 4, denominator: 4 }],
    };
    const emptyTrack = { name: "Timing", notes: [], durationBeats: 8 };

    expect(countMidiContentItems({
      format: 1,
      tracks: [{ ...emptyTrack, ...mapRows }],
      ...mapRows,
    })).toBe(3);
    expect(countMidiContentItems({
      format: 2,
      tracks: [{ ...emptyTrack, ...mapRows }],
      tempoEvents: [], meterEvents: [],
    })).toBe(3);
    expect(countMidiContentItems({
      format: "midi2-clip",
      tracks: [emptyTrack],
      ...mapRows,
    })).toBe(3);
  });

  it("uses the same explicit retained-item ceiling as one parsed file", () => {
    expect(MAX_MIDI_BATCH_CONTENT_ITEMS).toBe(200_000);
    expect(() => assertMidiBatchContentItemLimit(MAX_MIDI_BATCH_CONTENT_ITEMS)).not.toThrow();
    expect(() => assertMidiBatchContentItemLimit(MAX_MIDI_BATCH_CONTENT_ITEMS + 1)).toThrow(/smaller batch/);
  });

  it("bounds raw event byte retention and rejects payloads Core would drop", () => {
    const midi: ImportedMidiFile = {
      format: 1,
      tracks: [{
        name: "SysEx",
        notes: [],
        events: [{ beat: 0, status: 0xf0, data: [0x7d, 1, 0xf7] }],
        durationBeats: 1,
      }],
      tempoEvents: [],
      meterEvents: [],
    };

    expect(countMidiEventDataBytes(midi)).toBe(3);
    expect(() => assertMidiRegionEventDataLimits(midi.tracks, "test.mid")).not.toThrow();
    expect(MAX_MIDI_BATCH_EVENT_DATA_BYTES).toBe(8 * 1024 * 1024);
    expect(() => assertMidiBatchEventDataLimit(MAX_MIDI_BATCH_EVENT_DATA_BYTES)).not.toThrow();
    expect(() => assertMidiBatchEventDataLimit(MAX_MIDI_BATCH_EVENT_DATA_BYTES + 1)).toThrow(/smaller batch/);
    const oversizedTracks = [{
      ...midi.tracks[0],
      events: [{ beat: 0, status: 0xf0, data: Array(65_537).fill(0) }],
    }];
    expect(() => assertMidiRegionEventDataLimits(oversizedTracks, "oversized.mid"))
      .toThrow(/65,536-byte/);
  });

  it("preflights a complete region request against Core's HTTP collection cap", () => {
    const track = {
      name: "Dense MIDI 2",
      notes: Array.from({ length: 120_000 }, (_, id) => ({
        id,
        pitch: 60,
        startBeats: id / 4,
        durationBeats: 0.25,
        velocity: 0.5,
        releaseVelocity: 0.5,
        probability: 1,
        midi2: {
          group: 0,
          velocity: 0x8000,
          releaseVelocity: 0x8000,
          attributeType: 0,
          attributeData: 0,
          releaseAttributeType: 0,
          releaseAttributeData: 0,
          attackOrder: id * 2,
          releaseOrder: id * 2 + 1,
        },
      })),
      durationBeats: 30_000,
    };

    expect(() => buildMidiRegionImportPatch({
      songIndex: 0,
      trackId: "track-1",
      name: "Dense MIDI",
      sourceName: "dense.midi2",
      startBeats: 0,
      durationBeats: track.durationBeats,
      tracks: [track],
    })).toThrow(/16 MiB request limit/);
  });
});
