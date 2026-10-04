/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiNoteRow } from "@/lib/state/types";
import type { ImportedMidiFile, ImportedMidiTrack, MidiExportOptions, MidiExportTrack } from "@/lib/midi/standardMidiFile";
import { midiRegionContainsLoopSourceBeat, midiRegionLoopOccurrence } from "@/lib/midi/midiRegionTiming";
import {
  assertNoMidiClipPropertyExchange,
  validateMidiClipProfilePackets,
} from "@/lib/midi/midiClipProfile";

const MAGIC = "SMF2CLIP";
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS = 200_000;
const TPQ = 960;
const MAX_DELTA = 0x000f_ffff;

function packetWords(messageType: number): number {
  if (messageType <= 2 || messageType === 6 || messageType === 7) return 1;
  if (messageType === 3 || messageType === 4 || (messageType >= 8 && messageType <= 10)) return 2;
  if (messageType === 11 || messageType === 12) return 3;
  if (messageType === 5 || messageType >= 13) return 4;
  throw new Error("Invalid UMP message type");
}

class ClipReader {
  offset = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  byte(): number {
    if (this.offset >= this.bytes.length) throw new Error("Truncated MIDI 2.0 clip");
    return this.bytes[this.offset++];
  }
  word(): number {
    return ((this.byte() * 0x1000000) + (this.byte() << 16) + (this.byte() << 8) + this.byte()) >>> 0;
  }
  fourCC(): string { return String.fromCharCode(this.byte(), this.byte(), this.byte(), this.byte()); }
}

interface ClipEvent {
  beat: number;
  words: number[];
  priority: number;
  order: number;
  sourceRegionOrder?: number;
  sourcePresentationOrder?: number;
}
type ExportUmpEvent =
  | { configuration: true; profile: boolean; words: number[] }
  | { configuration: false; profile: false; relative: number; words: number[]; presentationOrder?: number };
type ClipSequenceUmpEvent = Extract<ExportUmpEvent, { configuration: false }>;
interface HeldNote {
  tick: number;
  velocity: number;
  attributeType: number;
  attributeData: number;
  group: number;
  channel: number;
  pitch: number;
  attackOrder: number;
}

/** Parse the published MIDI Clip File (.midi2) UMP stream format. */
export function parseMidiClipFile(bytes: Uint8Array): ImportedMidiFile {
  if (bytes.length > MAX_BYTES) throw new Error("MIDI 2.0 clip exceeds 32 MiB limit");
  const reader = new ClipReader(bytes);
  if (reader.fourCC() + reader.fourCC() !== MAGIC) throw new Error("Not a MIDI 2.0 Clip File");

  const packets: Array<{
    words: number[];
    ticks: number;
    inSequence: boolean;
    inConfigurationHeader: boolean;
    inProfileConfigurationHeader: boolean;
    presentationOrder: number;
  }> = [];
  let ticks = 0;
  let startTicks = 0;
  let clipEndTicks = 0;
  let tpq = 0;
  let hasDctpq = false;
  let started = false;
  let ended = false;
  let packetCount = 0;
  let activeDcsDelta: number | null = null;
  let immediatelyPrecededByDcs = false;
  while (reader.offset < bytes.length) {
    // DCS packets are not retained as musical events, but still count toward
    // parsing work. Allow one delta-control packet per retained event plus
    // clip framing, and reject utility-packet floods early.
    if (++packetCount > MAX_EVENTS * 2 + 16) throw new Error("MIDI 2.0 clip has too many UMP packets");
    const first = reader.word();
    const type = first >>> 28;
    const words = [first];
    for (let index = 1; index < packetWords(type); index++) words.push(reader.word());
    if (type === 0) {
      const status = (first >>> 20) & 0xf;
      if ((first & 0x0f00_0000) !== 0)
        throw new Error("MIDI 2.0 clip Utility UMP has nonzero reserved Group bits");
      if (status === 4) {
        // Message Type 0x0 is groupless; its former Group nibble is reserved.
        activeDcsDelta = first & MAX_DELTA;
        ticks += activeDcsDelta;
        immediatelyPrecededByDcs = true;
        continue;
      } else if (status === 3) {
        if (started) throw new Error("MIDI 2.0 clip DCTPQ must precede Start of Clip");
        if (tpq !== 0) throw new Error("MIDI 2.0 clip contains more than one DCTPQ");
        if ((first & 0x000f_0000) !== 0)
          throw new Error("MIDI 2.0 clip DCTPQ has nonzero reserved bits");
        if (!immediatelyPrecededByDcs || activeDcsDelta !== 0)
          throw new Error("MIDI 2.0 clip DCTPQ must follow a zero Delta Clockstamp");
        const value = first & 0xffff;
        if (value === 0) throw new Error("MIDI 2.0 clip has an invalid zero DCTPQ");
        tpq = value;
        hasDctpq = true;
        immediatelyPrecededByDcs = false;
        continue;
      } else {
        immediatelyPrecededByDcs = false;
        if (status === 0) {
          if (!hasDctpq || activeDcsDelta === null)
            throw new Error("MIDI 2.0 clip NOOP must follow DCTPQ and a Delta Clockstamp");
          if ((first & 0x00ff_ffff) !== 0)
            throw new Error("MIDI 2.0 clip NOOP has nonzero reserved bits");
          // NOOP is a file-timing reset aid, not a retained sequence event.
          continue;
        }
        if ((status === 1 || status === 2) && (first & 0x000f_0000) !== 0)
          throw new Error("MIDI 2.0 clip JR timing message has nonzero reserved bits");
        // JR Clock/Timestamp and unknown Utility packets are opaque timeline
        // events. Keep their words and presentation order instead of silently
        // discarding UMP data the project model can preserve.
      }
    }
    const precedingDcsDelta = immediatelyPrecededByDcs ? activeDcsDelta : null;
    immediatelyPrecededByDcs = false;
    if (type === 0xf) {
      const status = (first >>> 16) & 0x3ff;
      if (status === 0x20) {
        if (started || ended) throw new Error("MIDI 2.0 clip has an unexpected Start of Clip");
        if (precedingDcsDelta === null)
          throw new Error("MIDI 2.0 clip Start of Clip must have a preceding Delta Clockstamp");
        started = true;
        startTicks = ticks;
        continue;
      }
      if (status === 0x21) {
        if (!started || ended) throw new Error("MIDI 2.0 clip has an unexpected End of Clip");
        if (precedingDcsDelta === null)
          throw new Error("MIDI 2.0 clip End of Clip must have a preceding Delta Clockstamp");
        ended = true;
        clipEndTicks = ticks;
        if (reader.offset !== bytes.length) throw new Error("MIDI 2.0 clip contains data after End of Clip");
        break;
      }
    }
    const inProfileConfigurationHeader = !hasDctpq && !started && type === 3;
    const flexStatusBank = (first >>> 8) & 0xff;
    const flexStatus = first & 0xff;
    const preDctpqTempoOrMeter = type === 0xd && words.length === 4
      && flexStatusBank === 0 && (flexStatus === 0 || flexStatus === 1);
    const configurationTempoOrMeter = hasDctpq && !started && preDctpqTempoOrMeter;
    if (!hasDctpq && !started && !inProfileConfigurationHeader && !preDctpqTempoOrMeter)
      throw new Error("Only MIDI Clip profile configuration may precede DCTPQ");
    if (inProfileConfigurationHeader && precedingDcsDelta !== null)
      throw new Error("MIDI 2.0 clip profile configuration packets must not have a Delta Clockstamp");
    if (configurationTempoOrMeter && activeDcsDelta !== 0)
      throw new Error("MIDI 2.0 clip configuration tempo and meter must use a zero Delta Clockstamp");
    if (!inProfileConfigurationHeader && !configurationTempoOrMeter && activeDcsDelta === null)
      throw new Error("MIDI 2.0 clip UMP events must have a preceding Delta Clockstamp");
    if (packets.length >= MAX_EVENTS)
      throw new Error("MIDI 2.0 clip has too many UMP events");
    packets.push({ words, ticks, inSequence: started,
      inConfigurationHeader: hasDctpq && !started, inProfileConfigurationHeader,
      presentationOrder: packets.length });
  }
  if (!tpq) throw new Error("MIDI 2.0 clip is missing DCTPQ");
  if (!started || !ended) throw new Error("MIDI 2.0 clip is missing Start/End of Clip markers");
  validateMidiClipProfilePackets(packets
    .filter((packet) => packet.inProfileConfigurationHeader)
    .map((packet) => packet.words));
  assertNoMidiClipPropertyExchange(packets
    .filter((packet) => packet.inSequence)
    .map((packet) => packet.words));

  const notes: MidiNoteRow[] = [];
  const rawEvents: NonNullable<ImportedMidiTrack["umpEvents"]> = [];
  const held = new Map<string, HeldNote[]>();
  const tempoEvents: ImportedMidiFile["tempoEvents"] = [];
  const meterEvents: ImportedMidiFile["meterEvents"] = [];
  let nextId = 1;
  let durationTicks = 0;
  let configurationEventSeen = false;
  let configurationTempoSeen = false;
  let configurationMeterSeen = false;
  let lastConfigurationEventWasTempo = false;
  for (const packet of packets) {
    const { words, ticks: at, inSequence, inConfigurationHeader,
      inProfileConfigurationHeader, presentationOrder } = packet;
    const relativeTicks = inSequence ? Math.max(0, at - startTicks) : 0;
    durationTicks = Math.max(durationTicks, relativeTicks);
    const word0 = words[0];
    const type = word0 >>> 28;
    const beat = relativeTicks / tpq;
    const flexStatusBank = (word0 >>> 8) & 0xff;
    const flexStatus = word0 & 0xff;
    const isSetTempo = type === 0xd && flexStatusBank === 0 && flexStatus === 0 && words.length === 4;
    const isSetTimeSignature = type === 0xd && flexStatusBank === 0 && flexStatus === 1 && words.length === 4;
    if (inConfigurationHeader) {
      if (isSetTempo) {
        if (configurationTempoSeen)
          throw new Error("MIDI 2.0 clip configuration header contains more than one Set Tempo");
        if (configurationEventSeen)
          throw new Error("MIDI 2.0 clip configuration Set Tempo must be its first event after DCTPQ");
        configurationTempoSeen = true;
        configurationEventSeen = true;
        lastConfigurationEventWasTempo = true;
      } else if (isSetTimeSignature) {
        if (configurationMeterSeen)
          throw new Error("MIDI 2.0 clip configuration header contains more than one Set Time Signature");
        if (!configurationTempoSeen || !lastConfigurationEventWasTempo)
          throw new Error("MIDI 2.0 clip configuration Set Time Signature must immediately follow Set Tempo");
        configurationMeterSeen = true;
        configurationEventSeen = true;
        lastConfigurationEventWasTempo = false;
      } else {
        configurationEventSeen = true;
        lastConfigurationEventWasTempo = false;
      }
    }
    if (!inSequence && !inConfigurationHeader && (isSetTempo || isSetTimeSignature))
      throw new Error("MIDI 2.0 clip configuration tempo and meter messages must follow DCTPQ");
    if (type === 0xd) {
      if (isSetTempo) {
        const units = words[1];
        if (units > 0) tempoEvents.push({ beat, bpm: 6_000_000_000 / units });
        continue;
      } else if (isSetTimeSignature) {
        const numerator = (words[1] >>> 24) & 0xff;
        const denominatorPower = (words[1] >>> 16) & 0xff;
        if (numerator > 0 && denominatorPower <= 7)
          meterEvents.push({ beat, numerator, denominator: 2 ** denominatorPower });
        continue;
      }
    }
    // Configuration-header packets precede the musical sequence. Preserve
    // them at beat zero, but do not let their elapsed clock time offset notes
    // or interpret configuration note messages as musical note pairs.
    if (!inSequence) {
      rawEvents.push({ beat: 0, words, wordCount: words.length,
        ...(inConfigurationHeader ? { configurationHeader: true } : {}),
        ...(inProfileConfigurationHeader
          ? { configurationHeader: true, profileConfigurationHeader: true } : {}) });
      continue;
    }
    if (type === 4 || type === 2) {
      const group = type === 4 ? (word0 >>> 24) & 0xf : (word0 >>> 24) & 0xf;
      const status = (word0 >>> 20) & 0xf;
      const channel = (word0 >>> 16) & 0xf;
      if ((status === 8 || status === 9) && (type === 2 || words.length === 2)) {
        const pitch = (word0 >>> 8) & 0x7f;
        const eventVelocity = type === 4
          ? (words[1] >>> 16) & 0xffff
          : midi1VelocityToMidi2((word0 & 0x7f) / 127);
        const attributeType = type === 4 ? word0 & 0xff : 0;
        const attributeData = type === 4 ? words[1] & 0xffff : 0;
        const key = `${group}:${channel}:${pitch}`;
        // MIDI 2.0 Note On velocity zero remains a Note On. Only MIDI 1.0
        // Channel Voice UMP applies the legacy zero-velocity Note Off rule.
        const isNoteOn = status === 9 && (type === 4 || eventVelocity > 0);
        if (isNoteOn) {
          // Group/channel/note number form the matching key here. When a sender
          // reuses the same group/channel/note number for overlapping notes,
          // pair releases FIFO; Attribute Type/Data are expressive payload,
          // never a note identifier.
          const queue = held.get(key) ?? [];
          queue.push({ tick: relativeTicks, velocity: eventVelocity, attributeType,
            attributeData, group, channel, pitch, attackOrder: presentationOrder });
          held.set(key, queue);
          continue;
        }
        const queue = held.get(key);
        if (queue?.length) {
          const start = queue.shift()!;
          notes.push({
            id: nextId++, pitch, channel,
            startBeats: start.tick / tpq,
            durationBeats: Math.max(1 / 64, (relativeTicks - start.tick) / tpq),
            velocity: start.velocity / 65535,
            releaseVelocity: (status === 8 ? eventVelocity : 0) / 65535,
            probability: 1,
            midi2: {
              group: start.group, velocity: start.velocity,
              releaseVelocity: status === 8 ? eventVelocity : 0,
              attributeType: start.attributeType, attributeData: start.attributeData,
              releaseAttributeType: type === 4 ? attributeType : 0,
              releaseAttributeData: type === 4 ? attributeData : 0,
              attackOrder: start.attackOrder,
              releaseOrder: presentationOrder,
            },
          });
          if (!queue.length) held.delete(key);
          continue;
        }
      }
    }
    rawEvents.push({ beat, words, wordCount: words.length, presentationOrder });
  }
  for (const queue of held.values()) for (const start of queue) {
    notes.push({
      id: nextId++, pitch: start.pitch, channel: start.channel,
      startBeats: start.tick / tpq, durationBeats: 1 / 64,
      velocity: start.velocity / 65535, releaseVelocity: 0, probability: 1,
      midi2: { group: start.group, velocity: start.velocity, releaseVelocity: 0,
        attributeType: start.attributeType, attributeData: start.attributeData,
        releaseAttributeType: 0, releaseAttributeData: 0,
        attackOrder: start.attackOrder, releaseOrder: -1 },
    });
  }
  const sequenceEndTicks = Math.max(0, clipEndTicks - startTicks);
  const durationBeats = Math.max(1, durationTicks / tpq, sequenceEndTicks / tpq,
    ...notes.map((note) => note.startBeats + note.durationBeats));
  const track: ImportedMidiTrack = { name: "MIDI 2.0 Clip", notes, umpEvents: rawEvents, durationBeats };
  return { format: "midi2-clip", tracks: [track], tempoEvents, meterEvents, bpm: tempoEvents[0]?.bpm,
    numerator: meterEvents[0]?.numerator, denominator: meterEvents[0]?.denominator };
}

function appendWord(bytes: number[], word: number): void {
  bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
}

function dcs(delta: number): number { return 0x00400000 | (delta & MAX_DELTA); }

function midi1EventToUmp(status: number, data: number[]): number[] | null {
  const kind = status & 0xf0;
  if (status < 0x80 || status > 0xef || data.length < 1) return null;
  const a = data[0] & 0x7f;
  const b = (data[1] ?? 0) & 0x7f;
  return [((0x2 << 28) | (kind << 20) | ((status & 0x0f) << 16) | (a << 8) | b) >>> 0];
}

/** M2-115 min/center/max scaling from 7-bit MIDI 1.0 velocity to 16 bits. */
function midi1VelocityToMidi2(value: number): number {
  const sevenBit = Math.max(0, Math.min(127, Math.round(value * 127)));
  if (sevenBit <= 64) return sevenBit << 9;
  const repeated = sevenBit & 0x3f;
  return ((sevenBit << 9) | (repeated << 3) | (repeated >>> 3)) & 0xffff;
}

function notePackets(note: MidiNoteRow, group: number): Array<{
  beat: number;
  words: number[];
  presentationOrder?: number;
}> {
  const midi2 = note.midi2;
  const noteGroup = Math.max(0, Math.min(15, midi2?.group ?? group));
  const channel = Math.max(0, Math.min(15, note.channel ?? 0));
  const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
  const attrType = midi2?.attributeType ?? 0;
  const attrData = midi2?.attributeData ?? 0;
  const releaseAttrType = midi2?.releaseAttributeType ?? attrType;
  const releaseAttrData = midi2?.releaseAttributeData ?? attrData;
  const velocity = midi2?.velocity ?? midi1VelocityToMidi2(note.velocity);
  const releaseVelocity = midi2?.releaseVelocity ?? midi1VelocityToMidi2(note.releaseVelocity);
  const first = (status: number) => ((4 << 28) | (noteGroup << 24) | (status << 20) | (channel << 16) | (pitch << 8) | attrType) >>> 0;
  const on = [first(9), ((velocity << 16) | attrData) >>> 0];
  const offFirst = ((4 << 28) | (noteGroup << 24) | (8 << 20) | (channel << 16) | (pitch << 8) | releaseAttrType) >>> 0;
  const off = [offFirst, ((releaseVelocity << 16) | releaseAttrData) >>> 0];
  return [
    { beat: note.startBeats, words: on,
      ...(midi2?.attackOrder !== undefined ? { presentationOrder: midi2.attackOrder } : {}) },
    { beat: note.startBeats + note.durationBeats, words: off,
      ...(midi2?.releaseOrder !== undefined ? { presentationOrder: midi2.releaseOrder } : {}) },
  ];
}

function compareClipEvents(a: ClipEvent, b: ClipEvent): number {
  // The writer serializes integer TPQ ticks. Compare on that same timeline so
  // floating-point beat math cannot split events that quantize to one tick.
  const tickDifference = Math.round(a.beat * TPQ) - Math.round(b.beat * TPQ);
  if (tickDifference !== 0) return tickDifference;
  const aPriorityEvent = a.priority < 0;
  const bPriorityEvent = b.priority < 0;
  if (aPriorityEvent || bPriorityEvent) {
    if (aPriorityEvent !== bPriorityEvent) return aPriorityEvent ? -1 : 1;
    return a.priority - b.priority || a.order - b.order;
  }
  const aHasSourceOrder = a.sourceRegionOrder !== undefined
    && a.sourcePresentationOrder !== undefined;
  const bHasSourceOrder = b.sourceRegionOrder !== undefined
    && b.sourcePresentationOrder !== undefined;
  if (aHasSourceOrder && bHasSourceOrder) {
    return a.sourceRegionOrder! - b.sourceRegionOrder!
      || a.sourcePresentationOrder! - b.sourcePresentationOrder!
      || a.order - b.order;
  }
  if (aHasSourceOrder !== bHasSourceOrder) return aHasSourceOrder ? -1 : 1;
  // Newly-authored events have no source packet index. Retain deterministic
  // Off-before-On ordering for retriggers, including loop-expanded boundaries.
  return a.priority - b.priority || a.order - b.order;
}

/** Write a single MIDI Clip File. Multiple DAW tracks are deliberately merged into its one UMP sequence. */
export function writeMidiClipFile(tracks: MidiExportTrack[], options: MidiExportOptions): Uint8Array {
  if (!tracks.length) throw new Error("Select at least one MIDI track");
  const earliest = tracks.reduce((minimum, track) => track.regions.reduce(
    (value, region) => Math.min(value, region.startBeats), minimum,
  ), Infinity);
  const origin = options.fromProjectStart || !Number.isFinite(earliest) ? 0 : earliest;
  const events: ClipEvent[] = [];
  const profileConfigurationPackets: Array<{ words: number[]; order: number }> = [];
  const receiverConfigurationPackets: Array<{ words: number[]; order: number }> = [];
  let order = 0;
  let nextRegionOrder = 0;
  const appendEvent = (event: ClipEvent) => {
    if (!Number.isFinite(event.beat) || event.beat < 0)
      throw new Error("MIDI 2.0 clip contains an invalid event time");
    if (events.length + profileConfigurationPackets.length + receiverConfigurationPackets.length >= MAX_EVENTS)
      throw new Error("MIDI 2.0 clip exceeds the 200,000 event export limit");
    events.push(event);
  };
  const addNote = (note: MidiNoteRow, beat: number, durationBeats: number,
                   sourceRegionOrder: number, preserveSourceOrder: boolean) => {
    for (const [index, item] of notePackets({ ...note, startBeats: beat, durationBeats }, 0).entries()) {
      const sourcePresentationOrder = item.presentationOrder;
      const hasSourceOrder = preserveSourceOrder && Number.isSafeInteger(sourcePresentationOrder)
        && sourcePresentationOrder! >= 0 && sourcePresentationOrder! <= MAX_EVENTS;
      appendEvent({ ...item, priority: index === 0 ? 2 : 0, order: order++,
        ...(hasSourceOrder ? { sourceRegionOrder, sourcePresentationOrder } : {}) });
    }
  };
  for (const track of tracks) for (const region of track.regions) {
    const sourceRegionOrder = nextRegionOrder++;
    if (region.muted) continue;
    const loopLength = region.loopLengthBeats > 0 ? region.loopLengthBeats : region.durationBeats;
    const expandRegionLoop = options.expandLoops && region.loop && loopLength > 0;
    const firstRelativeBeat = (sourceBeat: number): number | null => {
      if (!Number.isFinite(sourceBeat)
          || (region.loop && !midiRegionContainsLoopSourceBeat(region, sourceBeat))) return null;
      const relative = expandRegionLoop
        ? midiRegionLoopOccurrence(region, sourceBeat)
        : sourceBeat - region.clipOffsetBeats;
      return relative >= 0 && relative < region.durationBeats ? relative : null;
    };
    const notes = region.notes.flatMap((note) => {
      if (note.muted) return [];
      const relative = firstRelativeBeat(note.startBeats);
      return relative === null ? [] : [{ note, relative }];
    });
    const umpEvents = (region.umpEvents ?? []).flatMap<ExportUmpEvent>((event) => {
      if (!Number.isFinite(event.beat) || event.beat < 0)
        throw new Error("A stored UMP event has an invalid event time");
      const isConfiguration = event.configurationHeader === true
        || event.profileConfigurationHeader === true;
      if (event.profileConfigurationHeader === true && event.configurationHeader !== true)
        throw new Error("A MIDI Clip profile packet must also be a configuration-header packet");
      const relative = firstRelativeBeat(event.beat);
      const wordCount = event.wordCount;
      const words = Array.isArray(event.words) ? event.words.slice(0, wordCount) : [];
      if (wordCount < 1 || wordCount > 4 || words.length !== wordCount
          || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff_ffff))
        throw new Error("A stored UMP event is malformed");
      const expectedWords = packetWords(words[0] >>> 28);
      if (expectedWords !== wordCount) throw new Error("A stored UMP event has an invalid packet length");
      if (event.profileConfigurationHeader === true && (words[0] >>> 28) !== 3)
        throw new Error("A MIDI Clip profile configuration packet must use SysEx7 UMP");
      if (isConfiguration) {
        // Configuration belongs to the file header, not the region timeline:
        // it is emitted once and is never loop-expanded or trim-shifted.
        return [{ configuration: true as const, profile: event.profileConfigurationHeader === true, words }];
      }
      if (relative === null) return [];
      return [{ configuration: false as const, profile: false, relative, words,
        ...(Number.isSafeInteger(event.presentationOrder) && event.presentationOrder! >= 0
          && event.presentationOrder! <= MAX_EVENTS ? { presentationOrder: event.presentationOrder } : {}) }];
    });
    const sequenceUmpEvents = umpEvents.filter(
      (event): event is ClipSequenceUmpEvent => !event.configuration,
    );
    const configurationEvents = umpEvents.filter((event) => event.configuration);
    const midiEvents = (region.events ?? []).flatMap((event) => {
      const relative = firstRelativeBeat(event.beat);
      if (relative === null) return [];
      const words = midi1EventToUmp(event.status, event.data);
      return words ? [{ relative, words }] : [];
    });
    if (!notes.length && !sequenceUmpEvents.length && !midiEvents.length
        && !configurationEvents.length) continue;

    for (const event of configurationEvents) {
      const destination = event.profile ? profileConfigurationPackets : receiverConfigurationPackets;
      if (events.length + profileConfigurationPackets.length + receiverConfigurationPackets.length >= MAX_EVENTS)
        throw new Error("MIDI 2.0 clip exceeds the 200,000 event export limit");
      destination.push({ words: event.words, order: order++ });
    }

    const loops = expandRegionLoop
      ? Math.min(100_000, Math.ceil(region.durationBeats / loopLength)) : 1;
    for (let iteration = 0; iteration < loops; iteration++) {
      const loopOffset = expandRegionLoop ? iteration * loopLength : 0;
      for (const { note, relative: sourceRelative } of notes) {
        const relative = sourceRelative + loopOffset;
        if (relative >= region.durationBeats) continue;
        const beat = region.startBeats + relative - origin;
        if (beat < -1e-9) continue;
        const availableInLoop = region.loop
          ? (region.loopStartBeats ?? 0) + loopLength - note.startBeats
          : note.durationBeats;
        addNote(note, Math.max(0, beat), Math.min(
          note.durationBeats, availableInLoop, region.durationBeats - relative,
        ), sourceRegionOrder, !expandRegionLoop);
      }
      for (const event of sequenceUmpEvents) {
        const { relative: sourceRelative, words } = event;
        const relative = sourceRelative + loopOffset;
        if (relative < 0 || relative >= region.durationBeats) continue;
        const beat = region.startBeats + relative - origin;
        if (beat >= -1e-9) {
          const hasSourceOrder = !expandRegionLoop && event.presentationOrder !== undefined;
          appendEvent({ beat: Math.max(0, beat), words, priority: 1, order: order++,
            ...(hasSourceOrder ? { sourceRegionOrder,
              sourcePresentationOrder: event.presentationOrder } : {}) });
        }
      }
      for (const { relative: sourceRelative, words } of midiEvents) {
        const relative = sourceRelative + loopOffset;
        if (relative < 0 || relative >= region.durationBeats) continue;
        const beat = region.startBeats + relative - origin;
        if (beat >= -1e-9)
          appendEvent({ beat: Math.max(0, beat), words, priority: 1, order: order++ });
      }
    }
  }
  const rawTempoEvents = [...(options.tempoEvents ?? [{ beat: 0, bpm: options.bpm }])]
    .filter((item) => Number.isFinite(item.beat) && Number.isFinite(item.bpm) && item.bpm > 0)
    .sort((a, b) => a.beat - b.beat);
  const effectiveTempo = rawTempoEvents.filter((item) => item.beat <= origin + 1e-9).at(-1)
    ?? { beat: origin, bpm: options.bpm };
  const tempoEvents = [
    { ...effectiveTempo, beat: 0 },
    ...rawTempoEvents.filter((item) => item.beat > origin + 1e-9).map((item) => ({ ...item, beat: item.beat - origin })),
  ];
  for (const item of tempoEvents) {
    const beat = item.beat;
    if (beat < -1e-9) continue;
    const quantizedBeat = Math.max(0, Math.round(beat * 24) / 24);
    const units = Math.max(1, Math.min(0xffff_ffff, Math.round(60 / item.bpm * 100_000_000)));
    appendEvent({ beat: quantizedBeat, words: [0xd0100000, units >>> 0, 0, 0], priority: -2, order: order++ });
  }
  const rawMeterEvents = [...(options.meterEvents ?? [{ beat: 0, numerator: options.numerator, denominator: options.denominator }])]
    .filter((item) => Number.isFinite(item.beat) && item.numerator > 0 && Number.isInteger(item.denominator))
    .sort((a, b) => a.beat - b.beat);
  const effectiveMeter = rawMeterEvents.filter((item) => item.beat <= origin + 1e-9).at(-1)
    ?? { beat: origin, numerator: options.numerator, denominator: options.denominator };
  const meterEvents = [
    { ...effectiveMeter, beat: 0 },
    ...rawMeterEvents.filter((item) => item.beat > origin + 1e-9).map((item) => ({ ...item, beat: item.beat - origin })),
  ];
  for (const item of meterEvents) {
    const beat = item.beat;
    if (beat < -1e-9) continue;
    const power = Math.log2(item.denominator);
    if (!Number.isInteger(power) || power < 0 || power > 7) continue;
    const quantizedBeat = Math.max(0, Math.round(beat * 24) / 24);
    const word1 = (((item.numerator & 0xff) << 24) | ((power & 0xff) << 16) | (8 << 8)) >>> 0;
    appendEvent({ beat: quantizedBeat, words: [0xd0100001, word1, 0, 0], priority: -1, order: order++ });
  }
  if (!events.length) throw new Error("No MIDI events to export");
  if (events.length + profileConfigurationPackets.length + receiverConfigurationPackets.length > MAX_EVENTS)
    throw new Error("MIDI 2.0 clip exceeds the 200,000 event export limit");
  // Imported source ordering is honored first; the comparator applies the
  // retrigger fallback to newly authored and loop-expanded events.
  events.sort(compareClipEvents);
  profileConfigurationPackets.sort((a, b) => a.order - b.order);
  receiverConfigurationPackets.sort((a, b) => a.order - b.order);
  validateMidiClipProfilePackets(profileConfigurationPackets.map((packet) => packet.words));
  assertNoMidiClipPropertyExchange(events.map((event) => event.words));

  const bytes = [...Array.from(MAGIC).map((letter) => letter.charCodeAt(0))];
  for (const packet of profileConfigurationPackets)
    for (const word of packet.words) appendWord(bytes, word >>> 0);
  appendWord(bytes, dcs(0));
  appendWord(bytes, 0x00300000 | TPQ);
  for (const packet of receiverConfigurationPackets) {
    appendWord(bytes, dcs(0));
    for (const word of packet.words) appendWord(bytes, word >>> 0);
  }
  appendWord(bytes, dcs(0));
  appendWord(bytes, 0xf0200000); // UMP Stream: Start of Clip (complete, 128-bit packet)
  appendWord(bytes, 0);
  appendWord(bytes, 0);
  appendWord(bytes, 0);
  let previousTick = 0;
  for (const event of events) {
    let tick = Math.max(previousTick, Math.round(event.beat * TPQ));
    while (tick - previousTick > MAX_DELTA) {
      appendWord(bytes, dcs(MAX_DELTA));
      previousTick += MAX_DELTA;
      appendWord(bytes, 0); // Utility NOOP resets the DC accumulator on very long gaps.
    }
    appendWord(bytes, dcs(tick - previousTick));
    for (const word of event.words) appendWord(bytes, word >>> 0);
    previousTick = tick;
  }
  appendWord(bytes, dcs(0));
  appendWord(bytes, 0xf0210000); // UMP Stream: End of Clip (complete, 128-bit packet)
  appendWord(bytes, 0);
  appendWord(bytes, 0);
  appendWord(bytes, 0);
  return Uint8Array.from(bytes);
}

export function isMidiClipFile(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 8)) === MAGIC;
}
