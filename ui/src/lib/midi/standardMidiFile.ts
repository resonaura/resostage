/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiNoteRow, MidiRegionRow, SongRow } from "@/lib/state/types";
import { isMidiClipFile, parseMidiClipFile, writeMidiClipFile } from "@/lib/midi/midiClipFile";
import { midiRegionContainsLoopSourceBeat, midiRegionLoopOccurrence } from "@/lib/midi/midiRegionTiming";
import { songBeatsAtSeconds, songSecondsAtBeat } from "@/lib/midi/tempoMap";

export { songBeatsAtSeconds, songSecondsAtBeat } from "@/lib/midi/tempoMap";

const PPQN = 480;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TRACKS = 256;
const MAX_EVENTS = 200_000;

export interface MidiMeterEvent {
  beat: number;
  numerator: number;
  denominator: number;
  /** MIDI time-signature notation field: count of 1/32 notes per quarter note. */
  thirtySecondsPerQuarter?: number;
  /** Standard MIDI File time-signature field: clocks per metronome click. */
  midiClocksPerMetronomeClick?: number;
}

export interface ImportedMidiTrack {
  name: string;
  notes: MidiNoteRow[];
  events?: Array<{ beat: number; status: number; data: number[] }>;
  umpEvents?: Array<{
    beat: number;
    words: number[];
    wordCount: number;
    configurationHeader?: boolean;
    profileConfigurationHeader?: boolean;
    presentationOrder?: number;
  }>;
  /** Format 2 stores an independent tempo and meter map per sequence. */
  tempoEvents?: Array<{ beat: number; bpm: number }>;
  meterEvents?: MidiMeterEvent[];
  durationBeats: number;
}

export interface ImportedMidiFile {
  format: 0 | 1 | 2 | "midi2-clip";
  tracks: ImportedMidiTrack[];
  bpm?: number;
  numerator?: number;
  denominator?: number;
  tempoEvents: Array<{ beat: number; bpm: number }>;
  meterEvents: MidiMeterEvent[];
}

class Reader {
  offset = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  byte(): number {
    if (this.offset >= this.bytes.length) throw new Error("Truncated MIDI file");
    return this.bytes[this.offset++];
  }
  uint16(): number { return (this.byte() << 8) | this.byte(); }
  uint32(): number { return (this.uint16() * 65536 + this.uint16()) >>> 0; }
  fourCC(): string {
    return String.fromCharCode(this.byte(), this.byte(), this.byte(), this.byte());
  }
  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.byte();
      value = (value << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error("Invalid MIDI variable-length quantity");
  }
  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length)
      throw new Error("Truncated MIDI track");
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
}

/** Parse SMF 0/1 on PPQN or SMPTE clocks, retaining paired notes and MIDI events. */
export function parseStandardMidiFile(bytes: Uint8Array): ImportedMidiFile {
  if (bytes.length > MAX_BYTES) throw new Error("MIDI file exceeds 32 MiB limit");
  if (isMidiClipFile(bytes)) return parseMidiClipFile(bytes);
  const reader = new Reader(bytes);
  if (reader.fourCC() !== "MThd") throw new Error("Not a Standard MIDI File");
  const headerLength = reader.uint32();
  if (headerLength < 6 || headerLength > 1024) throw new Error("Invalid MIDI header");
  const format = reader.uint16();
  const count = reader.uint16();
  const division = reader.uint16();
  reader.take(headerLength - 6);
  if (format > 2 || count < 1 || count > MAX_TRACKS || (format === 0 && count !== 1))
    throw new Error("Only MIDI format 0/1/2 with up to 256 tracks is supported");
  const smpte = (division & 0x8000) !== 0;
  let ticksPerSecond = 0;
  if (smpte) {
    const frameCode = (division >> 8) - 256;
    const ticksPerFrame = division & 0xff;
    const framesPerSecond = frameCode === -29 ? 30_000 / 1_001 : Math.abs(frameCode);
    if (![-24, -25, -29, -30].includes(frameCode) || ticksPerFrame === 0)
      throw new Error("Invalid SMPTE time division");
    ticksPerSecond = framesPerSecond * ticksPerFrame;
  } else if (division === 0) {
    throw new Error("Invalid MIDI PPQN time division");
  }
  const musicalPosition = (tick: number) => smpte ? tick / ticksPerSecond : tick / division;

  const result: ImportedMidiFile = { format: format as 0 | 1 | 2, tracks: [], tempoEvents: [], meterEvents: [] };
  let nextId = 1;
  let totalEventCount = 0;
  for (let trackIndex = 0; trackIndex < count; trackIndex++) {
    if (reader.fourCC() !== "MTrk") throw new Error("Missing MIDI track chunk");
    const trackLength = reader.uint32();
    const trackEnd = reader.offset + trackLength;
    if (trackEnd > bytes.length) throw new Error("Truncated MIDI track");
    let tick = 0;
    let runningStatus = 0;
    let name = `MIDI Track ${trackIndex + 1}`;
    const notes: MidiNoteRow[] = [];
    const events: ImportedMidiTrack["events"] = [];
    const trackTempoEvents: NonNullable<ImportedMidiTrack["tempoEvents"]> = [];
    const trackMeterEvents: NonNullable<ImportedMidiTrack["meterEvents"]> = [];
    const held = new Map<number, Array<{ tick: number; velocity: number }>>();
    while (reader.offset < trackEnd) {
      if (++totalEventCount > MAX_EVENTS) throw new Error("MIDI file has too many events");
      tick += reader.vlq();
      if (reader.offset >= trackEnd) throw new Error("Truncated MIDI event");
      const next = reader.byte();
      const status = next & 0x80 ? next : runningStatus;
      if (!(next & 0x80)) reader.offset--;
      if (!status) throw new Error("MIDI running status without preceding event");
      if (status === 0xff) {
        runningStatus = 0;
        const kind = reader.byte();
        const data = reader.take(reader.vlq());
        if (kind === 0x03) name = new TextDecoder().decode(data).slice(0, 128) || name;
        let recognizedTimingMetaEvent = false;
        if (kind === 0x51 && data.length === 3) {
          const micros = (data[0] << 16) | (data[1] << 8) | data[2];
          if (micros > 0) {
            recognizedTimingMetaEvent = true;
            const bpm = 60_000_000 / micros;
            const tempo = { beat: musicalPosition(tick), bpm };
            trackTempoEvents.push(tempo);
            if (format !== 2) {
              result.bpm ??= bpm;
              result.tempoEvents.push(tempo);
            }
          }
        }
        if (kind === 0x58 && data.length === 4 && data[0] > 0 && data[1] <= 7) {
          recognizedTimingMetaEvent = true;
          const numerator = data[0];
          const denominator = 2 ** data[1];
          result.numerator ??= numerator;
          result.denominator ??= denominator;
          const midiClocksPerMetronomeClick = data[2];
          const thirtySecondsPerQuarter = data[3] ?? 8;
          const meter: MidiMeterEvent = {
            beat: musicalPosition(tick), numerator, denominator,
            ...(midiClocksPerMetronomeClick !== 24 ? { midiClocksPerMetronomeClick } : {}),
            ...(thirtySecondsPerQuarter !== 8 ? { thirtySecondsPerQuarter } : {}),
          };
          trackMeterEvents.push(meter);
          if (format !== 2) result.meterEvents.push(meter);
        }
        if (kind === 0x2f) {
          reader.offset = trackEnd;
          break;
        }
        if (!recognizedTimingMetaEvent && kind !== 0x2f) {
          events.push({ beat: musicalPosition(tick), status: 0xff, data: [kind, ...data] });
        }
        if (reader.offset > trackEnd) throw new Error("MIDI event exceeds track chunk");
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        runningStatus = 0;
        events.push({ beat: musicalPosition(tick), status, data: Array.from(reader.take(reader.vlq())) });
        if (reader.offset > trackEnd) throw new Error("MIDI event exceeds track chunk");
        continue;
      }
      if (status >= 0xf0) {
        runningStatus = 0;
        const systemDataLength = status === 0xf1 || status === 0xf3 ? 1
          : status === 0xf2 ? 2
            : status === 0xf6 || status >= 0xf8 ? 0 : -1;
        if (systemDataLength < 0) throw new Error(`Unsupported MIDI system event 0x${status.toString(16)}`);
        const data = Array.from(reader.take(systemDataLength));
        events.push({ beat: musicalPosition(tick), status, data });
        continue;
      }
      runningStatus = status;
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = reader.byte();
      const data2 = kind === 0xc0 || kind === 0xd0 ? 0 : reader.byte();
      if (reader.offset > trackEnd) throw new Error("MIDI event exceeds track chunk");
      if (kind !== 0x80 && kind !== 0x90) {
        events.push({ beat: musicalPosition(tick), status,
          data: kind === 0xc0 || kind === 0xd0 ? [data1] : [data1, data2] });
        continue;
      }
      const key = channel * 128 + data1;
      if (kind === 0x90 && data2 > 0) {
        const queue = held.get(key) ?? [];
        queue.push({ tick, velocity: data2 });
        held.set(key, queue);
      } else {
        const start = held.get(key)?.shift();
        if (!start) {
          events.push({ beat: musicalPosition(tick), status, data: [data1, data2] });
          continue;
        }
        notes.push({
          id: nextId++,
          pitch: data1,
          channel,
          startBeats: musicalPosition(start.tick),
          durationBeats: Math.max(0, musicalPosition(tick) - musicalPosition(start.tick)),
          velocity: start.velocity / 127,
          releaseVelocity: data2 / 127,
          probability: 1,
        });
      }
    }
    for (const [key, queue] of held) for (const start of queue) {
      notes.push({
        id: nextId++, pitch: key % 128,
        channel: Math.floor(key / 128),
        startBeats: musicalPosition(start.tick),
        durationBeats: Math.max(0, musicalPosition(tick) - musicalPosition(start.tick)),
        velocity: start.velocity / 127, releaseVelocity: 0, probability: 1,
      });
    }
    notes.sort((a, b) => a.startBeats - b.startBeats || a.pitch - b.pitch);
    result.tracks.push({ name, notes, events, tempoEvents: trackTempoEvents, meterEvents: trackMeterEvents,
      durationBeats: musicalPosition(tick) });
    reader.offset = trackEnd;
  }
  result.tempoEvents.sort((a, b) => a.beat - b.beat);
  result.meterEvents.sort((a, b) => a.beat - b.beat);
  if (smpte) {
    // SMPTE files encode absolute time, not musical ticks. Convert each event
    // through the relevant tempo map so the imported sequence remains on its clock.
    const secondsToBeat = (tempoEvents: ReadonlyArray<{ beat: number; bpm: number }>, seconds: number) => {
      const points = [...tempoEvents].sort((a, b) => a.beat - b.beat);
      const effective: Array<{ beat: number; bpm: number }> = [{ beat: 0, bpm: 120 }];
      for (const point of points) {
        const previous = effective.at(-1)!;
        if (Math.abs(previous.beat - point.beat) < 1e-9) effective[effective.length - 1] = point;
        else if (point.beat >= 0) effective.push(point);
      }
      let beats = 0;
      for (let index = 0; index < effective.length; index++) {
        const point = effective[index];
        const next = effective[index + 1];
        const end = Math.min(seconds, next?.beat ?? seconds);
        if (end > point.beat) beats += (end - point.beat) * point.bpm / 60;
        if (!next || seconds <= next.beat) break;
      }
      return beats;
    };
    const tempoSeconds = [...result.tempoEvents];
    const meterSeconds = [...result.meterEvents];
    if (format !== 2) {
      result.tempoEvents = tempoSeconds.map((event) => ({ ...event, beat: secondsToBeat(tempoSeconds, event.beat) }));
      result.meterEvents = meterSeconds.map((event) => ({ ...event, beat: secondsToBeat(tempoSeconds, event.beat) }));
    }
    for (const track of result.tracks) {
      const localTempoSeconds = format === 2 ? [...(track.tempoEvents ?? [])] : tempoSeconds;
      if (format === 2) {
        track.tempoEvents = localTempoSeconds.map((event) => ({ ...event, beat: secondsToBeat(localTempoSeconds, event.beat) }));
        track.meterEvents = (track.meterEvents ?? []).map((event) => ({ ...event, beat: secondsToBeat(localTempoSeconds, event.beat) }));
      }
      const convertTime = (seconds: number) => secondsToBeat(localTempoSeconds, seconds);
      for (const note of track.notes) {
        const startSeconds = note.startBeats;
        const endSeconds = startSeconds + note.durationBeats;
        note.startBeats = convertTime(startSeconds);
        note.durationBeats = Math.max(0, convertTime(endSeconds) - note.startBeats);
      }
      for (const event of track.events ?? []) event.beat = convertTime(event.beat);
      track.durationBeats = convertTime(track.durationBeats);
    }
  }
  for (const track of result.tracks) {
    track.tempoEvents?.sort((a, b) => a.beat - b.beat);
    track.meterEvents?.sort((a, b) => a.beat - b.beat);
  }
  const defaultTempos = format === 2 ? result.tracks[0]?.tempoEvents ?? [] : result.tempoEvents;
  const defaultMeters = format === 2 ? result.tracks[0]?.meterEvents ?? [] : result.meterEvents;
  result.bpm = defaultTempos.filter((event) => event.beat <= 0).at(-1)?.bpm ?? 120;
  result.numerator = defaultMeters.filter((event) => event.beat <= 0).at(-1)?.numerator ?? 4;
  result.denominator = defaultMeters.filter((event) => event.beat <= 0).at(-1)?.denominator ?? 4;
  return result;
}

function vlq(value: number): number[] {
  let n = Math.max(0, Math.floor(value));
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}
function u16(value: number): number[] { return [(value >> 8) & 0xff, value & 0xff]; }
function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function chunk(tag: string, body: number[]): number[] {
  return [...Array.from(tag).map((letter) => letter.charCodeAt(0)), ...u32(body.length), ...body];
}

export interface MidiExportTrack {
  name: string;
  regions: MidiRegionRow[];
}

export interface Midi1LossReport {
  midi2Notes: number;
  noteAttributes: number;
  groups: number;
  quantizedVelocities: number;
  unsupportedUmpEvents: number;
}

function scaleMidi1VelocityToMidi2(value: number): number {
  if (value <= 64) return value << 9;
  const repeated = value & 0x3f;
  return ((value << 9) | (repeated << 3) | (repeated >>> 3)) & 0xffff;
}

/** Inspect selected content before lossy export to Standard MIDI File 1.0. */
export function analyzeMidi1ExportLoss(tracks: MidiExportTrack[]): Midi1LossReport {
  const report: Midi1LossReport = {
    midi2Notes: 0, noteAttributes: 0, groups: 0, quantizedVelocities: 0, unsupportedUmpEvents: 0,
  };
  for (const track of tracks) for (const region of track.regions) {
    if (region.muted) continue;
    for (const note of region.notes) {
      if (note.muted || !note.midi2) continue;
      report.midi2Notes++;
      if (note.midi2.attributeType !== 0 || note.midi2.attributeData !== 0
        || (note.midi2.releaseAttributeType ?? note.midi2.attributeType) !== 0
        || (note.midi2.releaseAttributeData ?? note.midi2.attributeData) !== 0) report.noteAttributes++;
      if (note.midi2.group !== 0) report.groups++;
      const on = note.midi2.velocity;
      const off = note.midi2.releaseVelocity;
      if (scaleMidi1VelocityToMidi2(on >>> 9) !== on || scaleMidi1VelocityToMidi2(off >>> 9) !== off)
        report.quantizedVelocities++;
    }
    for (const event of region.umpEvents ?? []) {
      if (!umpEventToMidi1(event.words, event.wordCount)) report.unsupportedUmpEvents++;
    }
  }
  return report;
}

/** Count selected song meter changes whose SMF-only click interval MIDI Clip cannot encode. */
export function countMidi2TimeSignatureClickIntervalLoss(
  songs: SongRow[], songIndices: number[],
): number {
  let count = 0;
  for (const songIndex of songIndices) {
    const song = songs[songIndex];
    if (!song) continue;
    const durationSeconds = song.endSeconds && song.endSeconds > 0
      ? song.endSeconds
      : Math.max(1, ...(song.midiRegions ?? []).map((region) =>
        songSecondsAtBeat(song, region.startBeats + region.durationBeats)),
      ...(song.regions ?? []).map((region) => region.startSeconds + region.durationSeconds),
      ...song.events.map((event) => event.timeSeconds));
    const durationBeats = songBeatsAtSeconds(song, durationSeconds);
    count += (song.signaturePoints ?? []).filter((point) =>
      point.beat >= 0 && point.beat <= durationBeats
      && (point.midiClocksPerMetronomeClick ?? 24) !== 24).length;
  }
  return count;
}

export interface MidiExportOptions {
  bpm: number;
  numerator: number;
  denominator: number;
  /** false puts the first selected region at tick zero. */
  fromProjectStart: boolean;
  expandLoops: boolean;
  tempoEvents?: Array<{ beat: number; bpm: number }>;
  meterEvents?: MidiMeterEvent[];
}

function umpEventToMidi1(words: number[], wordCount: number): { status: number; data: number[] } | null {
  if (wordCount < 1 || wordCount > words.length) return null;
  const first = words[0] >>> 0;
  const type = first >>> 28;
  if (type !== 2 && type !== 4) return null;
  const status = (first >>> 20) & 0xf;
  const channel = (first >>> 16) & 0xf;
  const statusByte = (status << 4) | channel;
  const data1 = (first >>> 8) & 0x7f;
  const data2 = first & 0x7f;
  if (type === 2) {
    if (status === 0xa) return { status: statusByte, data: [data1, data2] };
    if (status === 0xb) return { status: statusByte, data: [data1, data2] };
    if (status === 0xc) return { status: statusByte, data: [data1] };
    if (status === 0xd) return { status: statusByte, data: [data1] };
    if (status === 0xe) return { status: statusByte, data: [data1, data2] };
    return null;
  }
  if (wordCount !== 2) return null;
  // MIDI 2.0 reserves these CC indices for unified Bank/Program, RPN/NRPN,
  // and Note Velocity. Translating them as ordinary MIDI 1.0 CCs would create
  // control changes a MIDI 2.0 receiver was required to ignore.
  if (status === 0xb && [0, 6, 32, 38, 88, 98, 99, 100, 101].includes(data1)) return null;
  const value32 = words[1] >>> 0;
  const scale32To7 = (value: number) => value >>> 25;
  const scale32To14 = (value: number) => value >>> 18;
  if (status === 0xa) return { status: statusByte, data: [data1, scale32To7(value32)] };
  if (status === 0xb) return { status: statusByte, data: [data1, scale32To7(value32)] };
  if (status === 0xd) return { status: statusByte, data: [scale32To7(value32)] };
  if (status === 0xe) {
    const value14 = scale32To14(value32);
    return { status: statusByte, data: [value14 & 0x7f, (value14 >>> 7) & 0x7f] };
  }
  return null;
}

/** Write a type-1 SMF, one note track per DAW track plus a tempo map. */
export function writeStandardMidiFile(tracks: MidiExportTrack[], options: MidiExportOptions): Uint8Array {
  if (!tracks.length || tracks.length > MAX_TRACKS - 1) throw new Error("Select 1–255 MIDI tracks");
  const earliest = tracks.reduce((minimum, track) => track.regions.reduce(
    (value, region) => Math.min(value, region.startBeats), minimum,
  ), Infinity);
  const origin = options.fromProjectStart || !Number.isFinite(earliest) ? 0 : earliest;
  const metaEvents: Array<{ tick: number; order: number; bytes: number[] }> = [];
  const rawTempo = [...(options.tempoEvents ?? [{ beat: 0, bpm: options.bpm }])]
    .sort((a, b) => a.beat - b.beat);
  const initialTempo = rawTempo.filter((event) => event.beat <= origin).at(-1)
    ?? { beat: origin, bpm: options.bpm };
  const tempo = [{ ...initialTempo, beat: origin }, ...rawTempo.filter((event) => event.beat > origin)];
  for (const event of tempo) {
    if (!Number.isFinite(event.beat) || !Number.isFinite(event.bpm) || event.bpm <= 0) continue;
    const micros = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / event.bpm)));
    metaEvents.push({ tick: Math.max(0, Math.round((event.beat - origin) * PPQN)), order: 0,
      bytes: [0xff, 0x51, 3, (micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff] });
  }
  const rawMeter = [...(options.meterEvents ?? [{ beat: 0, numerator: options.numerator, denominator: options.denominator }])]
    .sort((a, b) => a.beat - b.beat);
  const initialMeter = rawMeter.filter((event) => event.beat <= origin).at(-1)
    ?? { beat: origin, numerator: options.numerator, denominator: options.denominator };
  const meter = [{ ...initialMeter, beat: origin }, ...rawMeter.filter((event) => event.beat > origin)];
  for (const event of meter) {
    if (!Number.isInteger(event.numerator) || event.numerator < 1 || event.numerator > 0xff)
      throw new Error("MIDI meter numerator must be an unsigned nonzero 8-bit integer");
    const denomPower = Math.log2(event.denominator);
    if (!Number.isInteger(denomPower) || denomPower < 0 || denomPower > 7)
      throw new Error("MIDI meter denominator must be a power of two");
    const thirtySecondsPerQuarter = event.thirtySecondsPerQuarter ?? 8;
    const midiClocksPerMetronomeClick = event.midiClocksPerMetronomeClick ?? 24;
    if (!Number.isInteger(midiClocksPerMetronomeClick)
        || midiClocksPerMetronomeClick < 0 || midiClocksPerMetronomeClick > 0xff)
      throw new Error("MIDI meter clocks per metronome click must be an unsigned 8-bit integer");
    if (!Number.isInteger(thirtySecondsPerQuarter)
        || thirtySecondsPerQuarter < 0 || thirtySecondsPerQuarter > 0xff)
      throw new Error("MIDI meter 1/32-note count must be an unsigned 8-bit integer");
    metaEvents.push({ tick: Math.max(0, Math.round((event.beat - origin) * PPQN)), order: 1,
      bytes: [0xff, 0x58, 4, event.numerator & 0xff, denomPower,
        midiClocksPerMetronomeClick, thirtySecondsPerQuarter] });
  }
  metaEvents.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const tempoTrack: number[] = [];
  let metaTick = 0;
  for (const event of metaEvents) {
    tempoTrack.push(...vlq(event.tick - metaTick), ...event.bytes);
    metaTick = event.tick;
  }
  tempoTrack.push(0, 0xff, 0x2f, 0);
  const chunks = [chunk("MTrk", tempoTrack)];
  let totalEvents = 0;
  for (const track of tracks) {
    const events: Array<{ tick: number; order: number; bytes: number[] }> = [];
    for (const region of track.regions) {
      if (region.muted) continue;
      const loopLength = region.loopLengthBeats > 0 ? region.loopLengthBeats : region.durationBeats;
      for (const note of region.notes) {
        if (note.muted) continue;
        const repeats = options.expandLoops && region.loop && loopLength > 0
          ? Math.min(100_000, Math.ceil(region.durationBeats / loopLength))
          : 1;
        if (region.loop && !midiRegionContainsLoopSourceBeat(region, note.startBeats)) continue;
        for (let repeat = 0; repeat < repeats; repeat++) {
          const relative = options.expandLoops && region.loop && loopLength > 0
            ? midiRegionLoopOccurrence(region, note.startBeats) + repeat * loopLength
            : note.startBeats - region.clipOffsetBeats;
          if (relative < 0 || relative >= region.durationBeats) continue;
          const start = Math.max(0, Math.round((region.startBeats + relative - origin) * PPQN));
          const availableInLoop = region.loop
            ? (region.loopStartBeats ?? 0) + loopLength - note.startBeats
            : note.durationBeats;
          const end = Math.max(start, Math.round((region.startBeats + Math.min(
            region.durationBeats,
            relative + Math.min(note.durationBeats, availableInLoop),
          ) - origin) * PPQN));
          const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
          const midi1Velocity = note.midi2 ? note.midi2.velocity >>> 9 : Math.round(note.velocity * 127);
          const velocity = Math.max(1, Math.min(127, midi1Velocity));
          const channel = Math.max(0, Math.min(15, Math.round(note.channel ?? 0)));
          const isInstantaneous = end === start;
          events.push({ tick: start, order: isInstantaneous ? 2 : 4,
            bytes: [0x90 | channel, pitch, velocity] });
          const midi1ReleaseVelocity = note.midi2 ? note.midi2.releaseVelocity >>> 9 : Math.round(note.releaseVelocity * 127);
          events.push({ tick: end, order: isInstantaneous ? 3 : 0,
            bytes: [0x80 | channel, pitch, Math.max(0, Math.min(127, midi1ReleaseVelocity))] });
          totalEvents += 2;
          if (events.length > MAX_EVENTS || totalEvents > 400_000)
            throw new Error("MIDI export exceeds event limit");
        }
      }
      for (const event of region.events ?? []) {
        const repeats = options.expandLoops && region.loop && loopLength > 0
          ? Math.min(100_000, Math.ceil(region.durationBeats / loopLength))
          : 1;
        if (region.loop && !midiRegionContainsLoopSourceBeat(region, event.beat)) continue;
        for (let repeat = 0; repeat < repeats; repeat++) {
          const relative = options.expandLoops && region.loop && loopLength > 0
            ? midiRegionLoopOccurrence(region, event.beat) + repeat * loopLength
            : event.beat - region.clipOffsetBeats;
          if (relative < 0 || relative >= region.durationBeats) continue;
          const tick = Math.max(0, Math.round((region.startBeats + relative - origin) * PPQN));
          let bytes: number[];
          if (event.status === 0xff) {
            const [metaType, ...payload] = event.data;
            if (metaType === undefined) continue;
            bytes = [0xff, metaType, ...vlq(payload.length), ...payload];
          } else if (event.status === 0xf0 || event.status === 0xf7) {
            bytes = [event.status, ...vlq(event.data.length), ...event.data];
          } else {
            bytes = [event.status, ...event.data];
          }
          events.push({ tick, order: 1, bytes });
          totalEvents++;
          if (events.length > MAX_EVENTS || totalEvents > 400_000)
            throw new Error("MIDI export exceeds event limit");
        }
      }
      for (const event of region.umpEvents ?? []) {
        const isConfiguration = event.configurationHeader === true
          || event.profileConfigurationHeader === true;
        if (isConfiguration) {
          const converted = umpEventToMidi1(event.words, event.wordCount);
          if (converted) {
            events.push({ tick: 0, order: -2, bytes: [converted.status, ...converted.data] });
            totalEvents++;
            if (events.length > MAX_EVENTS || totalEvents > 400_000)
              throw new Error("MIDI export exceeds event limit");
          }
          // SMF has no distinct receiver-configuration section. Representable
          // setup messages become track-start events and are not region-looped.
          continue;
        }
        const repeats = options.expandLoops && region.loop && loopLength > 0
          ? Math.min(100_000, Math.ceil(region.durationBeats / loopLength))
          : 1;
        if (region.loop && !midiRegionContainsLoopSourceBeat(region, event.beat)) continue;
        for (let repeat = 0; repeat < repeats; repeat++) {
          const relative = options.expandLoops && region.loop && loopLength > 0
            ? midiRegionLoopOccurrence(region, event.beat) + repeat * loopLength
            : event.beat - region.clipOffsetBeats;
          if (relative < 0 || relative >= region.durationBeats) continue;
          const tick = Math.max(0, Math.round((region.startBeats + relative - origin) * PPQN));
          const converted = umpEventToMidi1(event.words, event.wordCount);
          if (!converted) continue;
          events.push({ tick, order: 1, bytes: [converted.status, ...converted.data] });
          totalEvents++;
          if (events.length > MAX_EVENTS || totalEvents > 400_000)
            throw new Error("MIDI export exceeds event limit");
        }
      }
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const nameBytes = Array.from(new TextEncoder().encode(track.name.slice(0, 128)));
    const body = [0, 0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes];
    let lastTick = 0;
    for (const event of events) {
      body.push(...vlq(event.tick - lastTick), ...event.bytes);
      lastTick = event.tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    chunks.push(chunk("MTrk", body));
  }
  return Uint8Array.from([
    ...chunk("MThd", [...u16(1), ...u16(chunks.length), ...u16(PPQN)]),
    ...chunks.flat(),
  ]);
}

/**
 * Convert a beat position in an imported SMF to elapsed seconds. SMF tempo is
 * expressed as microseconds per quarter-note, with the format default of 120
 * BPM when no tempo meta-event is present. Simultaneous tempo events are
 * resolved in file order (the last event at a tick wins).
 */
export function midiSecondsAtBeat(
  tempoEvents: ReadonlyArray<{ beat: number; bpm: number }>,
  beat: number,
): number {
  const points = [...tempoEvents]
    .filter((point) => Number.isFinite(point.beat) && Number.isFinite(point.bpm) && point.bpm > 0)
    .sort((a, b) => a.beat - b.beat);
  const effective: Array<{ beat: number; bpm: number }> = [{ beat: 0, bpm: 120 }];
  for (const point of points) {
    if (point.beat < 0) continue;
    const previous = effective.at(-1)!;
    if (Math.abs(previous.beat - point.beat) < 1e-9) effective[effective.length - 1] = point;
    else effective.push(point);
  }
  let seconds = 0;
  for (let index = 0; index < effective.length; index++) {
    const current = effective[index];
    const next = effective[index + 1];
    const end = Math.min(beat, next?.beat ?? beat);
    if (end > current.beat) seconds += (end - current.beat) * 60 / current.bpm;
    if (!next || beat <= next.beat) break;
  }
  return seconds;
}

/** Convert an elapsed duration to the project's song-local beat domain. */
export function songBeatAtElapsedSeconds(song: SongRow, seconds: number): number {
  return songBeatsAtSeconds(song, Math.max(0, seconds));
}

/**
 * Preserve the imported MIDI's real-time placement while conforming it to the
 * destination song's tempo map. Note duration is converted independently at
 * its start/end so tempo changes inside a note do not shift its release time.
 */
export function adaptMidiTracksToSongTempo(
  tracks: ReadonlyArray<ImportedMidiTrack>,
  tempoEvents: ReadonlyArray<{ beat: number; bpm: number }>,
  song: SongRow,
): ImportedMidiTrack[] {
  return tracks.map((track) => {
    const notes = track.notes.map((note) => {
      const startSeconds = midiSecondsAtBeat(tempoEvents, note.startBeats);
      const endSeconds = midiSecondsAtBeat(tempoEvents, note.startBeats + note.durationBeats);
      const startBeats = songBeatAtElapsedSeconds(song, startSeconds);
      const endBeats = songBeatAtElapsedSeconds(song, endSeconds);
      return { ...note, startBeats, durationBeats: Math.max(0, endBeats - startBeats) };
    });
    const sourceEndSeconds = midiSecondsAtBeat(tempoEvents, track.durationBeats);
    const events = track.events?.map((event) => ({
      ...event,
      beat: songBeatAtElapsedSeconds(song, midiSecondsAtBeat(tempoEvents, event.beat)),
    }));
    const umpEvents = track.umpEvents?.map((event) => ({
      ...event,
      beat: songBeatAtElapsedSeconds(song, midiSecondsAtBeat(tempoEvents, event.beat)),
    }));
    return { ...track, notes, events, umpEvents, durationBeats: songBeatAtElapsedSeconds(song, sourceEndSeconds) };
  });
}

/** True when the imported MIDI tempo map changes the file's playback clock. */
export function midiTempoDiffersFromSong(
  tempoEvents: ReadonlyArray<{ beat: number; bpm: number }>,
  song: SongRow,
): boolean {
  const candidates = new Set<number>([0]);
  for (const event of tempoEvents) if (event.beat >= 0) candidates.add(event.beat);
  for (const point of song.tempoPoints ?? []) if (point.beat >= 0) candidates.add(point.beat);
  for (const beat of candidates) {
    const importedSeconds = midiSecondsAtBeat(tempoEvents, beat);
    const projectSeconds = songSecondsAtBeat(song, beat);
    if (Math.abs(importedSeconds - projectSeconds) > 0.01) return true;
  }
  return false;
}

export interface MidiSongExportOptions {
  songIndices: number[];
  /** Project-global tracks: songs contain regions but no track definitions. */
  tracks: readonly { id: string; name: string }[];
  /** Exact track IDs to export; omit to include all MIDI tracks. */
  trackIds?: Set<string>;
  fromProjectStart: boolean;
  expandLoops: boolean;
  format?: "midi1" | "midi2";
}

/** Concatenate chosen songs and encode their complete tempo/meter map. */
export function writeSongsMidiFile(songs: SongRow[], options: MidiSongExportOptions): Uint8Array {
  const tracks = new Map<string, MidiExportTrack>();
  const trackNames = new Map(options.tracks.map((track) => [track.id, track.name]));
  const tempoEvents: NonNullable<MidiExportOptions["tempoEvents"]> = [];
  const meterEvents: NonNullable<MidiExportOptions["meterEvents"]> = [];
  let beatOffset = 0;
  for (const songIndex of options.songIndices) {
    const song = songs[songIndex];
    if (!song) throw new Error("Selected song no longer exists");
    const durationSeconds = song.endSeconds && song.endSeconds > 0
      ? song.endSeconds
      : Math.max(1, ...song.midiRegions?.map((region) => songSecondsAtBeat(song, region.startBeats + region.durationBeats)) ?? [0],
        ...(song.regions ?? []).map((region) => region.startSeconds + region.durationSeconds),
        ...song.events.map((event) => event.timeSeconds));
    const durationBeats = songBeatsAtSeconds(song, durationSeconds);
    const points = [...(song.tempoPoints ?? [])].sort((a, b) => a.beat - b.beat);
    if (!points.length || points[0].beat > 0)
      tempoEvents.push({ beat: beatOffset, bpm: song.bpm || 120 });
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (point.beat < 0 || point.beat > durationBeats) continue;
      tempoEvents.push({ beat: beatOffset + point.beat, bpm: point.bpm });
      const next = points[index + 1];
      if (point.curve !== 0 && next && next.beat > point.beat) {
        // SMF tempo events are discrete; sample linear Core ramps at 1/16 beat.
        for (let beat = point.beat + 1 / 16; beat < Math.min(next.beat, durationBeats); beat += 1 / 16) {
          const bpm = point.bpm + (next.bpm - point.bpm) * (beat - point.beat) / (next.beat - point.beat);
          tempoEvents.push({ beat: beatOffset + beat, bpm });
          if (tempoEvents.length > MAX_EVENTS) throw new Error("Tempo ramp exceeds MIDI export limit");
        }
      }
    }
    const signatures = [...(song.signaturePoints ?? [])].sort((a, b) => a.beat - b.beat);
    if (!signatures.length || signatures[0].beat > 0)
      meterEvents.push({ beat: beatOffset, numerator: song.tsNum || 4, denominator: song.tsDen || 4 });
    for (const point of signatures)
      if (point.beat >= 0 && point.beat <= durationBeats)
        meterEvents.push({ beat: beatOffset + point.beat, numerator: point.numerator,
          denominator: point.denominator, thirtySecondsPerQuarter: point.thirtySecondsPerQuarter,
          midiClocksPerMetronomeClick: point.midiClocksPerMetronomeClick });
    for (const region of song.midiRegions ?? []) {
      if (options.trackIds && !options.trackIds.has(region.trackId)) continue;
      const name = trackNames.get(region.trackId) ?? region.trackId;
      const track = tracks.get(region.trackId) ?? { name, regions: [] };
      track.regions.push({ ...region, startBeats: beatOffset + region.startBeats });
      tracks.set(region.trackId, track);
    }
    beatOffset += durationBeats;
  }
  if (!tracks.size) throw new Error("No MIDI regions in the selected songs/tracks");
  const first = songs[options.songIndices[0]];
  const exportTracks = [...tracks.values()];
  const exportOptions: MidiExportOptions = {
    bpm: first.bpm, numerator: first.tsNum, denominator: first.tsDen,
    fromProjectStart: options.fromProjectStart, expandLoops: options.expandLoops,
    tempoEvents, meterEvents,
  };
  return options.format === "midi2"
    ? writeMidiClipFile(exportTracks, exportOptions)
    : writeStandardMidiFile(exportTracks, exportOptions);
}
