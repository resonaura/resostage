/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { MidiNoteRow, MidiRegionRow } from "@/lib/state/types";
import { parseMidiClipFile, writeMidiClipFile } from "@/lib/midi/midiClipFile";

const HEADER = [..."SMF2CLIP"].map((character) => character.charCodeAt(0));
const dcs = (ticks: number) => [0x0040_0000 | ticks];
const dctpq = (ticksPerQuarter: number) => [0x0030_0000 | ticksPerQuarter];
const start = [0xf020_0000, 0, 0, 0];
const end = [0xf021_0000, 0, 0, 0];

function appendWord(bytes: number[], word: number): void {
  bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
}

function makeClip(packets: number[][]): Uint8Array {
  const bytes = [...HEADER];
  for (const packet of packets) for (const word of packet) appendWord(bytes, word >>> 0);
  return Uint8Array.from(bytes);
}

function framedClip(sequence: number[][]): Uint8Array {
  return makeClip([dcs(0), dctpq(960), dcs(0), start, ...sequence, dcs(0), end]);
}

const region: MidiRegionRow = {
  id: "region:clip-limit",
  trackId: "track:clip-limit",
  name: "Clip",
  startBeats: 0,
  durationBeats: 4,
  clipOffsetBeats: 0,
  loop: false,
  loopLengthBeats: 4,
  notes: [],
};

function note(id: number): MidiNoteRow {
  return {
    id,
    pitch: 60,
    startBeats: 0,
    durationBeats: 1,
    velocity: 0.8,
    releaseVelocity: 0,
    probability: 1,
  };
}

describe("MIDI Clip File framing and resource bounds", () => {
  it("applies shared DCS deltas cumulatively and preserves simultaneous presentation order", () => {
    const parsed = parseMidiClipFile(framedClip([
      dcs(120), [0x10f8_0000], [0x10fa_0000],
      dcs(120), [0x10fc_0000],
    ]));

    expect(parsed.tracks[0].umpEvents).toEqual([
      { beat: 0.125, words: [0x10f8_0000], wordCount: 1 },
      { beat: 0.125, words: [0x10fa_0000], wordCount: 1 },
      { beat: 0.25, words: [0x10fc_0000], wordCount: 1 },
    ]);
  });

  it("requires a single DCTPQ preceded by a zero-delta clockstamp", () => {
    const validFrame = [dcs(0), start, dcs(0), end];
    const invalid = [
      { packets: [...validFrame], message: /missing DCTPQ/ },
      { packets: [dcs(1), dctpq(960), ...validFrame.slice(1)], message: /zero Delta Clockstamp/ },
      { packets: [dctpq(960), ...validFrame], message: /zero Delta Clockstamp/ },
      { packets: [dcs(0), dctpq(960), dcs(0), dctpq(480), ...validFrame.slice(1)],
        message: /more than one DCTPQ/ },
      { packets: [dcs(0), dctpq(0), ...validFrame.slice(1)], message: /invalid zero DCTPQ/ },
    ];

    for (const fixture of invalid)
      expect(() => parseMidiClipFile(makeClip(fixture.packets))).toThrow(fixture.message);
  });

  it("requires correctly clocked Start/End markers and forbids bytes after End", () => {
    const invalid = [
      { packets: [dcs(0), dctpq(960), dcs(0), end], message: /unexpected End of Clip/ },
      { packets: [dcs(0), dctpq(960), dcs(0), start], message: /missing Start\/End/ },
      { packets: [dcs(0), dctpq(960), start, end], message: /preceding Delta Clockstamp/ },
      { packets: [dcs(0), dctpq(960), dcs(0), start, dcs(0), end, [0x10f8_0000]],
        message: /data after End of Clip/ },
      { packets: [dcs(0), dctpq(960), dcs(0), start, dcs(0), start],
        message: /unexpected Start of Clip/ },
      { packets: [dcs(0), dctpq(960), dcs(0), start, dcs(0), dctpq(480), dcs(0), end],
        message: /DCTPQ must precede Start/ },
    ];

    for (const fixture of invalid)
      expect(() => parseMidiClipFile(makeClip(fixture.packets))).toThrow(fixture.message);
  });

  it("rejects retained UMP events above the 200,000-event parser limit", () => {
    const bytes = [...HEADER];
    for (const packet of [dcs(0), dctpq(960), dcs(0), start, dcs(0)])
      for (const word of packet) appendWord(bytes, word);
    for (let index = 0; index < 200_001; index++) appendWord(bytes, 0x1000_0000);
    for (const packet of [dcs(0), end])
      for (const word of packet) appendWord(bytes, word);

    expect(() => parseMidiClipFile(Uint8Array.from(bytes))).toThrow(/too many UMP events/);
  });

  it("fails loop expansion at the event cap instead of building an oversized file", () => {
    const source: MidiRegionRow = {
      ...region,
      durationBeats: 100_001,
      loop: true,
      loopLengthBeats: 1,
      notes: [note(1)],
      events: [{ beat: 0, status: 0xb0, data: [1, 64] }],
    };

    expect(() => writeMidiClipFile([{ name: "Dense", regions: [source] }], {
      bpm: 120,
      numerator: 4,
      denominator: 4,
      fromProjectStart: true,
      expandLoops: true,
    })).toThrow(/200,000 event export limit/);
  });

  it("round-trips writer DCS overflow splits with NOOP accumulator resets", () => {
    const source: MidiRegionRow = {
      ...region,
      durationBeats: 2_202,
      notes: [{ ...note(1), startBeats: 2_200 }],
    };
    const parsed = parseMidiClipFile(writeMidiClipFile(
      [{ name: "Long gap", regions: [source] }],
      { bpm: 120, numerator: 4, denominator: 4,
        fromProjectStart: true, expandLoops: false },
    ));

    expect(parsed.tracks[0].notes[0].startBeats).toBe(2_200);
  });
});
