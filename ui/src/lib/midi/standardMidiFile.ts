import type { MidiNoteRow, MidiRegionRow, SongRow } from "../state/types";

const PPQN = 480;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TRACKS = 256;
const MAX_EVENTS = 200_000;

export interface ImportedMidiTrack {
  name: string;
  notes: MidiNoteRow[];
  durationBeats: number;
}

export interface ImportedMidiFile {
  tracks: ImportedMidiTrack[];
  bpm?: number;
  numerator?: number;
  denominator?: number;
  tempoEvents: Array<{ beat: number; bpm: number }>;
  meterEvents: Array<{ beat: number; numerator: number; denominator: number }>;
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

/** Parse PPQN SMF 0/1, retaining note pairs without executing SysEx. */
export function parseStandardMidiFile(bytes: Uint8Array): ImportedMidiFile {
  if (bytes.length > MAX_BYTES) throw new Error("MIDI file exceeds 32 MiB limit");
  const reader = new Reader(bytes);
  if (reader.fourCC() !== "MThd") throw new Error("Not a Standard MIDI File");
  const headerLength = reader.uint32();
  if (headerLength < 6 || headerLength > 1024) throw new Error("Invalid MIDI header");
  const format = reader.uint16();
  const count = reader.uint16();
  const division = reader.uint16();
  reader.take(headerLength - 6);
  if (format > 1 || count < 1 || count > MAX_TRACKS)
    throw new Error("Only MIDI format 0/1 with up to 256 tracks is supported");
  if ((division & 0x8000) || division === 0)
    throw new Error("SMPTE-time MIDI files are not supported");

  const result: ImportedMidiFile = { tracks: [], tempoEvents: [], meterEvents: [] };
  let nextId = 1;
  for (let trackIndex = 0; trackIndex < count; trackIndex++) {
    if (reader.fourCC() !== "MTrk") throw new Error("Missing MIDI track chunk");
    const trackLength = reader.uint32();
    const trackEnd = reader.offset + trackLength;
    if (trackEnd > bytes.length) throw new Error("Truncated MIDI track");
    let tick = 0;
    let runningStatus = 0;
    let name = `MIDI Track ${trackIndex + 1}`;
    const notes: MidiNoteRow[] = [];
    const held = new Map<number, Array<{ tick: number; velocity: number }>>();
    let eventCount = 0;
    while (reader.offset < trackEnd) {
      if (++eventCount > MAX_EVENTS) throw new Error("MIDI track has too many events");
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
        if (kind === 0x51 && data.length === 3) {
          const micros = (data[0] << 16) | (data[1] << 8) | data[2];
          if (micros > 0) {
            const bpm = 60_000_000 / micros;
            result.bpm ??= bpm;
            result.tempoEvents.push({ beat: tick / division, bpm });
          }
        }
        if (kind === 0x58 && data.length >= 2) {
          const numerator = data[0];
          const denominator = 2 ** data[1];
          result.numerator ??= numerator;
          result.denominator ??= denominator;
          result.meterEvents.push({ beat: tick / division, numerator, denominator });
        }
        if (kind === 0x2f) {
          reader.offset = trackEnd;
          break;
        }
        if (reader.offset > trackEnd) throw new Error("MIDI event exceeds track chunk");
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        runningStatus = 0;
        reader.take(reader.vlq());
        if (reader.offset > trackEnd) throw new Error("MIDI event exceeds track chunk");
        continue;
      }
      if (status >= 0xf0) throw new Error("Unsupported system MIDI event");
      runningStatus = status;
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = reader.byte();
      const data2 = kind === 0xc0 || kind === 0xd0 ? 0 : reader.byte();
      if (reader.offset > trackEnd) throw new Error("MIDI event exceeds track chunk");
      if (kind !== 0x80 && kind !== 0x90) continue;
      const key = channel * 128 + data1;
      if (kind === 0x90 && data2 > 0) {
        const queue = held.get(key) ?? [];
        queue.push({ tick, velocity: data2 });
        held.set(key, queue);
      } else {
        const start = held.get(key)?.shift();
        if (!start) continue;
        notes.push({
          id: nextId++,
          pitch: data1,
          startBeats: start.tick / division,
          durationBeats: Math.max(0.03125, (tick - start.tick) / division),
          velocity: start.velocity / 127,
          releaseVelocity: data2 / 127,
          probability: 1,
        });
      }
    }
    for (const [key, queue] of held) for (const start of queue) {
      notes.push({
        id: nextId++, pitch: key % 128,
        startBeats: start.tick / division,
        durationBeats: Math.max(0.03125, (tick - start.tick) / division),
        velocity: start.velocity / 127, releaseVelocity: 0, probability: 1,
      });
    }
    notes.sort((a, b) => a.startBeats - b.startBeats || a.pitch - b.pitch);
    result.tracks.push({ name, notes, durationBeats: tick / division });
    reader.offset = trackEnd;
  }
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

export interface MidiExportOptions {
  bpm: number;
  numerator: number;
  denominator: number;
  /** false puts the first selected region at tick zero. */
  fromProjectStart: boolean;
  expandLoops: boolean;
  tempoEvents?: Array<{ beat: number; bpm: number }>;
  meterEvents?: Array<{ beat: number; numerator: number; denominator: number }>;
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
    const denomPower = Math.log2(event.denominator);
    if (!Number.isInteger(denomPower) || denomPower < 0 || denomPower > 7)
      throw new Error("MIDI meter denominator must be a power of two");
    metaEvents.push({ tick: Math.max(0, Math.round((event.beat - origin) * PPQN)), order: 1,
      bytes: [0xff, 0x58, 4, event.numerator & 0xff, denomPower, 24, 8] });
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
          ? Math.min(100_000, Math.ceil((region.durationBeats + region.clipOffsetBeats) / loopLength))
          : 1;
        for (let repeat = 0; repeat < repeats; repeat++) {
          const relative = note.startBeats + repeat * loopLength - region.clipOffsetBeats;
          if (relative < 0 || relative >= region.durationBeats) continue;
          const start = Math.max(0, Math.round((region.startBeats + relative - origin) * PPQN));
          const end = Math.max(start + 1, Math.round((region.startBeats + Math.min(region.durationBeats, relative + note.durationBeats) - origin) * PPQN));
          const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
          const velocity = Math.max(1, Math.min(127, Math.round(note.velocity * 127)));
          events.push({ tick: start, order: 1, bytes: [0x90, pitch, velocity] });
          events.push({ tick: end, order: 0, bytes: [0x80, pitch, Math.max(0, Math.min(127, Math.round(note.releaseVelocity * 127)))] });
          totalEvents += 2;
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

/** Map Core's step/linear-BPM tempo map to seconds for an offline export. */
export function songSecondsAtBeat(song: SongRow, beat: number): number {
  const points = [...(song.tempoPoints ?? [])]
    .filter((point) => Number.isFinite(point.beat) && Number.isFinite(point.bpm) && point.bpm > 0)
    .sort((a, b) => a.beat - b.beat);
  if (!points.length || points[0].beat > 0)
    points.unshift({ beat: 0, bpm: song.bpm || 120, timeSeconds: 0, curve: 0 });
  let seconds = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[index + 1];
    const end = Math.min(beat, next?.beat ?? beat);
    const span = Math.max(0, end - current.beat);
    if (span > 0) {
      const delta = next ? next.bpm - current.bpm : 0;
      const rate = next && current.curve !== 0 && next.beat > current.beat
        ? delta / (next.beat - current.beat) : 0;
      seconds += Math.abs(rate) < 1e-9
        ? span * 60 / current.bpm
        : 60 / rate * Math.log((current.bpm + rate * span) / current.bpm);
    }
    if (!next || beat <= next.beat) break;
  }
  return seconds;
}

function songBeatsAtSeconds(song: SongRow, seconds: number): number {
  let high = Math.max(1, seconds * Math.max(1, song.bpm || 120) / 30);
  while (songSecondsAtBeat(song, high) < seconds && high < 1_000_000) high *= 2;
  let low = 0;
  for (let step = 0; step < 48; step++) {
    const mid = (low + high) / 2;
    if (songSecondsAtBeat(song, mid) < seconds) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export interface MidiSongExportOptions {
  songIndices: number[];
  /** Exact track IDs to export; omit to include all MIDI tracks. */
  trackIds?: Set<string>;
  /** Match a logical track across songs whose per-song IDs differ. */
  trackNames?: Set<string>;
  fromProjectStart: boolean;
  expandLoops: boolean;
}

/** Concatenate chosen songs and encode their complete tempo/meter map. */
export function writeSongsMidiFile(songs: SongRow[], options: MidiSongExportOptions): Uint8Array {
  const tracks = new Map<string, MidiExportTrack>();
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
        meterEvents.push({ beat: beatOffset + point.beat, numerator: point.numerator, denominator: point.denominator });
    for (const region of song.midiRegions ?? []) {
      const name = song.tracks.find((track) => track.id === region.trackId)?.name ?? region.trackId;
      if (options.trackIds && !options.trackIds.has(region.trackId)) continue;
      if (options.trackNames && !options.trackNames.has(name)) continue;
      const key = name;
      const track = tracks.get(key) ?? { name, regions: [] };
      track.regions.push({ ...region, startBeats: beatOffset + region.startBeats });
      tracks.set(key, track);
    }
    beatOffset += durationBeats;
  }
  if (!tracks.size) throw new Error("No MIDI regions in the selected songs/tracks");
  const first = songs[options.songIndices[0]];
  return writeStandardMidiFile([...tracks.values()], {
    bpm: first.bpm, numerator: first.tsNum, denominator: first.tsDen,
    fromProjectStart: options.fromProjectStart, expandLoops: options.expandLoops,
    tempoEvents, meterEvents,
  });
}
