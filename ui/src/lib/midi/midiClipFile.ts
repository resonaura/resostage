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
// Highest DCTPQ at or below 65,535 that remains divisible by both the
// 24-pulse MIDI Clock grid and the common 960 PPQ timeline grid.
const TPQ = 65_280;
const MAX_DELTA = 0x000f_ffff;
const MAX_OUTPUT_PACKETS = MAX_EVENTS * 4 + 16;
const MAX_SET_TEMPO_UNITS = 0xffff_ffff;

function setTempoUnitsForBpm(bpm: number): number {
  const units = Math.round(6_000_000_000 / bpm);
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isSafeInteger(units)
      || units < 1 || units > MAX_SET_TEMPO_UNITS)
    throw new Error("MIDI Clip tempo is outside the MIDI 2.0 Set Tempo encoding range");
  return units;
}

function packetWords(messageType: number): number {
  if (messageType <= 2 || messageType === 6 || messageType === 7) return 1;
  if (messageType === 3 || messageType === 4 || (messageType >= 8 && messageType <= 10)) return 2;
  if (messageType === 11 || messageType === 12) return 3;
  if (messageType === 5 || messageType >= 13) return 4;
  throw new Error("Invalid UMP message type");
}

function isSetTempoFlexMessage(words: number[]): boolean {
  return words.length === 4 && (words[0] >>> 28) === 0xd
    && ((words[0] >>> 8) & 0xff) === 0 && (words[0] & 0xff) === 0;
}

function isSetTimeSignatureFlexMessage(words: number[]): boolean {
  return words.length === 4 && (words[0] >>> 28) === 0xd
    && ((words[0] >>> 8) & 0xff) === 0 && (words[0] & 0xff) === 1;
}

function validateTimingFlexMessage(words: number[]): void {
  const word0 = words[0];
  const isTempo = isSetTempoFlexMessage(words);
  const isTimeSignature = isSetTimeSignatureFlexMessage(words);
  if (!isTempo && !isTimeSignature) return;

  const name = isTempo ? "Set Tempo" : "Set Time Signature";
  const format = (word0 >>> 22) & 0x3;
  const address = (word0 >>> 20) & 0x3;
  const channel = (word0 >>> 16) & 0xf;
  if (format !== 0 || address !== 1 || channel !== 0)
    throw new Error(`MIDI 2.0 clip ${name} has an invalid format, address, or reserved channel`);

  if (isTempo) {
    if (words[1] === 0)
      throw new Error("MIDI 2.0 clip Set Tempo has a zero time-per-quarter-note value");
    if (words[2] !== 0 || words[3] !== 0)
      throw new Error("MIDI 2.0 clip Set Tempo has nonzero reserved data");
  } else if ((words[1] & 0xff) !== 0 || words[2] !== 0 || words[3] !== 0) {
    throw new Error("MIDI 2.0 clip Set Time Signature has nonzero reserved data");
  }
}

function validateClipMarker(words: number[], name: "Start" | "End"): void {
  const word0 = words[0];
  const format = (word0 >>> 26) & 0x3;
  if (format !== 0 || (word0 & 0xffff) !== 0 || words.slice(1).some((word) => word !== 0))
    throw new Error(`MIDI 2.0 clip ${name} of Clip has an invalid form or nonzero reserved data`);
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
    // DCS/NOOP packets are not retained as musical events, but still count
    // toward parsing work. Long-gap resets add two control packets around an
    // event's own DCS, so match the writer's bounded packet ceiling.
    if (++packetCount > MAX_OUTPUT_PACKETS) throw new Error("MIDI 2.0 clip has too many UMP packets");
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
        const hadPrecedingDcs = immediatelyPrecededByDcs;
        immediatelyPrecededByDcs = false;
        if (status === 0) {
          if (!hasDctpq || activeDcsDelta === null || !hadPrecedingDcs)
            throw new Error("MIDI 2.0 clip NOOP must immediately follow a Delta Clockstamp");
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
        validateClipMarker(words, "Start");
        if (started || ended) throw new Error("MIDI 2.0 clip has an unexpected Start of Clip");
        if (precedingDcsDelta === null)
          throw new Error("MIDI 2.0 clip Start of Clip must have a preceding Delta Clockstamp");
        started = true;
        startTicks = ticks;
        continue;
      }
      if (status === 0x21) {
        validateClipMarker(words, "End");
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
    const isSetTempo = isSetTempoFlexMessage(words);
    const isSetTimeSignature = isSetTimeSignatureFlexMessage(words);
    if (isSetTempo || isSetTimeSignature) validateTimingFlexMessage(words);
    const preDctpqTempoOrMeter = isSetTempo || isSetTimeSignature;
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
    const isSetTempo = isSetTempoFlexMessage(words);
    const isSetTimeSignature = isSetTimeSignatureFlexMessage(words);
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
        tempoEvents.push({ beat, bpm: 6_000_000_000 / units });
        continue;
      } else if (isSetTimeSignature) {
        // The protocol defines a 1–256 range in an 8-bit field; zero therefore
        // encodes the maximum value of 256.
        const numeratorField = (words[1] >>> 24) & 0xff;
        const numerator = numeratorField === 0 ? 256 : numeratorField;
        const denominatorPower = (words[1] >>> 16) & 0xff;
        if (denominatorPower >= 1 && denominatorPower <= 7) {
          const thirtySecondsPerQuarter = (words[1] >>> 8) & 0xff;
          meterEvents.push({ beat, numerator, denominator: 2 ** denominatorPower,
            ...(thirtySecondsPerQuarter !== 8 ? { thirtySecondsPerQuarter } : {}) });
        } else {
          // Preserve non-standard and currently unsupported denominators as
          // opaque UMP instead of misrepresenting or silently dropping them.
          // A configuration-header meter cannot stay in the header by itself:
          // its normalized Set Tempo is emitted in sequence data. Keep this
          // opaque meter at sequence beat zero so export remains parseable.
          rawEvents.push({ beat, words, wordCount: words.length,
            ...(inSequence || isSetTimeSignature ? { presentationOrder } : {}) });
        }
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
        if (type === 2 && ((word0 & 0x8080) !== 0))
          throw new Error("MIDI 1.0 UMP note data bytes must be 7-bit values");
        const pitch = (word0 >>> 8) & 0x7f;
        const eventVelocity = type === 4
          ? (words[1] >>> 16) & 0xffff
          : midi1VelocityToMidi2((word0 & 0x7f) / 127);
        const attributeType = type === 4 ? word0 & 0xff : 0;
        const attributeData = type === 4 ? words[1] & 0xffff : 0;
        // UMP MIDI 1.0 and MIDI 2.0 Channel Voice packets are distinct
        // protocols, not interchangeable note edges. Valid UMP groups do not
        // mix these message types; if a malformed/legacy stream does, keep
        // each unmatched edge isolated instead of cross-pairing and losing it.
        const key = `${type}:${group}:${channel}:${pitch}`;
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
            // MIDI timestamps are event times, not quantized note lengths. A
            // Note On and its matching Note Off may share one tick; preserve
            // that zero-length pair instead of inventing musical duration.
            durationBeats: Math.max(0, (relativeTicks - start.tick) / tpq),
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
  const sequenceEndTicks = Math.max(0, clipEndTicks - startTicks);
  for (const queue of held.values()) for (const start of queue) {
    notes.push({
      id: nextId++, pitch: start.pitch, channel: start.channel,
      startBeats: start.tick / tpq,
      // A note without an explicit release remains active through End of Clip.
      // Do not invent a short gate: SMF import already uses the track end for
      // the same malformed-but-common input case.
      durationBeats: Math.max(0, sequenceEndTicks - start.tick) / tpq,
      velocity: start.velocity / 65535, releaseVelocity: 0, probability: 1,
      midi2: { group: start.group, velocity: start.velocity, releaseVelocity: 0,
        attributeType: start.attributeType, attributeData: start.attributeData,
        releaseAttributeType: 0, releaseAttributeData: 0,
        attackOrder: start.attackOrder, releaseOrder: -1 },
    });
  }
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

function clipTicksForBeat(beat: number): number {
  const ticks = Math.round(beat * TPQ);
  if (!Number.isSafeInteger(ticks) || ticks < 0)
    throw new Error("MIDI 2.0 clip event time exceeds the safe DCTPQ range");
  return ticks;
}

function sysex7Packet(status: number, payload: number[]): number[] {
  const count = payload.length;
  const padded = [...payload, ...Array<number>(6 - count).fill(0)];
  return [
    ((3 << 28) | (status << 20) | (count << 16) | ((padded[0] ?? 0) << 8) | (padded[1] ?? 0)) >>> 0,
    (((padded[2] ?? 0) << 24) | ((padded[3] ?? 0) << 16)
      | ((padded[4] ?? 0) << 8) | (padded[5] ?? 0)) >>> 0,
  ];
}

function midi1SystemMessageToUmp(status: number, data: number[]): number[] | null {
  const expectedLength = status === 0xf1 || status === 0xf3 ? 1
    : status === 0xf2 ? 2
      : [0xf6, 0xf8, 0xfa, 0xfb, 0xfc, 0xfe, 0xff].includes(status) ? 0 : -1;
  if (data.length !== expectedLength || data.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0x7f))
    return null;
  return [((1 << 28) | (status << 16) | ((data[0] ?? 0) << 8) | (data[1] ?? 0)) >>> 0];
}

function midi1ProgramChangeToUmp(
  channel: number,
  program: number,
  bank?: { msb: number; lsb: number },
): number[] {
  const bankValid = bank !== undefined;
  const first = ((4 << 28) | (0xc << 20) | (channel << 16) | (bankValid ? 1 : 0)) >>> 0;
  const second = ((program << 24) | ((bank?.msb ?? 0) << 8) | (bank?.lsb ?? 0)) >>> 0;
  return [first, second];
}

function midi1ParameterToUmp(
  channel: number,
  type: "rpn" | "nrpn",
  bank: number,
  index: number,
  value14: number,
): number[] {
  const value32 = upscaleMidi1ParameterTo32(type, bank, index, value14);
  const status = type === "rpn" ? 0x2 : 0x3;
  const first = ((4 << 28) | (status << 20) | (channel << 16) | (bank << 8) | index) >>> 0;
  return [first, value32];
}

/**
 * MIDI 2.0 Protocol §7.4.7.1 defines fixed-width data fields for several RPNs.
 * These are integer/structured values, not ranges, so generic min/center/max
 * scaling would populate bits receivers are required to ignore.
 */
function upscaleMidi1ParameterTo32(
  type: "rpn" | "nrpn",
  bank: number,
  index: number,
  value14: number,
): number {
  if (type === "rpn" && bank === 0) {
    if (index === 0) return (value14 << 18) >>> 0;
    if ([2, 3, 4, 6].includes(index)) return (((value14 >>> 7) & 0x7f) << 25) >>> 0;
  }
  return upscale14To32(value14);
}

/** MIDI 2.0 Appendix D.1.3 min/center/max upscaling for a 14-bit value. */
function upscale14To32(value: number): number {
  const shifted = (value << 18) >>> 0;
  if (value <= 0x2000) return shifted;
  const repeated = value & 0x1fff;
  return (shifted | (repeated << 5) | (repeated >>> 8)) >>> 0;
}

/** Convert one complete, representable MIDI 1.0 message to group-zero UMPs. */
export function midi1EventToUmps(status: number, data: number[]): number[][] | null {
  if (!Number.isInteger(status) || status < 0x80 || status > 0xff) return null;
  if (status === 0xf0) {
    if (data.at(-1) !== 0xf7) return null;
    const payload = data.slice(0, -1);
    if (payload.length > MAX_EVENTS * 6
        || payload.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0x7f)) return null;
    if (payload.length <= 6) return [sysex7Packet(0, payload)];
    const packets: number[][] = [];
    for (let offset = 0; offset < payload.length; offset += 6) {
      const part = payload.slice(offset, offset + 6);
      const isFirst = offset === 0;
      const isLast = offset + part.length === payload.length;
      packets.push(sysex7Packet(isFirst ? 1 : isLast ? 3 : 2, part));
    }
    return packets;
  }
  if (status >= 0xf0) {
    if (status === 0xf7) return null; // SMF F7 may be either SysEx continuation or an escape event.
    const words = midi1SystemMessageToUmp(status, data);
    return words ? [words] : null;
  }
  const kind = status & 0xf0;
  if (kind < 0x80 || kind > 0xe0) return null;
  const expectedLength = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
  if (data.length !== expectedLength
      || data.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0x7f)) return null;
  const a = data[0];
  const b = data[1] ?? 0;
  // MIDI 2.0 has dedicated messages or stateful compound translation for
  // Bank Select, RPN/NRPN, and the MIDI 1.0 high-resolution velocity prefix.
  // Never mislabel those reserved CC indices as ordinary MIDI 2.0 CCs.
  if (kind === 0xb0 && [0, 6, 32, 38, 88, 98, 99, 100, 101].includes(a)) return null;
  if (kind === 0xc0) return [midi1ProgramChangeToUmp(status & 0x0f, a)];
  return [[((0x2 << 28) | (kind << 20) | ((status & 0x0f) << 16) | (a << 8) | b) >>> 0]];
}

export interface Midi1EventForClip {
  beat: number;
  status: number;
  data: number[];
}

export interface Midi1ClipEventConversion {
  events: Array<{ beat: number; words: number[]; sourceOrder: number; packetOrder: number }>;
  unsupportedEventCount: number;
  exceededEventLimit: boolean;
}

interface ScheduledMidi1Event extends Midi1EventForClip {
  regionOrder: number;
  loopOrder: number;
  sourceEventOrder: number;
}

interface Midi1ParameterState {
  selectedType?: "rpn" | "nrpn";
  rpnMsb?: number;
  rpnLsb?: number;
  nrpnMsb?: number;
  nrpnLsb?: number;
  hasRpnMsb: boolean;
  hasRpnLsb: boolean;
  hasNrpnMsb: boolean;
  hasNrpnLsb: boolean;
  pendingDataMsb?: { value: number; beat: number; sourceOrder: number };
}

/**
 * Convert a track's ordered MIDI 1.0 events to UMP while keeping SysEx
 * continuation state local to that track. An F7 without an open F0 is an SMF
 * escape event, not a continuation, and has no implicit UMP interpretation.
 */
export function midi1EventsToUmps(events: ReadonlyArray<Midi1EventForClip>): Midi1ClipEventConversion {
  const converted: Midi1ClipEventConversion = {
    events: [], unsupportedEventCount: 0, exceededEventLimit: false,
  };
  let pendingSysex: Array<{ beat: number; payload: number[]; sourceOrder: number }> | null = null;
  let pendingByteCount = 0;
  const bankByChannel = new Map<number, { msb: number; lsb: number; pendingMessageCount: number }>();
  const parameterByChannel = new Map<number, Midi1ParameterState>();
  const maxPendingBytes = MAX_EVENTS * 6;
  const append = (beat: number, words: number[], sourceOrder: number, packetOrder: number) => {
    if (converted.events.length >= MAX_EVENTS) {
      converted.exceededEventLimit = true;
      return;
    }
    converted.events.push({ beat, words, sourceOrder, packetOrder });
  };
  const discardPendingSysex = () => {
    if (pendingSysex) converted.unsupportedEventCount += pendingSysex.length;
    pendingSysex = null;
    pendingByteCount = 0;
  };
  const appendSysexPackets = (
    segments: Array<{ beat: number; payload: number[]; sourceOrder: number }>, completeAtEnd: boolean,
  ) => {
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex];
      const isFirstSegment = segmentIndex === 0;
      const isLastSegment = completeAtEnd && segmentIndex === segments.length - 1;
      let packetOrder = 0;
      if (segment.payload.length === 0) {
        if (segments.length === 1 && completeAtEnd) {
          append(segment.beat, sysex7Packet(0, []), segment.sourceOrder, packetOrder);
        } else if (isFirstSegment) {
          append(segment.beat, sysex7Packet(1, []), segment.sourceOrder, packetOrder);
        } else if (isLastSegment) {
          append(segment.beat, sysex7Packet(3, []), segment.sourceOrder, packetOrder);
        }
        if (converted.exceededEventLimit) return;
        continue;
      }
      for (let offset = 0; offset < segment.payload.length; offset += 6) {
        const payload = segment.payload.slice(offset, offset + 6);
        const isSegmentFirstPacket = offset === 0;
        const isSegmentLastPacket = offset + payload.length === segment.payload.length;
        const isFirstPacket = isFirstSegment && isSegmentFirstPacket;
        const isLastPacket = isLastSegment && isSegmentLastPacket;
        const status = segments.length === 1 && completeAtEnd && isFirstPacket && isLastPacket
          ? 0 : isFirstPacket ? 1 : isLastPacket ? 3 : 2;
        append(segment.beat, sysex7Packet(status, payload), segment.sourceOrder, packetOrder++);
        if (converted.exceededEventLimit) return;
      }
    }
  };
  const parameterStateFor = (channel: number): Midi1ParameterState => {
    const existing = parameterByChannel.get(channel);
    if (existing) return existing;
    const created: Midi1ParameterState = {
      hasRpnMsb: false, hasRpnLsb: false, hasNrpnMsb: false, hasNrpnLsb: false,
    };
    parameterByChannel.set(channel, created);
    return created;
  };
  const flushParameterData = (channel: number, state: Midi1ParameterState) => {
    const pending = state.pendingDataMsb;
    if (!pending) return;
    state.pendingDataMsb = undefined;

    const type = state.selectedType;
    const bank = type === "rpn" ? state.rpnMsb : state.nrpnMsb;
    const index = type === "rpn" ? state.rpnLsb : state.nrpnLsb;
    const hasCompleteSelection = type === "rpn"
      ? state.hasRpnMsb && state.hasRpnLsb
      : type === "nrpn" && state.hasNrpnMsb && state.hasNrpnLsb;
    if (!type || !hasCompleteSelection || bank === undefined || index === undefined
        || (type === "rpn" && bank === 0x7f && index === 0x7f)) {
      converted.unsupportedEventCount++;
      return;
    }
    append(pending.beat, midi1ParameterToUmp(channel, type, bank, index, pending.value << 7), pending.sourceOrder, 0);
  };
  const convertParameterData = (
    channel: number,
    state: Midi1ParameterState,
    lsb: number,
    beat: number,
    sourceOrder: number,
  ) => {
    const pending = state.pendingDataMsb;
    if (!pending) {
      converted.unsupportedEventCount++;
      return;
    }
    state.pendingDataMsb = undefined;

    const type = state.selectedType;
    const bank = type === "rpn" ? state.rpnMsb : state.nrpnMsb;
    const index = type === "rpn" ? state.rpnLsb : state.nrpnLsb;
    const hasCompleteSelection = type === "rpn"
      ? state.hasRpnMsb && state.hasRpnLsb
      : type === "nrpn" && state.hasNrpnMsb && state.hasNrpnLsb;
    if (!type || !hasCompleteSelection || bank === undefined || index === undefined
        || (type === "rpn" && bank === 0x7f && index === 0x7f)) {
      converted.unsupportedEventCount++;
      return;
    }
    const value14 = (pending.value << 7) | lsb;
    append(beat, midi1ParameterToUmp(channel, type, bank, index, value14), sourceOrder, 0);
  };

  for (const [sourceOrder, event] of events.entries()) {
    if (converted.exceededEventLimit) break;
    if (event.status === 0xf0) {
      if (pendingSysex) discardPendingSysex();
      const endsMessage = event.data.at(-1) === 0xf7;
      const payload = endsMessage ? event.data.slice(0, -1) : event.data;
      const valid = payload.length <= maxPendingBytes
        && payload.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0x7f);
      if (!valid) {
        converted.unsupportedEventCount++;
        continue;
      }
      const segment = { beat: event.beat, payload, sourceOrder };
      if (endsMessage) {
        appendSysexPackets([segment], true);
      } else {
        pendingSysex = [segment];
        pendingByteCount = payload.length;
      }
      continue;
    }

    if (event.status === 0xf7) {
      if (!pendingSysex) {
        converted.unsupportedEventCount++;
        continue;
      }
      const endsMessage = event.data.at(-1) === 0xf7;
      const payload = endsMessage ? event.data.slice(0, -1) : event.data;
      const valid = pendingByteCount + payload.length <= maxPendingBytes
        && payload.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0x7f);
      if (!valid) {
        discardPendingSysex();
        converted.unsupportedEventCount++;
        continue;
      }
      pendingSysex.push({ beat: event.beat, payload, sourceOrder });
      pendingByteCount += payload.length;
      if (endsMessage) {
        appendSysexPackets(pendingSysex, true);
        pendingSysex = null;
        pendingByteCount = 0;
      }
      continue;
    }

    const isRealtime = event.status >= 0xf8 && event.status <= 0xff;
    if (pendingSysex && !isRealtime) discardPendingSysex();
    const kind = event.status & 0xf0;
    const channel = event.status & 0x0f;

    if (kind === 0xb0 && [6, 38, 98, 99, 100, 101].includes(event.data[0])) {
      const controller = event.data[0];
      const valid = event.data.length === 2
        && event.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0x7f);
      const state = parameterStateFor(channel);
      if ([98, 99, 100, 101].includes(controller)) flushParameterData(channel, state);
      else if (controller === 6 && state.pendingDataMsb)
        flushParameterData(channel, state);

      if (!valid) {
        converted.unsupportedEventCount++;
        continue;
      }
      const value = event.data[1];
      switch (controller) {
        case 101:
          state.selectedType = "rpn";
          state.rpnMsb = value;
          state.hasRpnMsb = true;
          break;
        case 100:
          state.selectedType = "rpn";
          state.rpnLsb = value;
          state.hasRpnLsb = true;
          break;
        case 99:
          state.selectedType = "nrpn";
          state.nrpnMsb = value;
          state.hasNrpnMsb = true;
          break;
        case 98:
          state.selectedType = "nrpn";
          state.nrpnLsb = value;
          state.hasNrpnLsb = true;
          break;
        case 6:
          state.pendingDataMsb = { value, beat: event.beat, sourceOrder };
          break;
        case 38:
          convertParameterData(channel, state, value, event.beat, sourceOrder);
          break;
      }
      continue;
    }

    if (kind === 0xb0 && (event.data[0] === 0 || event.data[0] === 32)) {
      const valid = event.data.length === 2
        && event.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0x7f);
      if (!valid) {
        converted.unsupportedEventCount++;
        continue;
      }
      const bank = bankByChannel.get(channel) ?? { msb: 0, lsb: 0, pendingMessageCount: 0 };
      if (event.data[0] === 0) bank.msb = event.data[1];
      else bank.lsb = event.data[1];
      bank.pendingMessageCount++;
      bankByChannel.set(channel, bank);
      continue;
    }

    let packets = midi1EventToUmps(event.status, event.data);
    if (kind === 0xc0 && packets) {
      const bank = bankByChannel.get(channel);
      if (bank && bank.pendingMessageCount > 0) {
        packets = [midi1ProgramChangeToUmp(channel, event.data[0], bank)];
        bank.pendingMessageCount = 0;
      }
    }
    if (!packets) {
      converted.unsupportedEventCount++;
      continue;
    }
    for (const [packetOrder, words] of packets.entries()) append(event.beat, words, sourceOrder, packetOrder);
  }
  if (pendingSysex) discardPendingSysex();
  for (const [channel, state] of parameterByChannel) flushParameterData(channel, state);
  for (const bank of bankByChannel.values())
    converted.unsupportedEventCount += bank.pendingMessageCount;
  converted.events.sort((a, b) => a.beat - b.beat
    || a.sourceOrder - b.sourceOrder || a.packetOrder - b.packetOrder);
  return converted;
}

/**
 * Convert the MIDI 1.0 event stream formed by selected regions into one UMP
 * stream. Compound channel state is therefore shared across regions/tracks,
 * matching the merged MIDI Clip sequence rather than resetting at each clip.
 */
export function midi1RegionsToUmps(
  tracks: ReadonlyArray<MidiExportTrack>,
  options: Pick<MidiExportOptions, "fromProjectStart" | "expandLoops">,
): Midi1ClipEventConversion {
  const earliest = tracks.reduce((minimum, track) => track.regions.reduce(
    (value, region) => Math.min(value, region.startBeats), minimum,
  ), Infinity);
  const origin = options.fromProjectStart || !Number.isFinite(earliest) ? 0 : earliest;
  const scheduled: ScheduledMidi1Event[] = [];
  let regionOrder = 0;
  let exceededEventLimit = false;

  for (const track of tracks) for (const region of track.regions) {
    const currentRegionOrder = regionOrder++;
    if (region.muted) continue;
    const loopLength = region.loopLengthBeats > 0 ? region.loopLengthBeats : region.durationBeats;
    const expandRegionLoop = options.expandLoops && region.loop && loopLength > 0;
    const loopCount = expandRegionLoop
      ? Math.min(100_000, Math.ceil(region.durationBeats / loopLength)) : 1;
    for (const [sourceEventOrder, event] of (region.events ?? []).entries()) {
      if (!Number.isFinite(event.beat)
          || (region.loop && !midiRegionContainsLoopSourceBeat(region, event.beat))) continue;
      const sourceRelative = expandRegionLoop
        ? midiRegionLoopOccurrence(region, event.beat)
        : event.beat - region.clipOffsetBeats;
      if (sourceRelative < 0 || sourceRelative >= region.durationBeats) continue;

      for (let loopOrder = 0; loopOrder < loopCount; loopOrder++) {
        const relative = sourceRelative + (expandRegionLoop ? loopOrder * loopLength : 0);
        if (relative >= region.durationBeats) continue;
        const beat = region.startBeats + relative - origin;
        if (beat < -1e-9) continue;
        if (scheduled.length >= MAX_EVENTS) {
          exceededEventLimit = true;
          break;
        }
        scheduled.push({ beat: Math.max(0, beat), status: event.status, data: event.data,
          regionOrder: currentRegionOrder, loopOrder, sourceEventOrder });
      }
      if (exceededEventLimit) break;
    }
    if (exceededEventLimit) break;
  }

  scheduled.sort((a, b) => clipTicksForBeat(a.beat) - clipTicksForBeat(b.beat)
    || a.beat - b.beat || a.regionOrder - b.regionOrder
    || a.loopOrder - b.loopOrder || a.sourceEventOrder - b.sourceEventOrder);
  const converted = midi1EventsToUmps(scheduled);
  return exceededEventLimit ? { ...converted, exceededEventLimit: true } : converted;
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
  const tickDifference = clipTicksForBeat(a.beat) - clipTicksForBeat(b.beat);
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
    clipTicksForBeat(event.beat);
    if (events.length + profileConfigurationPackets.length + receiverConfigurationPackets.length >= MAX_EVENTS)
      throw new Error("MIDI 2.0 clip exceeds the 200,000 event export limit");
    events.push(event);
  };
  const midi1EventConversion = midi1RegionsToUmps(tracks, options);
  if (midi1EventConversion.exceededEventLimit)
    throw new Error("MIDI Clip exceeds the 200,000 event export limit");
  const addNote = (note: MidiNoteRow, beat: number, durationBeats: number,
                   sourceRegionOrder: number, preserveSourceOrder: boolean) => {
    for (const [index, item] of notePackets({ ...note, startBeats: beat, durationBeats }, 0).entries()) {
      const sourcePresentationOrder = item.presentationOrder;
      const hasSourceOrder = preserveSourceOrder && Number.isSafeInteger(sourcePresentationOrder)
        && sourcePresentationOrder! >= 0 && sourcePresentationOrder! <= MAX_EVENTS;
      // For a zero-length note, keep its attack before its own release. For
      // ordinary notes, release-before-attack remains necessary at retriggers.
      const priority = durationBeats <= 0
        ? (index === 0 ? 2 : 3)
        : (index === 0 ? 4 : 0);
      appendEvent({ ...item, priority, order: order++,
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
    if (!notes.length && !sequenceUmpEvents.length
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
    }
  }
  for (const event of midi1EventConversion.events)
    appendEvent({ beat: event.beat, words: event.words, priority: 1, order: order++ });
  const rawTempoEvents = [...(options.tempoEvents ?? [{ beat: 0, bpm: options.bpm }])];
  if (rawTempoEvents.some((item) => !Number.isFinite(item.beat)
      || !Number.isFinite(item.bpm) || item.bpm <= 0))
    throw new Error("MIDI Clip contains an invalid tempo event");
  rawTempoEvents.sort((a, b) => a.beat - b.beat);
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
    const units = setTempoUnitsForBpm(item.bpm);
    appendEvent({ beat: quantizedBeat, words: [0xd0100000, units >>> 0, 0, 0], priority: -2, order: order++ });
  }
  const rawMeterEvents = [...(options.meterEvents ?? [{ beat: 0, numerator: options.numerator, denominator: options.denominator }])]
    .filter((item) => Number.isFinite(item.beat))
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
    if (!Number.isInteger(item.numerator) || item.numerator < 1 || item.numerator > 256
        || !Number.isInteger(power) || power < 1 || power > 7)
      throw new Error("MIDI Clip cannot encode this time signature as standard Set Time Signature Flex Data");
    const thirtySecondsPerQuarter = item.thirtySecondsPerQuarter ?? 8;
    if (!Number.isInteger(thirtySecondsPerQuarter)
        || thirtySecondsPerQuarter < 0 || thirtySecondsPerQuarter > 0xff)
      throw new Error("MIDI Clip 1/32-note count must be an unsigned 8-bit integer");
    // Unlike Set Tempo, Set Time Signature is bar-positioned, not restricted
    // to the 24 MIDI Clock pulses per quarter. Preserve the full output DCTPQ grid
    // so short bars such as 1/128 are not displaced by MIDI Clock quantization.
    const quantizedBeat = Math.max(0, clipTicksForBeat(beat) / TPQ);
    const word1 = (((item.numerator & 0xff) << 24) | ((power & 0xff) << 16)
      | (thirtySecondsPerQuarter << 8)) >>> 0;
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
  let writtenPacketCount = 0;
  const appendPacket = (words: number[]) => {
    if (++writtenPacketCount > MAX_OUTPUT_PACKETS)
      throw new Error("MIDI 2.0 clip exceeds the bounded UMP packet export limit");
    for (const word of words) appendWord(bytes, word >>> 0);
  };
  for (const packet of profileConfigurationPackets) appendPacket(packet.words);
  appendPacket([dcs(0)]);
  appendPacket([0x00300000 | TPQ]);
  for (const packet of receiverConfigurationPackets) {
    appendPacket([dcs(0)]);
    appendPacket(packet.words);
  }
  appendPacket([dcs(0)]);
  appendPacket([0xf0200000, 0, 0, 0]); // UMP Stream: Start of Clip (complete, 128-bit packet)
  let previousTick = 0;
  for (const event of events) {
    const tick = Math.max(previousTick, clipTicksForBeat(event.beat));
    const requiredLongGapResets = Math.max(0, Math.floor((tick - previousTick - 1) / MAX_DELTA));
    if (writtenPacketCount + requiredLongGapResets * 2 + 2 > MAX_OUTPUT_PACKETS)
      throw new Error("MIDI 2.0 clip exceeds the bounded UMP packet export limit");
    while (tick - previousTick > MAX_DELTA) {
      appendPacket([dcs(MAX_DELTA)]);
      previousTick += MAX_DELTA;
      appendPacket([0]); // Utility NOOP resets the DC accumulator on very long gaps.
    }
    appendPacket([dcs(tick - previousTick)]);
    appendPacket(event.words);
    previousTick = tick;
  }
  appendPacket([dcs(0)]);
  appendPacket([0xf0210000, 0, 0, 0]); // UMP Stream: End of Clip (complete, 128-bit packet)
  return Uint8Array.from(bytes);
}

export function isMidiClipFile(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 8)) === MAGIC;
}
