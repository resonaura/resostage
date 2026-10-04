/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { ImportedMidiFile } from "@/lib/midi/standardMidiFile";
import {
  assertMidiBatchContentItemLimit,
  countMidiContentItems,
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

  it("uses the same explicit retained-item ceiling as one parsed file", () => {
    expect(MAX_MIDI_BATCH_CONTENT_ITEMS).toBe(200_000);
    expect(() => assertMidiBatchContentItemLimit(MAX_MIDI_BATCH_CONTENT_ITEMS)).not.toThrow();
    expect(() => assertMidiBatchContentItemLimit(MAX_MIDI_BATCH_CONTENT_ITEMS + 1)).toThrow(/smaller batch/);
  });
});
