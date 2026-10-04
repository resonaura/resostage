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
const setTempo120 = [0xd010_0000, 50_000_000, 0, 0];
const setMeter44 = [0xd010_0001, 0x0402_0800, 0, 0];

function appendWord(bytes: number[], word: number): void {
  bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
}

function makeClip(packets: number[][]): Uint8Array {
  const bytes = [...HEADER];
  for (const packet of packets) for (const word of packet) appendWord(bytes, word >>> 0);
  return Uint8Array.from(bytes);
}

function sysex7Packet(group: number, status: number, payload: number[]): number[] {
  const data = [...payload, 0, 0, 0, 0, 0, 0].slice(0, 6);
  return [
    ((3 << 28) | (group << 24) | (status << 20) | (payload.length << 16)
      | (data[0] << 8) | data[1]) >>> 0,
    ((data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5]) >>> 0,
  ];
}

function setProfileOnPackets(group = 0): number[][] {
  const bytes = [0x7e, 0x7f, 0x0d, 0x22, 0x01,
    1, 2, 3, 4, 5, 6, 7, 8, 0x7e, 0x7f, 0x7e, 0x7f, 1];
  return [
    sysex7Packet(group, 1, bytes.slice(0, 6)),
    sysex7Packet(group, 2, bytes.slice(6, 12)),
    sysex7Packet(group, 3, bytes.slice(12)),
  ];
}

function propertyExchangePackets(group = 0): number[][] {
  return [
    sysex7Packet(group, 1, [0x7e, 0x7f]),
    sysex7Packet(group, 2, [0x0d, 0x34]),
    sysex7Packet(group, 3, [0x01, 1, 2, 3, 4, 5]),
  ];
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
      { beat: 0.125, words: [0x10f8_0000], wordCount: 1, presentationOrder: 0 },
      { beat: 0.125, words: [0x10fa_0000], wordCount: 1, presentationOrder: 1 },
      { beat: 0.25, words: [0x10fc_0000], wordCount: 1, presentationOrder: 2 },
    ]);
  });

  it("preserves JR Clock and JR Timestamp Utility packets through MIDI Clip round-trip", () => {
    const jrClock = [0x0010_1234];
    const jrTimestamp = [0x0020_5678];
    const parsed = parseMidiClipFile(framedClip([
      dcs(0), jrClock,
      dcs(0), jrTimestamp,
      dcs(0), [0x4090_3c00, 0xffff_0000],
      dcs(960), [0x4080_3c00, 0xffff_0000],
    ]));

    expect(parsed.tracks[0].umpEvents?.map(({ words }) => words))
      .toEqual([jrClock, jrTimestamp]);
    const roundTrip = parseMidiClipFile(writeMidiClipFile(
      [{ name: "JR Utility", regions: [{ ...region, notes: parsed.tracks[0].notes,
        umpEvents: parsed.tracks[0].umpEvents }] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    ));
    expect(roundTrip.tracks[0].umpEvents?.map(({ words }) => words))
      .toEqual([jrClock, jrTimestamp]);
  });

  it("rejects nonzero reserved fields in recognized MIDI Clip Utility packets", () => {
    const invalid = [
      { packets: [[0x0140_0000], dctpq(960), dcs(0), start, dcs(0), end],
        message: /Utility UMP has nonzero reserved Group bits/ },
      { packets: [dcs(0), [0x0031_03c0], dcs(0), start, dcs(0), end],
        message: /DCTPQ has nonzero reserved bits/ },
      { packets: [dcs(0), dctpq(960), dcs(0), start, dcs(0), [0x0000_0001], dcs(0), end],
        message: /NOOP has nonzero reserved bits/ },
      { packets: [dcs(0), dctpq(960), dcs(0), start, dcs(0), [0x0010_0001], [0], dcs(0), end],
        message: /NOOP must immediately follow a Delta Clockstamp/ },
      { packets: [dcs(0), dctpq(960), dcs(0), start, dcs(0), [0x0021_5678], dcs(0), end],
        message: /JR timing message has nonzero reserved bits/ },
    ];

    for (const fixture of invalid)
      expect(() => parseMidiClipFile(makeClip(fixture.packets))).toThrow(fixture.message);
  });

  it("requires complete Start and End of Clip messages with zero reserved data", () => {
    const prefix = [dcs(0), dctpq(960), dcs(0)];
    const invalid = [
      { packets: [...prefix, [0xf420_0000, 0, 0, 0], dcs(0), start, dcs(0), end],
        message: /Start of Clip has an invalid form or nonzero reserved data/ },
      { packets: [...prefix, [0xf020_0001, 0, 0, 0], dcs(0), start, dcs(0), end],
        message: /Start of Clip has an invalid form or nonzero reserved data/ },
      { packets: [...prefix, [0xf020_0000, 1, 0, 0], dcs(0), start, dcs(0), end],
        message: /Start of Clip has an invalid form or nonzero reserved data/ },
      { packets: [...prefix, start, dcs(0), [0xf421_0000, 0, 0, 0]],
        message: /End of Clip has an invalid form or nonzero reserved data/ },
      { packets: [...prefix, start, dcs(0), [0xf021_0000, 0, 0, 1]],
        message: /End of Clip has an invalid form or nonzero reserved data/ },
    ];

    for (const fixture of invalid)
      expect(() => parseMidiClipFile(makeClip(fixture.packets))).toThrow(fixture.message);
  });

  it("anchors musical timing at Start of Clip while preserving timed configuration at beat zero", () => {
    const parsed = parseMidiClipFile(makeClip([
      dcs(0), dctpq(960),
      dcs(0), setTempo120,
      dcs(0), setMeter44,
      dcs(120), [0x20c0_0000],
      dcs(120), start,
      dcs(120), [0x4090_3c00, 0xffff_0000],
      dcs(1_920), [0x4080_3c00, 0xffff_0000],
      dcs(0), end,
    ]));

    expect(parsed.tempoEvents).toEqual([{ beat: 0, bpm: 120 }]);
    expect(parsed.meterEvents).toEqual([{ beat: 0, numerator: 4, denominator: 4 }]);
    expect(parsed.tracks[0].umpEvents).toEqual([
      { beat: 0, words: [0x20c0_0000], wordCount: 1, configurationHeader: true },
    ]);
    expect(parsed.tracks[0].notes).toHaveLength(1);
    expect(parsed.tracks[0].notes[0]).toMatchObject({
      startBeats: 0.125,
      durationBeats: 2,
    });
    expect(parsed.tracks[0].durationBeats).toBe(2.125);
  });

  it("enforces configuration-header tempo and meter cardinality and order", () => {
    const prefix = [dcs(0), dctpq(960)];
    const invalid = [
      { packets: [...prefix, dcs(0), setTempo120, dcs(0), setTempo120, dcs(0), start, dcs(0), end],
        message: /more than one Set Tempo/ },
      { packets: [...prefix, dcs(0), setTempo120, dcs(0), setMeter44, dcs(0), setMeter44, dcs(0), start, dcs(0), end],
        message: /more than one Set Time Signature/ },
      { packets: [...prefix, dcs(0), setMeter44, dcs(0), start, dcs(0), end],
        message: /must immediately follow Set Tempo/ },
      { packets: [...prefix, dcs(0), setTempo120, dcs(0), [0x20c0_0000], dcs(0), setMeter44,
        dcs(0), start, dcs(0), end],
        message: /must immediately follow Set Tempo/ },
      { packets: [...prefix, dcs(1), setTempo120, dcs(0), start, dcs(0), end],
        message: /must use a zero Delta Clockstamp/ },
      { packets: [dcs(0), setTempo120, dcs(0), dctpq(960), dcs(0), start, dcs(0), end],
        message: /must follow DCTPQ/ },
      { packets: [...prefix, dcs(0), [0x20c0_0000], dcs(0), setTempo120, dcs(0), start, dcs(0), end],
        message: /must be its first event after DCTPQ/ },
    ];

    for (const fixture of invalid)
      expect(() => parseMidiClipFile(makeClip(fixture.packets))).toThrow(fixture.message);
  });

  it("allows multiple tempo changes in Clip Sequence Data", () => {
    const parsed = parseMidiClipFile(framedClip([
      dcs(0), setTempo120,
      dcs(960), [0xd010_0000, 100_000_000, 0, 0],
    ]));

    expect(parsed.tempoEvents).toEqual([
      { beat: 0, bpm: 120 },
      { beat: 1, bpm: 60 },
    ]);
  });

  it("validates Set Tempo and Set Time Signature Flex Data fields", () => {
    const invalid = [
      { message: /Set Tempo has an invalid format, address, or reserved channel/,
        words: [0xd050_0000, 50_000_000, 0, 0] },
      { message: /Set Time Signature has an invalid format, address, or reserved channel/,
        words: [0xd000_0001, 0x0402_0800, 0, 0] },
      { message: /Set Tempo has an invalid format, address, or reserved channel/,
        words: [0xd011_0000, 50_000_000, 0, 0] },
      { message: /Set Tempo has nonzero reserved data/,
        words: [0xd010_0000, 50_000_000, 1, 0] },
      { message: /Set Time Signature has nonzero reserved data/,
        words: [0xd010_0001, 0x0402_0801, 0, 0] },
      { message: /Set Tempo has a zero time-per-quarter-note value/,
        words: [0xd010_0000, 0, 0, 0] },
    ];

    for (const fixture of invalid) {
      expect(() => parseMidiClipFile(framedClip([
        dcs(0), fixture.words,
      ]))).toThrow(fixture.message);
    }

    expect(() => parseMidiClipFile(makeClip([
      dcs(0), dctpq(960), dcs(0), [0xd010_0001, 0x0402_0800, 0, 1],
      dcs(0), start, dcs(0), end,
    ]))).toThrow(/Set Time Signature has nonzero reserved data/);
  });

  it("round-trips the 256-beat numerator and retains unsupported denominator data opaquely", () => {
    const maximumNumerator = parseMidiClipFile(framedClip([
      dcs(0), [0xd010_0001, 0x0002_0800, 0, 0],
    ]));
    expect(maximumNumerator.meterEvents).toEqual([{ beat: 0, numerator: 256, denominator: 4 }]);

    const maximumRoundTrip = parseMidiClipFile(writeMidiClipFile(
      [{ name: "256 beats", regions: [region] }],
      { bpm: 120, numerator: 256, denominator: 4, fromProjectStart: true, expandLoops: false },
    ));
    expect(maximumRoundTrip.meterEvents).toEqual([{ beat: 0, numerator: 256, denominator: 4 }]);

    const nonstandardDenominator = [0xd010_0001, 0x0400_0800, 0, 0];
    const opaque = parseMidiClipFile(framedClip([dcs(0), nonstandardDenominator]));
    expect(opaque.meterEvents).toEqual([]);
    expect(opaque.tracks[0].umpEvents).toEqual([{
      beat: 0, words: nonstandardDenominator, wordCount: 4, presentationOrder: 0,
    }]);

    const unsupportedPower = [0xd010_0001, 0x0408_0800, 0, 0];
    const opaquePower = parseMidiClipFile(framedClip([dcs(0), unsupportedPower]));
    expect(opaquePower.tracks[0].umpEvents).toEqual([{
      beat: 0, words: unsupportedPower, wordCount: 4, presentationOrder: 0,
    }]);

    const unsupportedConfigurationMeter = [0xd010_0001, 0x0400_0800, 0, 0];
    const importedConfiguration = parseMidiClipFile(makeClip([
      dcs(0), dctpq(960), dcs(0), setTempo120,
      dcs(0), unsupportedConfigurationMeter,
      dcs(0), start, dcs(0), end,
    ]));
    const reimported = parseMidiClipFile(writeMidiClipFile(
      [{ name: "Opaque configuration meter", regions: [{ ...region,
        umpEvents: importedConfiguration.tracks[0].umpEvents }] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    ));
    expect(reimported.tracks[0].umpEvents?.map(({ words }) => words))
      .toContainEqual(unsupportedConfigurationMeter);
  });

  it("rejects time signatures the normalized project meter cannot encode", () => {
    for (const meter of [
      { numerator: 0, denominator: 4 },
      { numerator: 257, denominator: 4 },
      { numerator: 4, denominator: 1 },
      { numerator: 4, denominator: 3 },
    ]) {
      expect(() => writeMidiClipFile(
        [{ name: "Invalid meter", regions: [region] }],
        { bpm: 120, ...meter, fromProjectStart: true, expandLoops: false },
      )).toThrow(/cannot encode this time signature/);
    }
  });

  it("keeps short bar-boundary meter changes on the full DCTPQ grid", () => {
    const bytes = writeMidiClipFile(
      [{ name: "Short bars", regions: [region] }],
      { bpm: 120, numerator: 1, denominator: 128,
        meterEvents: [
          { beat: 0, numerator: 1, denominator: 128, thirtySecondsPerQuarter: 13 },
          { beat: 1 / 32, numerator: 2, denominator: 4, thirtySecondsPerQuarter: 11 },
        ],
        fromProjectStart: true, expandLoops: false },
    );
    const dctpq = ((bytes[12] * 0x1000000) + (bytes[13] << 16) + (bytes[14] << 8) + bytes[15]) >>> 0;
    expect(dctpq).toBe(0x0030_ff00);

    const parsed = parseMidiClipFile(bytes);

    expect(parsed.meterEvents).toEqual([
      { beat: 0, numerator: 1, denominator: 128, thirtySecondsPerQuarter: 13 },
      { beat: 1 / 32, numerator: 2, denominator: 4, thirtySecondsPerQuarter: 11 },
    ]);
  });

  it("preserves Set Tempo units at the encoding limits and rejects clamped tempos", () => {
    const exportWithBpm = (bpm: number) => writeMidiClipFile(
      [{ name: "Tempo limits", regions: [region] }],
      { bpm, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    );
    const slowest = parseMidiClipFile(exportWithBpm(6_000_000_000 / 0xffff_ffff));
    const fastest = parseMidiClipFile(exportWithBpm(6_000_000_000));
    expect(slowest.tempoEvents[0].bpm).toBeCloseTo(6_000_000_000 / 0xffff_ffff, 9);
    expect(fastest.tempoEvents[0].bpm).toBe(6_000_000_000);

    expect(() => exportWithBpm(1)).toThrow(/outside the MIDI 2\.0 Set Tempo encoding range/);
    expect(() => exportWithBpm(12_000_000_001)).toThrow(/outside the MIDI 2\.0 Set Tempo encoding range/);
    expect(() => writeMidiClipFile(
      [{ name: "Invalid tempo", regions: [region] }],
      { bpm: 120, tempoEvents: [{ beat: 0, bpm: Number.NaN }], numerator: 4, denominator: 4,
        fromProjectStart: true, expandLoops: false },
    )).toThrow(/invalid tempo event/);
  });

  it("round-trips high-resolution long gaps and rejects expansion beyond its packet budget", () => {
    const clock = [0x0010_1234];
    const timestamp = [0x0020_5678];
    const parsed = parseMidiClipFile(writeMidiClipFile(
      [{ name: "Long gap", regions: [{ ...region, durationBeats: 24,
        umpEvents: [
          { beat: 0, words: clock, wordCount: 1 },
          { beat: 20, words: timestamp, wordCount: 1 },
        ] }] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    ));
    expect(parsed.tracks[0].umpEvents?.map(({ beat, words }) => ({ beat, words })))
      .toEqual([{ beat: 0, words: clock }, { beat: 20, words: timestamp }]);

    expect(() => writeMidiClipFile(
      [{ name: "Unbounded gap", regions: [{ ...region, durationBeats: 1_000_000_001,
        umpEvents: [
          { beat: 0, words: clock, wordCount: 1 },
          { beat: 1_000_000_000, words: timestamp, wordCount: 1 },
        ] }] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    )).toThrow(/bounded UMP packet export limit/);
  });

  it("preserves distinct MIDI 2.0 Note-On and Note-Off attributes", () => {
    const parsed = parseMidiClipFile(framedClip([
      dcs(0), [0x4090_3c01, 0x9234_abcd],
      dcs(960), [0x4080_3c02, 0x4567_fedc],
    ]));

    expect(parsed.tracks[0].notes).toHaveLength(1);
    expect(parsed.tracks[0].notes[0].midi2).toMatchObject({
      velocity: 0x9234,
      releaseVelocity: 0x4567,
      attributeType: 1,
      attributeData: 0xabcd,
      releaseAttributeType: 2,
      releaseAttributeData: 0xfedc,
    });

    const roundTrip = parseMidiClipFile(writeMidiClipFile(
      [{ name: "Independent attributes", regions: [{ ...region, notes: parsed.tracks[0].notes }] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    ));
    expect(roundTrip.tracks[0].notes[0].midi2).toMatchObject({
      velocity: parsed.tracks[0].notes[0].midi2!.velocity,
      releaseVelocity: parsed.tracks[0].notes[0].midi2!.releaseVelocity,
      attributeType: parsed.tracks[0].notes[0].midi2!.attributeType,
      attributeData: parsed.tracks[0].notes[0].midi2!.attributeData,
      releaseAttributeType: parsed.tracks[0].notes[0].midi2!.releaseAttributeType,
      releaseAttributeData: parsed.tracks[0].notes[0].midi2!.releaseAttributeData,
    });
  });

  it("keeps MIDI 2.0 zero-velocity Note On distinct from MIDI 1.0 zero-velocity Note Off", () => {
    const midi2ZeroOn = parseMidiClipFile(framedClip([
      dcs(0), [0x4090_3c01, 0x0000_1234],
      dcs(480), [0x4080_3c02, 0x8000_5678],
    ]));
    expect(midi2ZeroOn.tracks[0].notes).toHaveLength(1);
    expect(midi2ZeroOn.tracks[0].notes[0]).toMatchObject({
      startBeats: 0,
      durationBeats: 0.5,
      velocity: 0,
      midi2: { velocity: 0, attributeType: 1, attributeData: 0x1234,
        releaseAttributeType: 2, releaseAttributeData: 0x5678 },
    });

    const midi1ZeroOff = parseMidiClipFile(framedClip([
      dcs(0), [0x2090_3c64],
      dcs(480), [0x2090_3c00],
    ]));
    expect(midi1ZeroOff.tracks[0].notes).toHaveLength(1);
    expect(midi1ZeroOff.tracks[0].notes[0].durationBeats).toBe(0.5);
  });

  it("preserves zero-tick MIDI 2.0 notes and keeps each new attack before its release", () => {
    const imported = parseMidiClipFile(framedClip([
      dcs(0), [0x4090_3c00, 0xffff_0000],
      dcs(0), [0x4080_3c00, 0xffff_0000],
    ]));
    expect(imported.tracks[0].notes).toHaveLength(1);
    expect(imported.tracks[0].notes[0]).toMatchObject({ startBeats: 0, durationBeats: 0 });

    const roundTrip = parseMidiClipFile(writeMidiClipFile([{
      name: "Imported zero note",
      regions: [{ ...region, notes: imported.tracks[0].notes }],
    }], { bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false }));
    expect(roundTrip.tracks[0].notes[0].durationBeats).toBe(0);

    const created = writeMidiClipFile([{
      name: "New zero note",
      regions: [{ ...region, notes: [{ ...note(9), durationBeats: 0 }] }],
    }], { bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false });
    const view = new DataView(created.buffer, created.byteOffset, created.byteLength);
    const statuses: number[] = [];
    for (let offset = 8; offset < created.byteLength; offset += 4) {
      const first = view.getUint32(offset);
      if ((first >>> 28) === 4 && ((first >>> 8) & 0x7f) === 60)
        statuses.push((first >>> 20) & 0xf);
    }
    expect(statuses).toEqual([9, 8]);
  });

  it("holds unmatched MIDI 2.0 Note On events through End of Clip", () => {
    const parsed = parseMidiClipFile(makeClip([
      dcs(0), dctpq(960), dcs(0), start,
      dcs(240), [0x4090_3c00, 0x8000_0000],
      dcs(1_680), end,
    ]));
    expect(parsed.tracks[0].notes[0]).toMatchObject({
      startBeats: 0.25,
      durationBeats: 1.75,
    });
    expect(parsed.tracks[0].durationBeats).toBe(2);

    const noteAtClipEnd = parseMidiClipFile(makeClip([
      dcs(0), dctpq(960), dcs(0), start,
      dcs(0), [0x4090_3c00, 0x8000_0000],
      dcs(0), end,
    ]));
    expect(noteAtClipEnd.tracks[0].notes[0].durationBeats).toBe(0);
  });

  it("does not pair note edges across MIDI 1.0 and MIDI 2.0 UMP protocols", () => {
    const parsed = parseMidiClipFile(makeClip([
      dcs(0), dctpq(960), dcs(0), start,
      dcs(0), [0x2090_3c64],
      dcs(120), [0x4080_3c00, 0xffff_0000],
      dcs(0), [0x4091_3d00, 0x8000_0000],
      dcs(120), [0x2081_3d20],
      dcs(120), end,
    ]));

    expect(parsed.tracks[0].notes.map(({ pitch, startBeats, durationBeats }) => ({
      pitch, startBeats, durationBeats,
    }))).toEqual([
      { pitch: 60, startBeats: 0, durationBeats: 0.375 },
      { pitch: 61, startBeats: 0.125, durationBeats: 0.25 },
    ]);
    expect(parsed.tracks[0].umpEvents?.map(({ words }) => words)).toEqual([
      [0x4080_3c00, 0xffff_0000],
      [0x2081_3d20],
    ]);
  });

  it("pairs overlapping same-key MIDI 2.0 notes in FIFO order, not by attribute payload", () => {
    const parsed = parseMidiClipFile(framedClip([
      dcs(0), [0x4090_3c01, 0x8000_1111],
      dcs(120), [0x4090_3c02, 0x9000_2222],
      dcs(120), [0x4080_3c03, 0x7000_3333],
      dcs(120), [0x4080_3c04, 0x6000_4444],
    ]));
    expect(parsed.tracks[0].notes).toHaveLength(2);
    expect(parsed.tracks[0].notes.map(({ startBeats, durationBeats, midi2 }) => ({
      startBeats, durationBeats, on: midi2?.attributeData, off: midi2?.releaseAttributeData,
    }))).toEqual([
      { startBeats: 0, durationBeats: 0.25, on: 0x1111, off: 0x3333 },
      { startBeats: 0.125, durationBeats: 0.25, on: 0x2222, off: 0x4444 },
    ]);
  });

  it("round-trips simultaneous raw UMP and note-edge presentation order", () => {
    const parsed = parseMidiClipFile(framedClip([
      dcs(0), [0x20b0_0140],
      dcs(0), [0x4090_3c01, 0x8000_1111],
      dcs(960), [0x4090_3c02, 0x9000_2222],
      dcs(0), [0x4080_3c03, 0x7000_3333],
      dcs(960), [0x4080_3c04, 0x6000_4444],
    ]));
    const sourceNotes = parsed.tracks[0].notes;
    expect(parsed.tracks[0].umpEvents?.[0].presentationOrder)
      .toBeLessThan(sourceNotes[0].midi2!.attackOrder!);
    expect(sourceNotes[1].midi2!.attackOrder)
      .toBeLessThan(sourceNotes[0].midi2!.releaseOrder!);

    const roundTrip = parseMidiClipFile(writeMidiClipFile(
      [{ name: "Ordered sequence", regions: [{ ...region, notes: sourceNotes,
        umpEvents: parsed.tracks[0].umpEvents }] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    ));
    const notes = roundTrip.tracks[0].notes;
    expect(roundTrip.tracks[0].umpEvents?.[0].presentationOrder)
      .toBeLessThan(notes[0].midi2!.attackOrder!);
    expect(notes[1].midi2!.attackOrder).toBeLessThan(notes[0].midi2!.releaseOrder!);
    expect(notes.map(({ midi2 }) => [midi2?.attributeData, midi2?.releaseAttributeData]))
      .toEqual([[0x1111, 0x3333], [0x2222, 0x4444]]);
  });

  it("keeps loop-expanded same-pitch retriggers Off-before-On despite stale source order", () => {
    const looped: MidiRegionRow = {
      ...region,
      durationBeats: 2,
      loop: true,
      loopLengthBeats: 1,
      notes: [{ ...note(1), durationBeats: 1, midi2: {
        group: 0, velocity: 0x8000, releaseVelocity: 0x7000,
        attributeType: 0, attributeData: 0x1111,
        releaseAttributeType: 0, releaseAttributeData: 0x2222,
        attackOrder: 10, releaseOrder: 20,
      } }],
    };
    const parsed = parseMidiClipFile(writeMidiClipFile(
      [{ name: "Loop boundary", regions: [looped] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: true },
    ));
    expect(parsed.tracks[0].notes).toHaveLength(2);
    expect(parsed.tracks[0].notes.map(({ startBeats, durationBeats }) => [startBeats, durationBeats]))
      .toEqual([[0, 1], [1, 1]]);
  });

  it("allows configuration tempo and meter to inherit DCTPQ's zero clockstamp", () => {
    const parsed = parseMidiClipFile(makeClip([
      dcs(0), dctpq(960), setTempo120, setMeter44,
      dcs(0), start, dcs(0), end,
    ]));
    expect(parsed.tempoEvents).toEqual([{ beat: 0, bpm: 120 }]);
    expect(parsed.meterEvents).toEqual([{ beat: 0, numerator: 4, denominator: 4 }]);
  });

  it("preserves profile and receiver configuration sections across MIDI Clip export", () => {
    const profile = setProfileOnPackets();
    const receiverSetup = [0x40c0_0000, 0x0001_0000];
    const imported = parseMidiClipFile(makeClip([
      ...profile,
      dcs(0), dctpq(960),
      dcs(0), receiverSetup,
      dcs(0), start,
      dcs(960), [0x20c0_0000],
      dcs(0), end,
    ]));

    expect(imported.tracks[0].umpEvents).toEqual([
      ...profile.map((words) => ({ beat: 0, words, wordCount: 2,
        configurationHeader: true, profileConfigurationHeader: true })),
      { beat: 0, words: receiverSetup, wordCount: 2, configurationHeader: true },
      { beat: 1, words: [0x20c0_0000], wordCount: 1, presentationOrder: 4 },
    ]);

    const regionWithSections: MidiRegionRow = {
      ...region,
      umpEvents: imported.tracks[0].umpEvents,
    };
    const roundTrip = parseMidiClipFile(writeMidiClipFile(
      [{ name: "Header sections", regions: [regionWithSections] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    ));
    expect(roundTrip.tracks[0].umpEvents?.map(({ presentationOrder: _order, ...event }) => event))
      .toEqual(imported.tracks[0].umpEvents?.map(({ presentationOrder: _order, ...event }) => event));
    expect(roundTrip.tracks[0].umpEvents?.[4].presentationOrder)
      .toBeGreaterThan(roundTrip.tracks[0].umpEvents?.[3].presentationOrder ?? -1);
  });

  it("rejects profile prefixes that are not complete MIDI-CI Set Profile On messages", () => {
    const profile = setProfileOnPackets();
    const profileOff = sysex7Packet(0, 0,
      [0x7e, 0x7f, 0x0d, 0x23, 0x01, 1]);
    expect(() => parseMidiClipFile(makeClip([
      profileOff,
      dcs(0), dctpq(960), dcs(0), start, dcs(0), end,
    ]))).toThrow(/complete MIDI-CI Set Profile On/);
    expect(() => parseMidiClipFile(makeClip([
      ...profile.slice(0, 2),
      dcs(0), dctpq(960), dcs(0), start, dcs(0), end,
    ]))).toThrow(/incomplete SysEx7 message/);
  });

  it("rejects malformed profile configuration before MIDI Clip export", () => {
    const incompleteProfile = setProfileOnPackets().slice(0, 2);
    const invalidRegion: MidiRegionRow = {
      ...region,
      umpEvents: [
        ...incompleteProfile.map((words) => ({ beat: 0, words, wordCount: 2,
          configurationHeader: true, profileConfigurationHeader: true })),
        { beat: 0, words: [0x20c0_0000], wordCount: 1 },
      ],
    };
    expect(() => writeMidiClipFile(
      [{ name: "Malformed profile", regions: [invalidRegion] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    )).toThrow(/incomplete SysEx7 message/);
  });

  it("exports profile configuration even when its source region has no musical events", () => {
    const profile = setProfileOnPackets();
    const configurationOnlyRegion: MidiRegionRow = {
      ...region,
      umpEvents: profile.map((words) => ({ beat: 0, words, wordCount: 2,
        configurationHeader: true, profileConfigurationHeader: true })),
    };
    const parsed = parseMidiClipFile(writeMidiClipFile(
      [{ name: "Configuration only", regions: [configurationOnlyRegion] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    ));

    expect(parsed.tracks[0].umpEvents).toEqual(profile.map((words) => ({ beat: 0,
      words, wordCount: 2, configurationHeader: true, profileConfigurationHeader: true })));
  });

  it("rejects MIDI-CI Property Exchange split across sequence SysEx7 packets", () => {
    const propertyExchange = propertyExchangePackets();
    expect(() => parseMidiClipFile(framedClip(propertyExchange)))
      .toThrow(/Property Exchange messages are not allowed in MIDI Clip Sequence Data/);

    const ordinarySysEx = [
      sysex7Packet(1, 1, [0x41, 0x01]),
      sysex7Packet(1, 3, [0x02, 0x03]),
    ];
    expect(parseMidiClipFile(framedClip(ordinarySysEx)).tracks[0].umpEvents)
      .toHaveLength(ordinarySysEx.length);

    expect(() => parseMidiClipFile(framedClip([
      sysex7Packet(0, 2, [0x41]),
    ]))).toThrow(/continuation without a matching start/);
    expect(() => parseMidiClipFile(framedClip([
      sysex7Packet(0, 1, [0x41]),
    ]))).toThrow(/incomplete SysEx7 message/);

    const invalidRegion: MidiRegionRow = {
      ...region,
      umpEvents: propertyExchange.map((words) => ({ beat: 0, words, wordCount: 2 })),
    };
    expect(() => writeMidiClipFile(
      [{ name: "Property Exchange", regions: [invalidRegion] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    )).toThrow(/Property Exchange messages are not allowed in MIDI Clip Sequence Data/);
  });

  it("rejects non-profile events before DCTPQ and clockstamped profile prefixes", () => {
    const profile = setProfileOnPackets();
    expect(() => parseMidiClipFile(makeClip([
      [0x20c0_0000], dcs(0), dctpq(960), dcs(0), start, dcs(0), end,
    ]))).toThrow(/Only MIDI Clip profile configuration may precede DCTPQ/);
    expect(() => parseMidiClipFile(makeClip([
      dcs(0), ...profile, dcs(0), dctpq(960), dcs(0), start, dcs(0), end,
    ]))).toThrow(/must not have a Delta Clockstamp/);
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

  it("counts configuration packets toward the bounded export event total", () => {
    const source: MidiRegionRow = {
      ...region,
      durationBeats: 100_000,
      loop: true,
      loopLengthBeats: 1,
      notes: [note(1)],
      umpEvents: [{ beat: 0, words: [0x20c0_0000], wordCount: 1, configurationHeader: true }],
    };

    expect(() => writeMidiClipFile([{ name: "Bounded setup", regions: [source] }], {
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
