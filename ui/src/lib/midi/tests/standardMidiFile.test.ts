// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { describe, expect, it } from "vitest";
import {
  analyzeMidi1ExportLoss,
  adaptMidiTracksToSongTempo,
  midiSecondsAtBeat,
  parseStandardMidiFile,
  songBeatAtElapsedSeconds,
  writeSongsMidiFile,
  writeStandardMidiFile,
} from "@/lib/midi/standardMidiFile";
import type { MidiRegionRow, SongRow } from "@/lib/state/types";
import { writeMidiClipFile } from "@/lib/midi/midiClipFile";

const region: MidiRegionRow = {
  id: "r1", trackId: "t1", name: "Pattern", startBeats: 8,
  durationBeats: 4, clipOffsetBeats: 0, loop: false, loopLengthBeats: 4,
  notes: [{
    id: 1, pitch: 60, startBeats: 0.5, durationBeats: 1.5,
    velocity: 0.8, releaseVelocity: 0.3, probability: 1,
  }],
};

describe("Standard MIDI File", () => {
  it("uses the SMF default tempo and converts imported timing into a destination tempo", () => {
    expect(midiSecondsAtBeat([], 4)).toBe(2);
    expect(midiSecondsAtBeat([{ beat: 0, bpm: 60 }], 4)).toBe(4);
    const song = {
      name: "Song", bpm: 60, mode: "auto" as const, tsNum: 4, tsDen: 4,
      events: [], tempoPoints: [], signaturePoints: [], midiRegions: [], regions: [],
    } as unknown as SongRow;
    expect(songBeatAtElapsedSeconds(song, 4)).toBeCloseTo(4, 5);
    const imported = adaptMidiTracksToSongTempo([{
      name: "Piano", durationBeats: 4, notes: [{
        id: 1, pitch: 60, startBeats: 1, durationBeats: 1,
        velocity: 1, releaseVelocity: 0.5, probability: 1,
      }],
    }], [{ beat: 0, bpm: 120 }], song);
    expect(imported[0].notes[0].startBeats).toBeCloseTo(0.5, 5);
    expect(imported[0].notes[0].durationBeats).toBeCloseTo(0.5, 5);
    expect(imported[0].durationBeats).toBeCloseTo(2, 5);
  });

  it("round-trips a MIDI region with tempo and meter", () => {
    const bytes = writeStandardMidiFile([{ name: "Piano", regions: [region] }], {
      bpm: 123, numerator: 3, denominator: 4,
      fromProjectStart: true, expandLoops: true,
    });
    const parsed = parseStandardMidiFile(bytes);
    expect(parsed.bpm).toBeCloseTo(123, 3);
    expect(parsed.numerator).toBe(3);
    expect(parsed.denominator).toBe(4);
    expect(parsed.tracks[1].name).toBe("Piano");
    expect(parsed.tracks[1].notes[0]).toMatchObject({
      pitch: 60, startBeats: 8.5, durationBeats: 1.5,
    });
  });

  it("round-trips MIDI 2.0 note precision and group in an SMF2 Clip", () => {
    const midi2Region: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [{
        ...region.notes[0],
        startBeats: 0.25,
        durationBeats: 0.75,
        channel: 4,
        velocity: 0.5,
        midi2: { group: 3, velocity: 0x9234, releaseVelocity: 0x4567,
          attributeType: 1, attributeData: 0xbeef },
      }],
    };
    const song: SongRow = {
      name: "MIDI 2", bpm: 120, tsNum: 4, tsDen: 4, mode: "auto", endSeconds: 2,
      click: false, clickBusId: "", clickSends: [],
      regions: [], midiRegions: [midi2Region], events: [],
    };
    const bytes = writeSongsMidiFile([song], {
      songIndices: [0], tracks: [{ id: "t1", name: "Expressive" }],
      fromProjectStart: true, expandLoops: true, format: "midi2",
    });
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("SMF2CLIP");
    const parsed = parseStandardMidiFile(bytes);
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0].notes[0]).toMatchObject({
      pitch: 60, channel: 4, startBeats: 0.25, durationBeats: 0.75,
      midi2: { group: 3, velocity: 0x9234, releaseVelocity: 0x4567,
        attributeType: 1, attributeData: 0xbeef },
    });
    expect(parsed.tempoEvents[0].bpm).toBeCloseTo(120, 3);
    expect(parsed.meterEvents[0]).toMatchObject({ numerator: 4, denominator: 4 });
  });

  it("uses the MIDI Association bit-scaling rule for ordinary 7-bit velocity in .midi2", () => {
    const source = { ...region, startBeats: 0, notes: [{ ...region.notes[0], velocity: 70 / 127 }] };
    const song: SongRow = {
      name: "MIDI 1", bpm: 120, tsNum: 4, tsDen: 4, mode: "auto", endSeconds: 2,
      click: false, clickBusId: "", clickSends: [],
      regions: [], midiRegions: [source], events: [],
    };
    const parsed = parseStandardMidiFile(writeSongsMidiFile([song], {
      songIndices: [0], tracks: [{ id: "t1", name: "Legacy" }],
      fromProjectStart: true, expandLoops: true, format: "midi2",
    }));
    expect(parsed.tracks[0].notes[0].midi2?.velocity).toBe(0x8c30);
  });

  it("exports the effective tempo and meter at a nonzero MIDI 2.0 clip origin", () => {
    const song: SongRow = {
      name: "Tempo map", bpm: 120, tsNum: 4, tsDen: 4, mode: "auto", endSeconds: 7,
      click: false, clickBusId: "", clickSends: [],
      regions: [], midiRegions: [{ ...region, startBeats: 8 }], events: [],
      tempoPoints: [
        { beat: 0, bpm: 120, timeSeconds: 0, curve: 0 },
        { beat: 4, bpm: 90, timeSeconds: 2, curve: 0 },
        { beat: 10, bpm: 100, timeSeconds: 6, curve: 0 },
      ],
      signaturePoints: [
        { beat: 0, numerator: 4, denominator: 4, bar: 1 },
        { beat: 6, numerator: 3, denominator: 4, bar: 2 },
        { beat: 9, numerator: 5, denominator: 4, bar: 3 },
      ],
    };
    const parsed = parseStandardMidiFile(writeSongsMidiFile([song], {
      songIndices: [0], tracks: [{ id: "t1", name: "Piano" }],
      fromProjectStart: false, expandLoops: true, format: "midi2",
    }));
    expect(parsed.tempoEvents).toHaveLength(2);
    expect(parsed.tempoEvents[0].beat).toBe(0);
    expect(parsed.tempoEvents[0].bpm).toBeCloseTo(90, 4);
    expect(parsed.tempoEvents[1].beat).toBe(2);
    expect(parsed.tempoEvents[1].bpm).toBeCloseTo(100, 4);
    expect(parsed.meterEvents).toEqual([
      { beat: 0, numerator: 3, denominator: 4 },
      { beat: 1, numerator: 5, denominator: 4 },
    ]);
  });

  it("round-trips opaque four-word UMP events without interpreting their payload", () => {
    const opaque = [0x50031234, 0x89abcdef, 0x10293847, 0xdeadbeef];
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      umpEvents: [{ beat: 1.25, words: opaque, wordCount: 4 }],
    };
    const song: SongRow = {
      name: "Opaque UMP", bpm: 120, tsNum: 4, tsDen: 4, mode: "auto", endSeconds: 2,
      click: false, clickBusId: "", clickSends: [],
      regions: [], midiRegions: [source], events: [],
    };
    const parsed = parseStandardMidiFile(writeSongsMidiFile([song], {
      songIndices: [0], tracks: [{ id: "t1", name: "UMP" }],
      fromProjectStart: true, expandLoops: true, format: "midi2",
    }));
    expect(parsed.tracks[0].umpEvents).toContainEqual({ beat: 1.25, words: opaque, wordCount: 4 });
  });

  it("exports MIDI 2.0 loop wrap, clipped note ends, and mute state like the arrangement", () => {
    const looped: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 6,
      clipOffsetBeats: 1,
      loop: true,
      loopLengthBeats: 4,
      notes: [
        { ...region.notes[0], id: 10, pitch: 60, startBeats: 0.5, durationBeats: 1 },
        { ...region.notes[0], id: 11, pitch: 61, startBeats: 2.5, durationBeats: 1 },
        { ...region.notes[0], id: 12, pitch: 62, startBeats: 1.5, muted: true },
      ],
      umpEvents: [{ beat: 0.5, words: [0x20b20140], wordCount: 1 }],
    };
    const parsed = parseStandardMidiFile(writeMidiClipFile([
      { name: "Live", regions: [looped] },
      { name: "Muted", regions: [{ ...looped, muted: true, startBeats: 10 }] },
    ], { bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: true }));
    const notes = parsed.tracks[0].notes.map((note) => ({
      pitch: note.pitch, start: note.startBeats, end: note.startBeats + note.durationBeats,
    })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    expect(notes).toEqual([
      { pitch: 61, start: 1.5, end: 2.5 },
      { pitch: 60, start: 3.5, end: 4.5 },
      { pitch: 61, start: 5.5, end: 6 },
    ]);
    expect(parsed.tracks[0].umpEvents).toContainEqual({ beat: 3.5,
      words: [0x20b20140], wordCount: 1 });
  });

  it("orders MIDI 2.0 note off before retrigger at the same tick", () => {
    const clip = writeMidiClipFile([{ name: "Retrigger", regions: [{
      ...region, startBeats: 0,
      notes: [
        { ...region.notes[0], id: 2, startBeats: 1, durationBeats: 1 },
        { ...region.notes[0], id: 1, startBeats: 0, durationBeats: 1 },
      ],
    }] }], { bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false });
    const words = new DataView(clip.buffer, clip.byteOffset, clip.byteLength);
    const statuses: number[] = [];
    for (let offset = 8; offset < clip.byteLength; offset += 4) {
      const first = words.getUint32(offset);
      if ((first >>> 28) === 4 && ((first >>> 8) & 0x7f) === 60)
        statuses.push((first >>> 20) & 0xf);
    }
    expect(statuses).toEqual([9, 8, 9, 8]);
  });

  it("down-converts representable MIDI 2.0 channel controls in a standard .mid export", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      umpEvents: [
        { beat: 1, words: [0x40b20700, 0x80000000], wordCount: 2 },
        { beat: 1.5, words: [0x20c20a00], wordCount: 1 },
        { beat: 2, words: [0x40b20600, 0x80000000], wordCount: 2 },
      ],
    };
    const parsed = parseStandardMidiFile(writeStandardMidiFile([{ name: "Controls", regions: [source] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: true,
    }));
    expect(parsed.tracks[1].events).toContainEqual({ beat: 1, status: 0xb2, data: [7, 64] });
    expect(parsed.tracks[1].events).toContainEqual({ beat: 1.5, status: 0xc2, data: [10] });
    expect(parsed.tracks[1].events).not.toContainEqual({ beat: 2, status: 0xb2, data: [6, 64] });
    expect(analyzeMidi1ExportLoss([{ name: "Controls", regions: [source] }]).unsupportedUmpEvents).toBe(1);
  });

  it("reports MIDI 2.0 note and opaque UMP losses before legacy export", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      notes: [{ ...region.notes[0], midi2: {
        group: 2, velocity: 0x9234, releaseVelocity: 0x4567,
        attributeType: 1, attributeData: 0xbeef,
      } }],
      umpEvents: [{ beat: 1, words: [0x50000000, 0, 0, 0], wordCount: 4 }],
    };
    expect(analyzeMidi1ExportLoss([{ name: "Expressive", regions: [source] }])).toEqual({
      midi2Notes: 1,
      noteAttributes: 1,
      groups: 1,
      quantizedVelocities: 1,
      unsupportedUmpEvents: 1,
    });
  });

  it("preserves source MIDI channels and non-note channel/meta events", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [{ ...region.notes[0], channel: 9 }],
      events: [
        { beat: 0, status: 0xc9, data: [40] },
        { beat: 0.5, status: 0xb9, data: [1, 64] },
        { beat: 1, status: 0xff, data: [0x05, 0x68, 0x69] },
      ],
    };
    const parsed = parseStandardMidiFile(writeStandardMidiFile([{ name: "Drums", regions: [source] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: true,
    }));
    expect(parsed.tracks[1].notes[0].channel).toBe(9);
    expect(parsed.tracks[1].events).toContainEqual({ beat: 0, status: 0xc9, data: [40] });
    expect(parsed.tracks[1].events).toContainEqual({ beat: 0.5, status: 0xb9, data: [1, 64] });
    expect(parsed.tracks[1].events).toContainEqual({ beat: 1, status: 0xff, data: [0x05, 0x68, 0x69] });
  });

  it("converts SMPTE-clocked SMF event times into musical beats", () => {
    // Type 0, -24 fps, 40 ticks/frame: 960 ticks/second. A note lasting
    // 0.5 seconds is one quarter note at the SMF default 120 BPM.
    const bytes = Uint8Array.from([
      0x4d,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, 0xe8,40,
      0x4d,0x54,0x72,0x6b, 0,0,0,13,
      0,0x90,60,100, 0x83,0x60,0x80,60,0, 0,0xff,0x2f,0,
    ]);
    const parsed = parseStandardMidiFile(bytes);
    expect(parsed.tracks[0].notes[0].startBeats).toBe(0);
    expect(parsed.tracks[0].notes[0].durationBeats).toBeCloseTo(1, 5);
    expect(parsed.tracks[0].durationBeats).toBeCloseTo(1, 5);
  });

  it("keeps SMPTE-clocked controller events aligned with notes", () => {
    // -24 fps * 40 ticks/frame = 960 ticks/second. At the default 120 BPM,
    // 480 ticks is exactly one musical beat, not 480 / signed-SMPTE division.
    const bytes = Uint8Array.from([
      0x4d,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, 0xe8,40,
      0x4d,0x54,0x72,0x6b, 0,0,0,9,
      0x83,0x60,0xb0,1,64, 0,0xff,0x2f,0,
    ]);
    const parsed = parseStandardMidiFile(bytes);
    expect(parsed.tracks[0].events).toContainEqual({ beat: 1, status: 0xb0, data: [1, 64] });
  });

  it("keeps SMF Format 2 sequences and their independent tempo maps separate", () => {
    const makeTrack = (name: string, micros: number) => {
      const body = [
        0, 0xff, 0x03, 1, name.charCodeAt(0),
        0, 0xff, 0x51, 3, (micros >>> 16) & 0xff, (micros >>> 8) & 0xff, micros & 0xff,
        0, 0x90, 60, 100,
        0x83, 0x60, 0x80, 60, 0,
        0, 0xff, 0x2f, 0,
      ];
      return [0x4d,0x54,0x72,0x6b, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff,
        (body.length >>> 8) & 0xff, body.length & 0xff, ...body];
    };
    const first = makeTrack("A", 500_000);
    const second = makeTrack("B", 250_000);
    const bytes = Uint8Array.from([
      0x4d,0x54,0x68,0x64, 0,0,0,6, 0,2, 0,2, 1,0xe0,
      ...first, ...second,
    ]);
    const parsed = parseStandardMidiFile(bytes);
    expect(parsed.format).toBe(2);
    expect(parsed.tempoEvents).toEqual([]);
    expect(parsed.tracks.map((track) => track.tempoEvents?.[0].bpm)).toEqual([120, 240]);
    expect(parsed.tracks.map((track) => track.notes[0].durationBeats)).toEqual([1, 1]);
  });

  it("can export from the first region rather than project zero", () => {
    const parsed = parseStandardMidiFile(writeStandardMidiFile(
      [{ name: "Piano", regions: [region] }],
      { bpm: 120, numerator: 4, denominator: 4,
        fromProjectStart: false, expandLoops: false },
    ));
    expect(parsed.tracks[1].notes[0].startBeats).toBe(0.5);
  });

  it("expands looped notes only when requested", () => {
    const looped = { ...region, startBeats: 0, durationBeats: 8, loop: true };
    const options = { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true };
    const expanded = parseStandardMidiFile(writeStandardMidiFile(
      [{ name: "Loop", regions: [looped] }], { ...options, expandLoops: true },
    ));
    const sourceOnly = parseStandardMidiFile(writeStandardMidiFile(
      [{ name: "Loop", regions: [looped] }], { ...options, expandLoops: false },
    ));
    expect(expanded.tracks[1].notes.map((note) => note.startBeats)).toEqual([0.5, 4.5]);
    expect(sourceOnly.tracks[1].notes).toHaveLength(1);
  });

  it("exports only the trimmed MIDI loop source window", () => {
    const trimmed: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 8,
      clipOffsetBeats: 7,
      loop: true,
      loopStartBeats: 7,
      loopLengthBeats: 5,
      notes: [
        { ...region.notes[0], id: 20, pitch: 60, startBeats: 2 },
        { ...region.notes[0], id: 21, pitch: 61, startBeats: 7.5 },
        { ...region.notes[0], id: 22, pitch: 62, startBeats: 11.5 },
        { ...region.notes[0], id: 23, pitch: 63, startBeats: 12 },
      ],
    };
    const parsed = parseStandardMidiFile(writeStandardMidiFile(
      [{ name: "Trimmed", regions: [trimmed] }],
      { bpm: 120, numerator: 4, denominator: 4,
        fromProjectStart: true, expandLoops: true },
    ));
    expect(parsed.tracks[1].notes.map((note) => [note.pitch, note.startBeats]))
      .toEqual([[61, 0.5], [62, 4.5], [61, 5.5]]);
  });

  it("rejects invalid headers and truncated chunks", () => {
    expect(() => parseStandardMidiFile(new Uint8Array([1, 2, 3]))).toThrow();
    const bytes = writeStandardMidiFile([{ name: "Piano", regions: [region] }], {
      bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: true,
    });
    expect(() => parseStandardMidiFile(bytes.subarray(0, bytes.length - 3))).toThrow();
  });

  it("concatenates chosen songs with tempo and meter changes at exact boundaries", () => {
    const makeSong = (name: string, bpm: number, numerator: number, midi: MidiRegionRow): SongRow => ({
      name, bpm, tsNum: numerator, tsDen: 4, mode: "auto", endSeconds: 2,
      click: false, clickBusId: "", clickSends: [],
      regions: [], midiRegions: [midi], events: [],
    });
    const songA = makeSong("A", 120, 4, { ...region, startBeats: 0 });
    const songB = makeSong("B", 90, 3, { ...region, startBeats: 0 });
    const parsed = parseStandardMidiFile(writeSongsMidiFile([songA, songB], {
      songIndices: [0, 1], tracks: [{ id: "t1", name: "Piano" }],
      fromProjectStart: true, expandLoops: true,
    }));
    expect(parsed.tempoEvents.map((event) => event.beat)).toEqual([0, 4]);
    expect(parsed.tempoEvents[1].bpm).toBeCloseTo(90, 2);
    expect(parsed.meterEvents.map((event) => event.numerator)).toEqual([4, 3]);
    expect(parsed.tracks[1].notes.map((note) => note.startBeats)).toEqual([0.5, 4.5]);
  });

  it("uses project-global track IDs to keep equally named MIDI tracks separate", () => {
    const song: SongRow = {
      name: "Two tracks", bpm: 120, tsNum: 4, tsDen: 4, mode: "auto", endSeconds: 2,
      click: false, clickBusId: "", clickSends: [], regions: [], events: [],
      midiRegions: [
        { ...region, id: "r1", trackId: "t1" },
        { ...region, id: "r2", trackId: "t2", notes: [{ ...region.notes[0], pitch: 67 }] },
      ],
    };
    const tracks = [{ id: "t1", name: "Piano" }, { id: "t2", name: "Piano" }];
    const parsed = parseStandardMidiFile(writeSongsMidiFile([song], {
      songIndices: [0], tracks, fromProjectStart: true, expandLoops: true,
    }));
    expect(parsed.tracks.slice(1).map((track) => track.notes[0]?.pitch)).toEqual([60, 67]);
    const selected = parseStandardMidiFile(writeSongsMidiFile([song], {
      songIndices: [0], tracks, trackIds: new Set(["t2"]),
      fromProjectStart: true, expandLoops: true,
    }));
    expect(selected.tracks.slice(1).map((track) => track.notes[0]?.pitch)).toEqual([67]);
  });

  it("samples Core linear BPM ramps into SMF tempo events", () => {
    const song: SongRow = {
      name: "Ramp", bpm: 120, tsNum: 4, tsDen: 4, mode: "auto", endSeconds: 2,
      click: false, clickBusId: "", clickSends: [], regions: [], events: [],
      midiRegions: [{ ...region, startBeats: 0 }],
      tempoPoints: [
        { beat: 0, bpm: 120, timeSeconds: 0, curve: 1 },
        { beat: 4, bpm: 180, timeSeconds: 0, curve: 0 },
      ],
    };
    const parsed = parseStandardMidiFile(writeSongsMidiFile([song], {
      songIndices: [0], tracks: [{ id: "t1", name: "Piano" }],
      fromProjectStart: true, expandLoops: false,
    }));
    expect(parsed.tempoEvents.length).toBeGreaterThan(16);
    expect(parsed.tempoEvents[1].bpm).toBeGreaterThan(120);
  });
});
