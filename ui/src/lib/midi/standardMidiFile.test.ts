import { describe, expect, it } from "vitest";
import { parseStandardMidiFile, writeSongsMidiFile, writeStandardMidiFile } from "./standardMidiFile";
import type { MidiRegionRow, SongRow } from "../state/types";

const region: MidiRegionRow = {
  id: "r1", trackId: "t1", name: "Pattern", startBeats: 8,
  durationBeats: 4, clipOffsetBeats: 0, loop: false, loopLengthBeats: 4,
  notes: [{
    id: 1, pitch: 60, startBeats: 0.5, durationBeats: 1.5,
    velocity: 0.8, releaseVelocity: 0.3, probability: 1,
  }],
};

describe("Standard MIDI File", () => {
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
      click: false, clickBusId: "", clickSends: [], tracks: [{
        id: "t1", name: "Piano", busId: "", file: "", gainDb: 0,
        pan: 0, mute: false, solo: false, sendsCount: 0,
      }], regions: [], midiRegions: [midi], events: [],
    });
    const songA = makeSong("A", 120, 4, { ...region, startBeats: 0 });
    const songB = makeSong("B", 90, 3, { ...region, startBeats: 0 });
    const parsed = parseStandardMidiFile(writeSongsMidiFile([songA, songB], {
      songIndices: [0, 1], fromProjectStart: true, expandLoops: true,
    }));
    expect(parsed.tempoEvents.map((event) => event.beat)).toEqual([0, 4]);
    expect(parsed.tempoEvents[1].bpm).toBeCloseTo(90, 2);
    expect(parsed.meterEvents.map((event) => event.numerator)).toEqual([4, 3]);
    expect(parsed.tracks[1].notes.map((note) => note.startBeats)).toEqual([0.5, 4.5]);
  });

  it("samples Core linear BPM ramps into SMF tempo events", () => {
    const song: SongRow = {
      name: "Ramp", bpm: 120, tsNum: 4, tsDen: 4, mode: "auto", endSeconds: 2,
      click: false, clickBusId: "", clickSends: [], tracks: [], regions: [], events: [],
      midiRegions: [{ ...region, startBeats: 0 }],
      tempoPoints: [
        { beat: 0, bpm: 120, timeSeconds: 0, curve: 1 },
        { beat: 4, bpm: 180, timeSeconds: 0, curve: 0 },
      ],
    };
    const parsed = parseStandardMidiFile(writeSongsMidiFile([song], {
      songIndices: [0], fromProjectStart: true, expandLoops: false,
    }));
    expect(parsed.tempoEvents.length).toBeGreaterThan(16);
    expect(parsed.tempoEvents[1].bpm).toBeGreaterThan(120);
  });
});
