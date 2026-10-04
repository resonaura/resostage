/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  analyzeMidi1ExportLoss,
  analyzeMidi2ExportLoss,
  adaptMidiTracksToSongTempo,
  countMidi2TimeSignatureClickIntervalLoss,
  midiExportTracksForSongs,
  midiSecondsAtBeat,
  parseStandardMidiFile,
  songBeatAtElapsedSeconds,
  writeSongsMidiFile,
  writeStandardMidiFile,
} from "@/lib/midi/standardMidiFile";
import type { MidiRegionRow, SongRow } from "@/lib/state/types";
import { midi1EventsToUmps, writeMidiClipFile } from "@/lib/midi/midiClipFile";

function sysex7Ump(status: number, payload: number[], group = 0): number[] {
  const bytes = [...payload, ...Array<number>(6 - payload.length).fill(0)];
  return [
    ((3 << 28) | (group << 24) | (status << 20) | (payload.length << 16)
      | ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) >>> 0,
    (((bytes[2] ?? 0) << 24) | ((bytes[3] ?? 0) << 16)
      | ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0)) >>> 0,
  ];
}

function smfWithTrackEvents(events: number[]): Uint8Array {
  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, (events.length >>> 24) & 0xff,
    (events.length >>> 16) & 0xff, (events.length >>> 8) & 0xff, events.length & 0xff,
    ...events,
  ]);
}

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
      meterEvents: [{ beat: 0, numerator: 3, denominator: 4, thirtySecondsPerQuarter: 12,
        midiClocksPerMetronomeClick: 36 }],
      fromProjectStart: true, expandLoops: true,
    });
    const parsed = parseStandardMidiFile(bytes);
    expect(parsed.bpm).toBeCloseTo(123, 3);
    expect(parsed.numerator).toBe(3);
    expect(parsed.denominator).toBe(4);
    expect(parsed.meterEvents[0].thirtySecondsPerQuarter).toBe(12);
    expect(parsed.meterEvents[0].midiClocksPerMetronomeClick).toBe(36);
    expect(parsed.tracks[1].name).toBe("Piano");
    expect(parsed.tracks[1].notes[0]).toMatchObject({
      pitch: 60, startBeats: 8.5, durationBeats: 1.5,
    });
  });

  it("skips unknown chunks before and between declared track chunks", () => {
    const trackChunk = (pitch: number) => [
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 12,
      0, 0x90, pitch, 100,
      0x60, 0x80, pitch, 0,
      0, 0xff, 0x2f, 0,
    ];
    const alienChunk = [0x58, 0x54, 0x52, 0x41, 0, 0, 0, 4, 0x4d, 0x54, 0x72, 0x6b];
    const file = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 1, 0xe0,
      ...alienChunk,
      ...trackChunk(60),
      ...alienChunk,
      ...trackChunk(61),
    ]);

    const parsed = parseStandardMidiFile(file);
    expect(parsed.tracks.map((track) => track.notes[0]?.pitch)).toEqual([60, 61]);
  });

  it("skips a well-formed unknown chunk after all declared tracks", () => {
    const track = [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0];
    const trailingMetadata = [0x58, 0x54, 0x52, 0x41, 0, 0, 0, 4, 0x4d, 0x54, 0x72, 0x6b];
    const file = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0,
      ...track,
      ...trailingMetadata,
    ]);

    expect(parseStandardMidiFile(file).tracks).toHaveLength(1);
  });

  it("rejects undeclared extra tracks and duplicate header chunks", () => {
    const track = [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0];
    const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0];

    expect(() => parseStandardMidiFile(Uint8Array.from([
      ...header, ...track, ...track,
    ]))).toThrow(/track count does not match/);
    expect(() => parseStandardMidiFile(Uint8Array.from([
      ...header, ...header, ...track,
    ]))).toThrow(/Unexpected MIDI header chunk/);
  });

  it("rejects truncated chunks after the declared track list", () => {
    const file = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0,
      0x58, 0x54, 0x52, 0x41, 0, 0, 0, 4, 0x01,
    ]);

    expect(() => parseStandardMidiFile(file)).toThrow(/Truncated MIDI chunk/);
  });

  it("rejects an unknown chunk whose declared payload is truncated", () => {
    const file = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0,
      0x58, 0x54, 0x52, 0x41, 0, 0, 0, 4, 0x01,
    ]);

    expect(() => parseStandardMidiFile(file)).toThrow(/Truncated MIDI chunk/);
  });

  it("honors extended SMF headers beyond an arbitrary small extension limit", () => {
    const headerExtension = Array(1_025).fill(0x5a);
    const file = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 4, 7, 0, 0, 0, 1, 1, 0xe0,
      ...headerExtension,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0,
    ]);

    expect(parseStandardMidiFile(file).tracks).toHaveLength(1);
  });

  it("rejects a truncated extended SMF header before reading a track", () => {
    const file = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 4, 7, 0, 0, 0, 1, 1, 0xe0,
      0x5a,
    ]);

    expect(() => parseStandardMidiFile(file)).toThrow(/Truncated MIDI header/);
  });

  it("does not read truncated system-event data from the next track chunk", () => {
    const firstTrackBody = [0, 0xf1];
    const firstTrack = [
      0x4d, 0x54, 0x72, 0x6b,
      0, 0, 0, firstTrackBody.length,
      ...firstTrackBody,
    ];
    const secondTrackBody = [
      0, 0x90, 60, 100,
      0x60, 0x80, 60, 0,
      0, 0xff, 0x2f, 0,
    ];
    const secondTrack = [
      0x4d, 0x54, 0x72, 0x6b,
      0, 0, 0, secondTrackBody.length,
      ...secondTrackBody,
    ];
    const file = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 1, 0xe0,
      ...firstTrack,
      ...secondTrack,
    ]);

    expect(() => parseStandardMidiFile(file)).toThrow(/MIDI event exceeds track chunk/);
  });

  it("rejects End-of-Track events with payload bytes or data beyond their track", () => {
    const makeFile = (firstTrackBody: number[]) => {
      const makeTrack = (body: number[]) => [
        0x4d, 0x54, 0x72, 0x6b,
        (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff,
        (body.length >>> 8) & 0xff, body.length & 0xff,
        ...body,
      ];
      return Uint8Array.from([
        0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 1, 0xe0,
        ...makeTrack(firstTrackBody),
        ...makeTrack([0, 0xff, 0x2f, 0]),
      ]);
    };

    expect(() => parseStandardMidiFile(makeFile([0, 0xff, 0x2f, 1, 0])))
      .toThrow(/Invalid End-of-Track event length/);
    expect(() => parseStandardMidiFile(makeFile([0, 0xff, 0x2f, 1])))
      .toThrow(/MIDI event exceeds track chunk/);
  });

  it("does not silently discard events after End-of-Track", () => {
    const file = smfWithTrackEvents([
      0, 0xff, 0x2f, 0,
      0, 0x90, 60, 100,
    ]);

    expect(() => parseStandardMidiFile(file)).toThrow(/data after End-of-Track/);
  });

  it("folds MIDI 1.0 CC 88 into one-shot 14-bit note-edge velocities", () => {
    const parsed = parseStandardMidiFile(smfWithTrackEvents([
      0, 0xb0, 88, 25,
      0, 0xb0, 1, 64,
      0, 0x90, 60, 64,
      0, 0xb0, 88, 63,
      1, 0x80, 60, 32,
      0, 0xff, 0x2f, 0,
    ]));
    const note = parsed.tracks[0].notes[0];

    expect(note).toMatchObject({
      pitch: 60,
      channel: 0,
      velocity: 64 / 127,
      releaseVelocity: 32 / 127,
      midi2: {
        group: 0,
        velocity: 0x8064,
        releaseVelocity: 0x40fc,
        attributeType: 0,
        attributeData: 0,
      },
    });
    expect(parsed.tracks[0].events).toEqual([{ beat: 0, status: 0xb0, data: [1, 64] }]);

    const clip = writeMidiClipFile([{ name: "Hi-res", regions: [{
      ...region, startBeats: 0, durationBeats: 4, events: parsed.tracks[0].events,
      notes: parsed.tracks[0].notes,
    }] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    });
    expect(parseStandardMidiFile(clip).tracks[0].notes[0].midi2).toMatchObject({
      velocity: 0x8064,
      releaseVelocity: 0x40fc,
    });
  });

  it("keeps CC 88 channel-scoped and consumes one prefix for only one note edge", () => {
    const parsed = parseStandardMidiFile(smfWithTrackEvents([
      0, 0xb0, 88, 25,
      0, 0xb0, 1, 64,
      0, 0x91, 67, 90,
      0, 0x90, 60, 64,
      0, 0x90, 61, 64,
      1, 0x80, 60, 32,
      0, 0x80, 61, 32,
      0, 0x81, 67, 32,
      0, 0xff, 0x2f, 0,
    ]));
    const notes = parsed.tracks[0].notes;

    expect(notes.map((note) => note.pitch)).toEqual([60, 61, 67]);
    expect(notes[0].midi2?.velocity).toBe(0x8064);
    expect(notes[1].midi2).toBeUndefined();
    expect(notes[2].midi2).toBeUndefined();
  });

  it("uses CC 88 for MIDI 2.0-to-MIDI 1.0 velocity export and discloses 14-bit quantization", () => {
    const highResolution: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [{
        ...region.notes[0],
        startBeats: 0.5,
        durationBeats: 1,
        midi2: { group: 0, velocity: 0x9234, releaseVelocity: 0x4567,
          attributeType: 0, attributeData: 0 },
      }],
    };
    const tracks = [{ name: "Hi-res", regions: [highResolution] }];
    const parsed = parseStandardMidiFile(writeStandardMidiFile(tracks, {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));

    expect(parsed.tracks[1].notes[0].midi2).toMatchObject({
      velocity: 0x9234,
      releaseVelocity: 0x4564,
    });
    expect(parsed.tracks[1].events?.filter((event) => event.data[0] === 88)).toEqual([]);
    expect(analyzeMidi1ExportLoss(tracks)).toMatchObject({ quantizedVelocities: 1 });
  });

  it("keeps very low nonzero MIDI 2.0 Note On velocity from becoming MIDI 1.0 Note Off", () => {
    const lowVelocity: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [{
        ...region.notes[0],
        midi2: { group: 0, velocity: 1, releaseVelocity: 0,
          attributeType: 0, attributeData: 0 },
      }],
    };
    const tracks = [{ name: "Low", regions: [lowVelocity] }];
    const parsed = parseStandardMidiFile(writeStandardMidiFile(tracks, {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));

    expect(parsed.tracks[1].notes).toHaveLength(1);
    expect(parsed.tracks[1].notes[0].velocity).toBe(1 / 127);
    expect(analyzeMidi1ExportLoss(tracks)).toMatchObject({ quantizedVelocities: 1, zeroVelocityNoteOns: 0 });
  });

  it("adds CC 88 when converting raw MIDI 2.0 Note UMPs to an SMF note", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0.5, words: [0x40903c00, 0x92340000], wordCount: 2 },
        { beat: 1.5, words: [0x40803c00, 0x45670000], wordCount: 2 },
      ],
    };
    const parsed = parseStandardMidiFile(writeStandardMidiFile([{ name: "UMP note", regions: [source] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));

    expect(parsed.tracks[1].notes[0].midi2).toMatchObject({
      velocity: 0x9234,
      releaseVelocity: 0x4564,
    });
    expect(parsed.tracks[1].events?.filter((event) => event.data[0] === 88)).toEqual([]);
    expect(analyzeMidi1ExportLoss([{ name: "UMP note", regions: [source] }]).quantizedVelocities).toBe(1);
  });

  it("ignores a CC 88 prefix before a zero-velocity Note On used as Note Off", () => {
    const parsed = parseStandardMidiFile(smfWithTrackEvents([
      0, 0xb0, 88, 25,
      0, 0x90, 60, 64,
      0, 0xb0, 88, 99,
      1, 0x90, 60, 0,
      0, 0xff, 0x2f, 0,
    ]));

    expect(parsed.tracks[0].notes[0].midi2).toMatchObject({
      velocity: 0x8064,
      releaseVelocity: 0,
    });
    expect(parsed.tracks[0].events).toEqual([]);
  });

  it("preserves malformed time-signature meta payloads as ordinary MIDI events", () => {
    const malformed = { ...region, startBeats: 0, events: [
      { beat: 0, status: 0xff, data: [0x58, 4, 4] },
      { beat: 1, status: 0xff, data: [0x58, 0, 8, 24, 8] },
    ] };
    const bytes = writeStandardMidiFile([{ name: "Raw meta", regions: [malformed] }], {
      bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false,
    });
    const parsed = parseStandardMidiFile(bytes);
    expect(parsed.tracks[1].events).toContainEqual({
      beat: 0, status: 0xff, data: [0x58, 4, 4],
    });
    expect(parsed.tracks[1].events).toContainEqual({
      beat: 1, status: 0xff, data: [0x58, 0, 8, 24, 8],
    });
    expect(parsed.meterEvents).toHaveLength(1);
    expect(parsed.meterEvents[0].midiClocksPerMetronomeClick ?? 24).toBe(24);
  });

  it.each([0, 256])("rejects SMF time-signature numerator %i that cannot be encoded", (numerator) => {
    expect(() => writeStandardMidiFile([{ name: "Piano", regions: [region] }], {
      bpm: 120, numerator: 4, denominator: 4,
      meterEvents: [{ beat: 0, numerator, denominator: 4 }],
      fromProjectStart: true, expandLoops: false,
    })).toThrow(/numerator must be an unsigned nonzero 8-bit integer/);
  });

  it("exports all persisted time-signature notation metadata from project songs", () => {
    const song: SongRow = {
      name: "Meter metadata", bpm: 120, tsNum: 6, tsDen: 8, mode: "auto", endSeconds: 2,
      click: false, clickBusId: "", clickSends: [],
      signaturePoints: [{ beat: 0, numerator: 6, denominator: 8, bar: 1,
        thirtySecondsPerQuarter: 12, midiClocksPerMetronomeClick: 36 }],
      regions: [], midiRegions: [{ ...region, startBeats: 0 }], events: [],
    };
    const bytes = writeSongsMidiFile([song], {
      songIndices: [0], tracks: [{ id: "t1", name: "Meter" }],
      fromProjectStart: true, expandLoops: false,
    });

    expect(parseStandardMidiFile(bytes).meterEvents[0]).toMatchObject({
      numerator: 6,
      denominator: 8,
      thirtySecondsPerQuarter: 12,
      midiClocksPerMetronomeClick: 36,
    });
  });

  it("reports selected MIDI 1-only metronome-click metadata lost by MIDI Clip export", () => {
    const songs = [{
      name: "Click metadata", bpm: 120, mode: "auto", tsNum: 4, tsDen: 4, endSeconds: 2,
      click: false, clickBusId: "", clickSends: [], events: [], tempoPoints: [],
      signaturePoints: [
        { beat: 0, numerator: 4, denominator: 4, bar: 1 },
        { beat: 2, numerator: 4, denominator: 4, bar: 2, midiClocksPerMetronomeClick: 36 },
        { beat: 12, numerator: 4, denominator: 4, bar: 4, midiClocksPerMetronomeClick: 48 },
      ],
      midiRegions: [], regions: [],
    }, {
      name: "Default click", bpm: 120, mode: "auto", tsNum: 4, tsDen: 4, endSeconds: 2,
      click: false, clickBusId: "", clickSends: [], events: [], tempoPoints: [],
      signaturePoints: [{ beat: 0, numerator: 4, denominator: 4, bar: 1 }],
      midiRegions: [], regions: [],
    }] as unknown as SongRow[];

    expect(countMidi2TimeSignatureClickIntervalLoss(songs, [0, 1])).toBe(1);
    expect(countMidi2TimeSignatureClickIntervalLoss(songs, [1])).toBe(0);
  });

  it("preserves zero-tick note edges through Standard MIDI File tempo adaptation", () => {
    const zeroNoteRegion: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [{ ...region.notes[0], startBeats: 1, durationBeats: 0 }],
    };
    const bytes = writeStandardMidiFile([{ name: "Zero note", regions: [zeroNoteRegion] }], {
      bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false,
    });
    const parsed = parseStandardMidiFile(bytes);
    expect(parsed.tracks[1].notes).toHaveLength(1);
    expect(parsed.tracks[1].notes[0]).toMatchObject({ startBeats: 1, durationBeats: 0 });

    const destination = {
      name: "Destination", bpm: 90, mode: "auto" as const, tsNum: 4, tsDen: 4,
      events: [], tempoPoints: [], signaturePoints: [], midiRegions: [], regions: [],
    } as unknown as SongRow;
    const adapted = adaptMidiTracksToSongTempo(parsed.tracks, [], destination);
    expect(adapted[1].notes[0].durationBeats).toBe(0);
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
      signaturePoints: [{ beat: 0, numerator: 4, denominator: 4, bar: 1, thirtySecondsPerQuarter: 13 }],
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
    expect(parsed.meterEvents[0].thirtySecondsPerQuarter).toBe(13);
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
    expect(parsed.tracks[0].umpEvents).toContainEqual({ beat: 1.25, words: opaque,
      wordCount: 4, presentationOrder: 3 });
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
      words: [0x20b20140], wordCount: 1, presentationOrder: 4 });
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

  it("reports only meaningful high-resolution MIDI 2.0 controller downscaling", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 6,
      notes: [],
      umpEvents: [
        { beat: 0, words: [0x40b20700, 0x80000001], wordCount: 2 },
        { beat: 1, words: [0x40a23c00, 0x80000001], wordCount: 2 },
        { beat: 2, words: [0x40d20000, 0x80000001], wordCount: 2 },
        { beat: 3, words: [0x40e20000, 0x80000001], wordCount: 2 },
        { beat: 4, words: [0x40200001, 0x836c1b61], wordCount: 2 },
        { beat: 4.5, words: [0x40b20700, 0xffff_ffff], wordCount: 2 },
        { beat: 4.75, words: [0x40200001, 0x836c1b60], wordCount: 2 },
        { beat: 5, words: [0x40b25400, 0x82012345], wordCount: 2 },
        { beat: 5.5, words: [0x40200000, 0xfffc1234], wordCount: 2 },
        { beat: 5.75, words: [0x40200002, 0x82012345], wordCount: 2 },
      ],
    };

    expect(analyzeMidi1ExportLoss([{ name: "Controller resolution", regions: [source] }]))
      .toMatchObject({ quantizedControllerValues: 5, unsupportedUmpEvents: 0 });
  });

  it("converts MIDI Clip SysEx7 complete and start/continue/end UMPs into SMF SysEx events", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0, words: sysex7Ump(0, [0x7e, 0x7f, 0x09, 0x01]), wordCount: 2 },
        { beat: 1, words: sysex7Ump(1, [1, 2, 3, 4, 5, 6]), wordCount: 2 },
        { beat: 1.5, words: sysex7Ump(2, [7, 8, 9]), wordCount: 2 },
        { beat: 2, words: sysex7Ump(3, [10, 11]), wordCount: 2 },
      ],
    };
    const parsed = parseStandardMidiFile(writeStandardMidiFile([{ name: "SysEx", regions: [source] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));
    expect(parsed.tracks[1].events?.filter((event) => event.status === 0xf0 || event.status === 0xf7)).toEqual([
      { beat: 0, status: 0xf0, data: [0x7e, 0x7f, 0x09, 0x01, 0xf7] },
      { beat: 1, status: 0xf0, data: [1, 2, 3, 4, 5, 6] },
      { beat: 1.5, status: 0xf7, data: [7, 8, 9] },
      { beat: 2, status: 0xf7, data: [10, 11, 0xf7] },
    ]);
  });

  it("reports incomplete or interrupted SysEx7 UMP sequences as a distinct MIDI 1.0 loss", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0, words: sysex7Ump(1, [1, 2, 3]), wordCount: 2 },
        { beat: 1, words: [0x20c00100], wordCount: 1 },
      ],
    };
    expect(analyzeMidi1ExportLoss([{ name: "Interrupted SysEx", regions: [source] }]))
      .toMatchObject({ invalidUmpSysExMessages: 1, unsupportedUmpEvents: 0 });
  });

  it("does not report dropped UMPs as interrupting an exported SysEx7 sequence", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0, words: sysex7Ump(1, [1, 2]), wordCount: 2 },
        { beat: 0.5, words: [0x50000000, 0, 0, 0], wordCount: 4 },
        { beat: 0.75, words: [0x10f80000], wordCount: 1 },
        { beat: 1, words: sysex7Ump(3, [3, 4]), wordCount: 2 },
      ],
    };
    const tracks = [{ name: "SysEx with omitted UMP", regions: [source] }];

    expect(analyzeMidi1ExportLoss(tracks))
      .toMatchObject({ invalidUmpSysExMessages: 0, unsupportedUmpEvents: 1 });
    const parsed = parseStandardMidiFile(writeStandardMidiFile(tracks, {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));
    expect(parsed.tracks[1].events?.filter((event) =>
      event.status === 0xf0 || event.status === 0xf7 || event.status === 0xf8,
    )).toEqual([
      { beat: 0, status: 0xf0, data: [1, 2] },
      { beat: 0.75, status: 0xf8, data: [] },
      { beat: 1, status: 0xf7, data: [3, 4, 0xf7] },
    ]);
  });

  it("converts complete and fragmented SMF SysEx into MIDI Clip SysEx7 UMPs", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      events: [
        { beat: 0, status: 0xf0, data: [0x7e, 0x7f, 0x09, 0x01, 0xf7] },
        { beat: 1, status: 0xf0, data: [1, 2, 3, 4, 5, 6] },
        { beat: 1.5, status: 0xf7, data: [7, 8, 9] },
        { beat: 2, status: 0xf7, data: [10, 11, 0xf7] },
      ],
    };
    const parsed = parseStandardMidiFile(writeMidiClipFile([{ name: "SysEx", regions: [source] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));
    const events = parsed.tracks[0].umpEvents ?? [];
    expect(events.map((event) => event.words)).toEqual([
      sysex7Ump(0, [0x7e, 0x7f, 0x09, 0x01]),
      sysex7Ump(1, [1, 2, 3, 4, 5, 6]),
      sysex7Ump(2, [7, 8, 9]),
      sysex7Ump(3, [10, 11]),
    ]);
    expect(analyzeMidi2ExportLoss([{ name: "SysEx", regions: [source] }]))
      .toEqual({ unsupportedMidi1Events: 0 });
  });

  it("folds MIDI 1.0 Bank Select into the next same-channel MIDI 2.0 Program Change", () => {
    const converted = midi1EventsToUmps([
      { beat: 0, status: 0xb2, data: [0, 7] },
      { beat: 0.25, status: 0xb2, data: [32, 9] },
      { beat: 0.5, status: 0xc2, data: [0x45] },
      { beat: 1, status: 0xc2, data: [0x46] },
    ]);
    expect(converted.events.map((event) => event.words)).toEqual([
      [0x40c20001, 0x45000709],
      [0x40c20000, 0x46000000],
    ]);
    expect(converted.unsupportedEventCount).toBe(0);
  });

  it("reports standalone Bank Select and unsupported compound CCs instead of encoding ordinary MIDI 2.0 CCs", () => {
    const converted = midi1EventsToUmps([
      { beat: 0, status: 0xb0, data: [0, 3] },
      { beat: 0.25, status: 0xb0, data: [32, 4] },
      { beat: 0.5, status: 0xb0, data: [101, 0] },
      { beat: 0.75, status: 0xb0, data: [6, 12] },
      { beat: 1, status: 0xb0, data: [88, 25] },
    ]);
    expect(converted.events).toEqual([]);
    expect(converted.unsupportedEventCount).toBe(4);
  });

  it("converts complete MIDI 1.0 RPN data entry to a MIDI 2.0 Registered Controller", () => {
    const converted = midi1EventsToUmps([
      { beat: 0, status: 0xb2, data: [101, 0] },
      { beat: 0, status: 0xb2, data: [100, 0] },
      { beat: 1, status: 0xb2, data: [6, 2] },
      { beat: 1.25, status: 0xb2, data: [38, 50] },
    ]);

    expect(converted.events).toMatchObject([
      { beat: 1.25, words: [0x40220000, 0x04c80000] },
    ]);
    expect(converted.unsupportedEventCount).toBe(0);
  });

  it("zero-extends the fixed-width MIDI 2.0 values for standard integer RPNs", () => {
    const events = (index: number, msb = 65, lsb = 91) => midi1EventsToUmps([
      { beat: 0, status: 0xb0, data: [101, 0] },
      { beat: 0, status: 0xb0, data: [100, index] },
      { beat: 1, status: 0xb0, data: [6, msb] },
      { beat: 1, status: 0xb0, data: [38, lsb] },
    ]);

    expect(events(0, 127, 127).events[0]?.words).toEqual([0x40200000, 0xfffc0000]);
    expect(events(1).events[0]?.words).toEqual([0x40200001, 0x836c1b60]);
    for (const index of [2, 3, 4, 6]) {
      expect(events(index).events[0]?.words).toEqual([0x40200000 | index, 0x82000000]);
    }
  });

  it("converts NRPN per channel and flushes a 7-bit Data Entry MSB at its original beat", () => {
    const converted = midi1EventsToUmps([
      { beat: 0, status: 0xb0, data: [101, 0] },
      { beat: 0, status: 0xb0, data: [100, 1] },
      { beat: 0.25, status: 0xb0, data: [6, 1] },
      { beat: 0, status: 0xb5, data: [99, 12] },
      { beat: 0, status: 0xb5, data: [98, 34] },
      { beat: 0.5, status: 0xb5, data: [6, 64] },
      { beat: 1, status: 0xb0, data: [6, 3] },
    ]);

    expect(converted.events.map((event) => ({ beat: event.beat, words: event.words }))).toEqual([
      { beat: 0.25, words: [0x40200001, 0x02000000] },
      { beat: 0.5, words: [0x40350c22, 0x80000000] },
      { beat: 1, words: [0x40200001, 0x06000000] },
    ]);
    expect(converted.unsupportedEventCount).toBe(0);
  });

  it("keeps MIDI Clip channel state across tracks and regions in the merged UMP stream", () => {
    const selectorTrack: MidiRegionRow = {
      ...region,
      id: "selectors",
      trackId: "t1",
      startBeats: 0,
      durationBeats: 2,
      notes: [],
      events: [
        { beat: 0, status: 0xb0, data: [0, 7] },
        { beat: 0, status: 0xb0, data: [32, 9] },
        { beat: 0, status: 0xb0, data: [101, 0] },
        { beat: 0, status: 0xb0, data: [100, 1] },
        { beat: 0.5, status: 0xb0, data: [6, 2] },
      ],
    };
    const completionTrack: MidiRegionRow = {
      ...region,
      id: "completion",
      trackId: "t2",
      startBeats: 1,
      durationBeats: 2,
      notes: [],
      events: [
        { beat: 0, status: 0xb0, data: [38, 50] },
        { beat: 0.25, status: 0xc0, data: [0x45] },
      ],
    };
    const sysexStartTrack: MidiRegionRow = {
      ...region,
      id: "sysex-start",
      trackId: "t3",
      startBeats: 2,
      durationBeats: 2,
      notes: [],
      events: [{ beat: 0, status: 0xf0, data: [0x41, 0x01] }],
    };
    const sysexEndTrack: MidiRegionRow = {
      ...region,
      id: "sysex-end",
      trackId: "t4",
      startBeats: 3,
      durationBeats: 2,
      notes: [],
      events: [{ beat: 0, status: 0xf7, data: [0x02, 0xf7] }],
    };
    const tracks = [
      { name: "Controls", regions: [selectorTrack] },
      { name: "Program", regions: [completionTrack] },
      { name: "SysEx start", regions: [sysexStartTrack] },
      { name: "SysEx end", regions: [sysexEndTrack] },
    ];
    const parsed = parseStandardMidiFile(writeMidiClipFile(tracks, {
      bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false,
    }));

    expect(parsed.tracks[0].umpEvents?.map((event) => ({ beat: event.beat, words: event.words })))
      .toEqual([
        { beat: 1, words: [0x40200001, 0x04c80000] },
        { beat: 1.25, words: [0x40c00001, 0x45000709] },
        { beat: 2, words: sysex7Ump(1, [0x41, 0x01]) },
        { beat: 3, words: sysex7Ump(3, [0x02]) },
      ]);
    expect(analyzeMidi2ExportLoss(tracks)).toEqual({ unsupportedMidi1Events: 0 });
  });

  it("does not translate RPN null selection or incomplete/orphan Data Entry", () => {
    const converted = midi1EventsToUmps([
      { beat: 0, status: 0xb0, data: [101, 127] },
      { beat: 0, status: 0xb0, data: [100, 127] },
      { beat: 0.25, status: 0xb0, data: [6, 1] },
      { beat: 1, status: 0xb1, data: [100, 5] },
      { beat: 1.25, status: 0xb1, data: [6, 2] },
      { beat: 2, status: 0xb2, data: [38, 3] },
    ]);

    expect(converted.events).toEqual([]);
    expect(converted.unsupportedEventCount).toBe(3);
  });

  it("keeps ordinary 14-bit controller MSB and LSB messages independent", () => {
    const converted = midi1EventsToUmps([
      { beat: 0, status: 0xb0, data: [1, 64] },
      { beat: 0.25, status: 0xb0, data: [33, 127] },
    ]);

    expect(converted.events.map((event) => event.words)).toEqual([
      [0x2b000140],
      [0x2b00217f],
    ]);
    expect(converted.unsupportedEventCount).toBe(0);
  });

  it("converts MIDI 1.0 system common/realtime UMPs and reports group loss", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0, words: [0x10f22345], wordCount: 1 },
        { beat: 1, words: [0x10f10700], wordCount: 1 },
        { beat: 2, words: [0x11f80000], wordCount: 1 },
      ],
    };
    const parsed = parseStandardMidiFile(writeStandardMidiFile([{ name: "System", regions: [source] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));
    expect(parsed.tracks[1].events?.filter((event) => [0xf1, 0xf2, 0xf8].includes(event.status))).toEqual([
      { beat: 0, status: 0xf2, data: [0x23, 0x45] },
      { beat: 1, status: 0xf1, data: [0x07] },
      { beat: 2, status: 0xf8, data: [] },
    ]);
    expect(analyzeMidi1ExportLoss([{ name: "System", regions: [source] }]).nonzeroGroupUmpEvents).toBe(1);
  });

  it("converts MIDI 2.0 Program Change with optional bank select to ordered MIDI 1.0 events", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0, words: [0x40c20000, 0x23000000], wordCount: 2 },
        { beat: 1, words: [0x40c20001, 0x45000709], wordCount: 2 },
      ],
    };
    const parsed = parseStandardMidiFile(writeStandardMidiFile([{ name: "Programs", regions: [source] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));
    expect(parsed.tracks[1].events?.filter((event) => [0xb2, 0xc2].includes(event.status))).toEqual([
      { beat: 0, status: 0xc2, data: [0x23] },
      { beat: 1, status: 0xb2, data: [0, 0x07] },
      { beat: 1, status: 0xb2, data: [32, 0x09] },
      { beat: 1, status: 0xc2, data: [0x45] },
    ]);
    expect(analyzeMidi1ExportLoss([{ name: "Programs", regions: [source] }]).unsupportedUmpEvents).toBe(0);
  });

  it("expands MIDI 2.0 RPN and NRPN controllers to ordered MIDI 1.0 selector/data messages", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0.5, words: [0x40200000, 0x04c80000], wordCount: 2 },
        { beat: 1.5, words: [0x40350c22, 0x80000000], wordCount: 2 },
      ],
    };
    const parsed = parseStandardMidiFile(writeStandardMidiFile([{ name: "Parameters", regions: [source] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));

    expect(parsed.tracks[1].events?.filter((event) => (event.status & 0xf0) === 0xb0)).toEqual([
      { beat: 0.5, status: 0xb0, data: [101, 0] },
      { beat: 0.5, status: 0xb0, data: [100, 0] },
      { beat: 0.5, status: 0xb0, data: [6, 2] },
      { beat: 0.5, status: 0xb0, data: [38, 50] },
      { beat: 1.5, status: 0xb5, data: [99, 12] },
      { beat: 1.5, status: 0xb5, data: [98, 34] },
      { beat: 1.5, status: 0xb5, data: [6, 64] },
      { beat: 1.5, status: 0xb5, data: [38, 0] },
    ]);
    expect(analyzeMidi1ExportLoss([{ name: "Parameters", regions: [source] }]).unsupportedUmpEvents).toBe(0);
  });

  it("translates standard integer RPNs from their defined MIDI 2.0 data fields", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 6,
      notes: [],
      umpEvents: [0, 1, 2, 3, 4, 6].map((index, order) => ({
        beat: order + 0.5,
        words: [
          0x40200000 | index,
          index === 0 ? 0xfffc1234 : index === 1 ? 0x836c1b60 : 0x82012345,
        ],
        wordCount: 2,
      })),
    };
    const parsed = parseStandardMidiFile(writeStandardMidiFile([{ name: "Integer RPNs", regions: [source] }], {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false,
    }));

    const expectedParameterEvents = [0, 1, 2, 3, 4, 6].flatMap((index, order) => {
      const beat = order + 0.5;
      const valueMsb = index === 0 ? 127 : 65;
      const valueLsb = index === 0 ? 127 : index === 1 ? 91 : 0;
      return [
        { beat, status: 0xb0, data: [101, 0] },
        { beat, status: 0xb0, data: [100, index] },
        { beat, status: 0xb0, data: [6, valueMsb] },
        { beat, status: 0xb0, data: [38, valueLsb] },
      ];
    });
    expect(parsed.tracks[1].events?.filter((event) => (event.status & 0xf0) === 0xb0))
      .toEqual(expectedParameterEvents);
    expect(analyzeMidi1ExportLoss([{ name: "Integer RPNs", regions: [source] }]).unsupportedUmpEvents).toBe(0);
  });

  it("rejects malformed MIDI 2.0 Program Change reserved bits and invalid absent-bank fields", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0, words: [0x40c20002, 0x23000000], wordCount: 2 },
        { beat: 1, words: [0x40c20000, 0x23000100], wordCount: 2 },
      ],
    };
    expect(analyzeMidi1ExportLoss([{ name: "Invalid programs", regions: [source] }]).unsupportedUmpEvents).toBe(2);
  });

  it("rejects malformed MIDI 1.0 Channel Voice UMP data and padding bits", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0, words: [0x20908080], wordCount: 1 },
        { beat: 1, words: [0x20c10001], wordCount: 1 },
      ],
    };
    expect(analyzeMidi1ExportLoss([{ name: "Invalid MIDI 1 UMP", regions: [source] }]).unsupportedUmpEvents).toBe(2);
  });

  it("rejects reserved bits in MIDI 2.0 RPN and NRPN addresses", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      umpEvents: [
        { beat: 0, words: [0x40208000, 0], wordCount: 2 },
        { beat: 1, words: [0x40300080, 0], wordCount: 2 },
      ],
    };
    expect(analyzeMidi1ExportLoss([{ name: "Invalid parameters", regions: [source] }]).unsupportedUmpEvents).toBe(2);
  });

  it("reports MIDI 1.0 escapes and unrepresentable metadata before MIDI Clip export", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      events: [
        { beat: 0, status: 0xf7, data: [0x7e, 0x7f] },
        { beat: 1, status: 0xff, data: [0x06, 0x41] },
      ],
    };
    expect(analyzeMidi2ExportLoss([{ name: "Legacy", regions: [source] }]))
      .toEqual({ unsupportedMidi1Events: 2 });
  });

  it("exports representable MIDI Clip setup at SMF track start outside trim and loop expansion", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      clipOffsetBeats: 4,
      loop: true,
      loopStartBeats: 4,
      loopLengthBeats: 2,
      notes: [{ ...region.notes[0], startBeats: 4, durationBeats: 1 }],
      umpEvents: [
        { beat: 0, words: [0x20c00500], wordCount: 1, configurationHeader: true },
        { beat: 0, words: [0x3016_f07e, 0x7f0d_2201], wordCount: 2,
          configurationHeader: true, profileConfigurationHeader: true },
        { beat: 4, words: [0x20c00700], wordCount: 1 },
      ],
    };
    const tracks = [{ name: "Configured", regions: [source] }];
    const parsed = parseStandardMidiFile(writeStandardMidiFile(tracks, {
      bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: true,
    }));

    expect(parsed.tracks[1].events?.filter((event) => event.status === 0xc0)).toEqual([
      { beat: 0, status: 0xc0, data: [5] },
      { beat: 0, status: 0xc0, data: [7] },
      { beat: 2, status: 0xc0, data: [7] },
    ]);
    expect(parsed.tracks[1].notes).toHaveLength(2);
    expect(analyzeMidi1ExportLoss(tracks).unsupportedUmpEvents).toBe(1);
  });

  it("reports MIDI 2.0 note and opaque UMP losses before legacy export", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      notes: [{ ...region.notes[0], midi2: {
        group: 2, velocity: 0x9234, releaseVelocity: 0x4567,
        attributeType: 1, attributeData: 0xbeef,
        releaseAttributeType: 0, releaseAttributeData: 0,
      } }],
      umpEvents: [{ beat: 1, words: [0x50000000, 0, 0, 0], wordCount: 4 }],
    };
    expect(analyzeMidi1ExportLoss([{ name: "Expressive", regions: [source] }])).toEqual({
      midi2Notes: 1,
      noteAttributes: 1,
      groups: 1,
      zeroVelocityNoteOns: 0,
      quantizedVelocities: 1,
      quantizedControllerValues: 0,
      nonzeroGroupUmpEvents: 0,
      invalidUmpSysExMessages: 0,
      unsupportedUmpEvents: 1,
    });

    const releaseOnly = { ...source, notes: [{ ...source.notes[0], midi2: {
      ...source.notes[0].midi2!, attributeType: 0, attributeData: 0,
      releaseAttributeType: 2, releaseAttributeData: 0x1234,
    } }] };
    expect(analyzeMidi1ExportLoss([{ name: "Release attribute", regions: [releaseOnly] }]).noteAttributes).toBe(1);
  });

  it("reports and preserves MIDI 2.0 zero-velocity Note On during lossy MIDI 1 export", () => {
    const source: MidiRegionRow = {
      ...region,
      startBeats: 0,
      notes: [{ ...region.notes[0], midi2: {
        group: 0, velocity: 0, releaseVelocity: 0, attributeType: 0, attributeData: 0,
      } }],
    };
    expect(analyzeMidi1ExportLoss([{ name: "Zero attack", regions: [source] }])).toMatchObject({
      zeroVelocityNoteOns: 1,
      quantizedVelocities: 0,
    });

    const parsed = parseStandardMidiFile(writeStandardMidiFile(
      [{ name: "Zero attack", regions: [source] }],
      { bpm: 120, numerator: 4, denominator: 4, fromProjectStart: true, expandLoops: false },
    ));
    expect(parsed.tracks[1].notes[0].velocity).toBeCloseTo(1 / 127, 6);
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

  it("bounds loop-expanded raw MIDI payloads to the parser file-size limit", () => {
    const repeatedPayload = Array(1_000_000).fill(0);
    const looped: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 40,
      clipOffsetBeats: 0,
      loop: true,
      loopStartBeats: 0,
      loopLengthBeats: 1,
      notes: [],
      events: [{ beat: 0.25, status: 0xf7, data: repeatedPayload }],
      umpEvents: [],
    };

    expect(() => writeStandardMidiFile([{ name: "Large loop", regions: [looped] }], {
      bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: true,
    })).toThrow(/32 MiB file size limit/);
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

  it("writes only four-byte SMF variable-length values and rejects invalid event times", () => {
    const maximumDelta = 0x0fffffff;
    const boundaryRegion: MidiRegionRow = {
      ...region,
      startBeats: maximumDelta / 480 - region.notes[0].startBeats,
      durationBeats: 4,
    };
    const boundaryBytes = writeStandardMidiFile([{ name: "Boundary", regions: [boundaryRegion] }], {
      bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false,
    });
    expect(parseStandardMidiFile(boundaryBytes).tracks[1].notes[0].startBeats)
      .toBeCloseTo(maximumDelta / 480, 5);

    const tooFarRegion: MidiRegionRow = {
      ...boundaryRegion,
      startBeats: (maximumDelta + 1) / 480 - region.notes[0].startBeats,
    };
    expect(() => writeStandardMidiFile([{ name: "Too far", regions: [tooFarRegion] }], {
      bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false,
    })).toThrow(/integers from 0 to 0x0FFFFFFF/);

    const invalidEventTime: MidiRegionRow = {
      ...region,
      startBeats: 0,
      notes: [],
      events: [{ beat: Number.NaN, status: 0x90, data: [60, 100] }],
    };
    expect(() => writeStandardMidiFile([{ name: "Invalid", regions: [invalidEventTime] }], {
      bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false,
    })).toThrow(/integers from 0 to 0x0FFFFFFF/);
  });

  it("keeps exported event count within the parser limit including metadata", () => {
    const repeatedEvent = { beat: 0, status: 0x90, data: [60, 100] };
    const denseRegion: MidiRegionRow = {
      ...region,
      startBeats: 0,
      durationBeats: 4,
      notes: [],
      events: Array(199_996).fill(repeatedEvent),
      umpEvents: [],
    };

    expect(() => writeStandardMidiFile([{ name: "Dense", regions: [denseRegion] }], {
      bpm: 120, numerator: 4, denominator: 4,
      fromProjectStart: true, expandLoops: false,
    })).toThrow(/200,000 total event limit/);
  });

  it.each([
    [0, 0x90, 0x80, 100, 0, 0xff, 0x2f, 0],
    [0, 0x90, 60, 0x80, 0, 0xff, 0x2f, 0],
  ])("rejects a MIDI channel-voice data byte with its status bit set", (...events) => {
    expect(() => parseStandardMidiFile(smfWithTrackEvents(events))).toThrow(
      /channel voice data bytes must be 7-bit values/,
    );
  });

  it.each([
    [0, 0xf1, 0x80, 0, 0xff, 0x2f, 0],
    [0, 0xf2, 0x01, 0x80, 0, 0xff, 0x2f, 0],
    [0, 0xf3, 0x80, 0, 0xff, 0x2f, 0],
  ])("rejects a MIDI System Common data byte with its status bit set", (...events) => {
    expect(() => parseStandardMidiFile(smfWithTrackEvents(events))).toThrow(
      /system event data bytes must be 7-bit values/,
    );
  });

  it("rejects malformed stored MIDI events instead of writing broken track data", () => {
    const malformedEvents = [
      { beat: 0, status: 0x90, data: [60, 0x80] },
      { beat: 0, status: 0xc0, data: [12, 13] },
      { beat: 0, status: 0xff, data: [0x2f] },
      { beat: 0, status: 0xf1, data: [0x80] },
      { beat: 0, status: 0xf5, data: [] },
    ];
    for (const event of malformedEvents) {
      const invalidRegion: MidiRegionRow = { ...region, startBeats: 0, notes: [], events: [event] };
      expect(() => writeStandardMidiFile([{ name: "Malformed", regions: [invalidRegion] }], {
        bpm: 120, numerator: 4, denominator: 4,
        fromProjectStart: true, expandLoops: false,
      })).toThrow();
    }
  });

  it("keeps running status across System Real-Time events but clears it for System Common", () => {
    const parsed = parseStandardMidiFile(smfWithTrackEvents([
      0, 0x90, 60, 100,
      0, 0xf8,
      0, 61, 100,
      0, 0xff, 0x2f, 0,
    ]));
    expect(parsed.tracks[0].notes.map((note) => note.pitch)).toEqual([60, 61]);
    expect(parsed.tracks[0].events).toContainEqual({ beat: 0, status: 0xf8, data: [] });

    expect(() => parseStandardMidiFile(smfWithTrackEvents([
      0, 0x90, 60, 100,
      0, 0xf1, 1,
      0, 61, 100,
      0, 0xff, 0x2f, 0,
    ]))).toThrow(/running status without preceding event/);
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

  it("shares MIDI Clip RPN state across concatenated song boundaries", () => {
    const makeSong = (name: string, midi: MidiRegionRow): SongRow => ({
      name, bpm: 120, tsNum: 4, tsDen: 4, mode: "auto", endSeconds: 2,
      click: false, clickBusId: "", clickSends: [], regions: [], events: [],
      midiRegions: [midi],
    });
    const songA = makeSong("A", {
      ...region, startBeats: 0, durationBeats: 4, notes: [],
      events: [
        { beat: 0, status: 0xb0, data: [101, 0] },
        { beat: 0, status: 0xb0, data: [100, 1] },
        { beat: 1, status: 0xb0, data: [6, 2] },
      ],
    });
    const songB = makeSong("B", {
      ...region, startBeats: 0, durationBeats: 4, notes: [],
      events: [{ beat: 0, status: 0xb0, data: [38, 50] }],
    });
    const tracks = [{ id: "t1", name: "Piano" }];
    const exportedTracks = midiExportTracksForSongs([songA, songB], {
      songIndices: [0, 1], tracks,
    });
    expect(exportedTracks[0].regions.map((item) => item.startBeats)).toEqual([0, 4]);
    expect(analyzeMidi2ExportLoss(exportedTracks, {
      fromProjectStart: true, expandLoops: false,
    })).toEqual({ unsupportedMidi1Events: 0 });

    const parsed = parseStandardMidiFile(writeSongsMidiFile([songA, songB], {
      songIndices: [0, 1], tracks, fromProjectStart: true, expandLoops: false, format: "midi2",
    }));
    expect(parsed.tracks[0].umpEvents?.map((event) => ({ beat: event.beat, words: event.words })))
      .toEqual([{ beat: 4, words: [0x40200001, 0x04c80000] }]);
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
