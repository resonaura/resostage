/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiUmpEventRow } from "@/lib/state/types";
import {
  isPianoRollUmpControllerLane,
  MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS,
} from "@/screens/editor/pianoroll/logic/umpControllerLane";
import type { PianoRollBottomLane } from "@/screens/editor/pianoroll/logic/types";

export type PianoRollUmpControllerKind = "cc" | "pitchBend";

/** Semantic editing view for one supported MIDI 2.0 Channel Voice control packet. */
export interface PianoRollUmpControllerDraftRow {
  id: string;
  /** Index into the unchanged source collection; null identifies a newly-added packet. */
  sourceIndex: number | null;
  kind: PianoRollUmpControllerKind;
  /** Musical position in the region's source MIDI timeline, before trim/loop projection. */
  beat: number;
  group: number;
  channel: number;
  /** Used by CC; kept at zero for Pitch Bend packets. */
  controller: number;
  /** Exact unsigned 32-bit MIDI 2.0 data word. */
  value: number;
}

const MIDI2_MESSAGE_TYPE = 0x4;
const MIDI2_CC_STATUS = 0x0b;
const MIDI2_PITCH_BEND_STATUS = 0x0e;
const UINT32_MAX = 0xffff_ffff;
const MAX_SOURCE_BEAT = 1_000_000;
const RESERVED_COMPOUND_CC = new Set([0, 6, 32, 38, 88, 98, 99, 100, 101]);

export interface PianoRollUmpControllerPointEdit {
  sourceIndex: number;
  beat: number;
  value: number;
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

function decodeKind(event: MidiUmpEventRow): PianoRollUmpControllerKind | null {
  if (event.configurationHeader === true || event.profileConfigurationHeader === true
      || event.wordCount !== 2 || !Array.isArray(event.words) || event.words.length < 2
      || !Number.isFinite(event.beat) || event.beat < 0
      || !isUint32(event.words[0]) || !isUint32(event.words[1]))
    return null;
  const header = event.words[0];
  if ((header >>> 28) !== MIDI2_MESSAGE_TYPE || (header & 0xff) !== 0)
    return null;
  const status = (header >>> 20) & 0xf;
  const index = (header >>> 8) & 0xff;
  if (status === MIDI2_CC_STATUS && index <= 127 && !RESERVED_COMPOUND_CC.has(index))
    return "cc";
  if (status === MIDI2_PITCH_BEND_STATUS && index === 0)
    return "pitchBend";
  return null;
}

/** Reads supported CC/Pitch Bend packets only; unsupported words stay opaque. */
export function readPianoRollUmpControllerDraft(
  events: MidiUmpEventRow[],
): PianoRollUmpControllerDraftRow[] {
  const rows: PianoRollUmpControllerDraftRow[] = [];
  const count = Math.min(events.length, MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS);
  for (let sourceIndex = 0; sourceIndex < count; sourceIndex += 1) {
    const event = events[sourceIndex];
    if (!event) continue;
    const kind = decodeKind(event);
    if (!kind) continue;
    const header = event.words[0];
    rows.push({
      id: `source-${sourceIndex}`,
      sourceIndex,
      kind,
      beat: event.beat,
      group: (header >>> 24) & 0xf,
      channel: (header >>> 16) & 0xf,
      controller: kind === "cc" ? (header >>> 8) & 0xff : 0,
      value: event.words[1],
    });
  }
  return rows;
}

function validateRow(
  row: PianoRollUmpControllerDraftRow,
  originalBeat?: number,
): string | null {
  const unchangedLargeBeat = originalBeat !== undefined && row.beat === originalBeat;
  if (!Number.isFinite(row.beat) || row.beat < 0
      || (row.beat > MAX_SOURCE_BEAT && !unchangedLargeBeat))
    return "Beat must be between 0 and 1,000,000.";
  if (!Number.isInteger(row.group) || row.group < 0 || row.group > 15)
    return "UMP group must be between 0 and 15.";
  if (!Number.isInteger(row.channel) || row.channel < 0 || row.channel > 15)
    return "MIDI channel must be between 0 and 15.";
  if (!isUint32(row.value)) return "Value must be an unsigned 32-bit integer.";
  if (row.kind === "cc" && (!Number.isInteger(row.controller)
      || row.controller < 0 || row.controller > 127
      || RESERVED_COMPOUND_CC.has(row.controller)))
    return "Choose a standard CC number; compound RPN/NRPN controller numbers are read-only.";
  if (row.kind === "pitchBend" && row.controller !== 0)
    return "Pitch Bend has no controller index.";
  return null;
}

export function validatePianoRollUmpControllerDraft(
  source: MidiUmpEventRow[],
  rows: PianoRollUmpControllerDraftRow[],
): string | null {
  if (source.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS)
    return "This region exceeds the safe MIDI 2.0 editing limit; no packets were changed.";
  if (rows.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS)
    return "The MIDI 2.0 event limit has been reached.";

  const sourceIndices = new Set<number>();
  for (const row of rows) {
    const sourceEvent = row.sourceIndex !== null && Number.isInteger(row.sourceIndex)
      && row.sourceIndex >= 0 && row.sourceIndex < source.length
      ? source[row.sourceIndex]
      : undefined;
    const invalid = validateRow(row, sourceEvent?.beat);
    if (invalid) return invalid;
    if (row.sourceIndex === null) continue;
    if (!Number.isInteger(row.sourceIndex) || row.sourceIndex < 0
        || row.sourceIndex >= source.length || sourceIndices.has(row.sourceIndex))
      return "The MIDI 2.0 event list changed; reload it before saving.";
    const original = source[row.sourceIndex];
    if (!original || decodeKind(original) !== row.kind)
      return "The selected MIDI 2.0 event is no longer editable.";
    sourceIndices.add(row.sourceIndex);
  }
  let editableSourceCount = 0;
  for (const event of source) {
    if (decodeKind(event)) editableSourceCount += 1;
  }
  const removedSourceCount = editableSourceCount - sourceIndices.size;
  const addedCount = rows.reduce((count, row) => count + Number(row.sourceIndex === null), 0);
  if (source.length - removedSourceCount + addedCount > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS)
    return "The MIDI 2.0 event limit has been reached.";
  return null;
}

function replaceHeaderField(header: number, mask: number, value: number, shift: number): number {
  return (((header & ~mask) | ((value << shift) & mask)) >>> 0);
}

function packetFromRow(row: PianoRollUmpControllerDraftRow): MidiUmpEventRow {
  const status = row.kind === "cc" ? MIDI2_CC_STATUS : MIDI2_PITCH_BEND_STATUS;
  const controller = row.kind === "cc" ? row.controller : 0;
  const header = ((MIDI2_MESSAGE_TYPE << 28) | (row.group << 24)
    | (status << 20) | (row.channel << 16) | (controller << 8)) >>> 0;
  return { beat: row.beat, words: [header, row.value >>> 0], wordCount: 2 };
}

/**
 * Applies only visible semantic fields. Unsupported packets are copied as-is;
 * existing packet reserved bits and any trailing words survive edits.
 */
export function applyPianoRollUmpControllerDraft(
  source: MidiUmpEventRow[],
  rows: PianoRollUmpControllerDraftRow[],
): MidiUmpEventRow[] | null {
  if (validatePianoRollUmpControllerDraft(source, rows)) return null;
  const rowBySource = new Map(rows.flatMap((row) =>
    row.sourceIndex === null ? [] : [[row.sourceIndex, row] as const]));
  const result: MidiUmpEventRow[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const event = source[index];
    if (!event) continue;
    const originalKind = decodeKind(event);
    if (!originalKind) {
      result.push(event);
      continue;
    }
    const row = rowBySource.get(index);
    if (!row) continue;
    let header = event.words[0] >>> 0;
    header = replaceHeaderField(header, 0x0f00_0000, row.group, 24);
    header = replaceHeaderField(header, 0x000f_0000, row.channel, 16);
    if (row.kind === "cc")
      header = replaceHeaderField(header, 0x0000_ff00, row.controller, 8);
    const words = [...event.words];
    words[0] = header;
    words[1] = row.value >>> 0;
    result.push({ ...event, beat: row.beat, words });
  }
  for (const row of rows) {
    if (row.sourceIndex === null) result.push(packetFromRow(row));
  }
  return result;
}

/** Complete UMP equality independent of Core's stable time sort. */
export function sameEditablePianoRollUmpEvents(
  left: MidiUmpEventRow[],
  right: MidiUmpEventRow[],
): boolean {
  if (left.length !== right.length) return false;
  const wordsOf = (event: MidiUmpEventRow) => Array.isArray(event.words) ? event.words : [];
  const compare = (a: MidiUmpEventRow, b: MidiUmpEventRow): number => {
    if (!Object.is(a.beat, b.beat)) {
      const aFinite = Number.isFinite(a.beat);
      const bFinite = Number.isFinite(b.beat);
      if (aFinite !== bFinite) return aFinite ? -1 : 1;
      if (aFinite) return a.beat - b.beat;
      const beatOrder = String(a.beat).localeCompare(String(b.beat));
      if (beatOrder !== 0) return beatOrder;
    }
    if (a.wordCount !== b.wordCount) return a.wordCount - b.wordCount;
    const aWords = wordsOf(a);
    const bWords = wordsOf(b);
    if (aWords.length !== bWords.length) return aWords.length - bWords.length;
    for (let index = 0; index < aWords.length; index += 1) {
      if (aWords[index] !== bWords[index]) return aWords[index] - bWords[index];
    }
    const aConfiguration = a.configurationHeader === true ? 1 : 0;
    const bConfiguration = b.configurationHeader === true ? 1 : 0;
    if (aConfiguration !== bConfiguration) return aConfiguration - bConfiguration;
    const aProfile = a.profileConfigurationHeader === true ? 1 : 0;
    const bProfile = b.profileConfigurationHeader === true ? 1 : 0;
    if (aProfile !== bProfile) return aProfile - bProfile;
    const aPresentationOrder = a.presentationOrder ?? -1;
    const bPresentationOrder = b.presentationOrder ?? -1;
    if (aPresentationOrder !== bPresentationOrder) return aPresentationOrder - bPresentationOrder;
    return 0;
  };
  const sortedLeft = [...left].sort(compare);
  const sortedRight = [...right].sort(compare);
  return sortedLeft.every((event, index) => {
    const actual = sortedRight[index];
    const eventWords = wordsOf(event);
    const actualWords = wordsOf(actual);
    const beatMatches = Object.is(event.beat, actual.beat)
      || (Number.isFinite(event.beat) && Number.isFinite(actual.beat)
        && Math.abs(event.beat - actual.beat) < 1e-6);
    return beatMatches
      && event.wordCount === actual.wordCount
      && (event.configurationHeader === true) === (actual.configurationHeader === true)
      && (event.profileConfigurationHeader === true) === (actual.profileConfigurationHeader === true)
      && (event.presentationOrder ?? -1) === (actual.presentationOrder ?? -1)
      && eventWords.length === actualWords.length
      && eventWords.every((word, wordIndex) => word === actualWords[wordIndex]);
  });
}

export function copyPianoRollUmpEvents(events: MidiUmpEventRow[]): MidiUmpEventRow[] {
  return events.map((event) => Array.isArray(event?.words)
    ? { ...event, words: [...event.words] }
    : event);
}

/** Converts the existing controller-lane display value back to a 32-bit UMP value. */
export function pianoRollUmpValueFromDisplayValue(
  lane: PianoRollBottomLane,
  displayValue: number,
): number | null {
  if (!Number.isFinite(displayValue) || !isPianoRollUmpControllerLane(lane)) return null;
  if (lane === "umpPitchBend") {
    const clamped = Math.max(-8192, Math.min(8191, displayValue));
    return Math.max(0, Math.min(UINT32_MAX,
      Math.round(0x8000_0000 + clamped / 16_384 * 0x1_0000_0000)));
  }
  const controller = Number(lane.slice(5));
  if (!Number.isInteger(controller) || controller < 0 || controller > 127
      || RESERVED_COMPOUND_CC.has(controller)) return null;
  const clamped = Math.max(0, Math.min(127, displayValue));
  return Math.round(clamped / 127 * UINT32_MAX);
}

/** Maps a controller-lane vertical coordinate directly to the full UMP word. */
export function pianoRollUmpValueFromY(
  y: number,
  gridBottom: number,
  height: number,
): number {
  const top = gridBottom + 18;
  const bottom = height - 6;
  const normalized = Math.max(0, Math.min(1, (bottom - y) / Math.max(1, bottom - top)));
  return Math.round(normalized * UINT32_MAX);
}

/** Changes only beat and word 1 for valid source packets; every other word survives. */
export function editPianoRollUmpControllerPoints(
  source: MidiUmpEventRow[],
  edits: PianoRollUmpControllerPointEdit[],
): MidiUmpEventRow[] | null {
  if (source.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS || edits.length === 0) return null;
  const seen = new Set<number>();
  const next = source.slice();
  for (const edit of edits) {
    if (!Number.isInteger(edit.sourceIndex) || edit.sourceIndex < 0
        || edit.sourceIndex >= source.length || seen.has(edit.sourceIndex)
        || !Number.isFinite(edit.beat) || edit.beat < 0
        || !isUint32(edit.value)) return null;
    const original = source[edit.sourceIndex];
    if (!original || !decodeKind(original)) return null;
    if (edit.beat > MAX_SOURCE_BEAT && edit.beat !== original.beat) return null;
    seen.add(edit.sourceIndex);
    const words = [...original.words];
    words[1] = edit.value >>> 0;
    next[edit.sourceIndex] = { ...original, beat: edit.beat, words };
  }
  return next;
}

/** Creates a standard CC/Pitch Bend packet without touching existing UMP data. */
export function createPianoRollUmpControllerEvent(
  source: MidiUmpEventRow[],
  lane: PianoRollBottomLane,
  beat: number,
  value: number,
  group: number,
  channel: number,
): MidiUmpEventRow[] | null {
  if (source.length >= MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS
      || !Number.isFinite(beat) || beat < 0 || beat > MAX_SOURCE_BEAT
      || !isUint32(value) || !Number.isInteger(group) || group < 0 || group > 15
      || !Number.isInteger(channel) || channel < 0 || channel > 15
      || !isPianoRollUmpControllerLane(lane)) return null;
  const pitchBend = lane === "umpPitchBend";
  const controller = pitchBend ? 0 : Number(lane.slice(5));
  if (!Number.isInteger(controller) || controller < 0 || controller > 127
      || (!pitchBend && RESERVED_COMPOUND_CC.has(controller))) return null;
  const status = pitchBend ? MIDI2_PITCH_BEND_STATUS : MIDI2_CC_STATUS;
  const header = ((MIDI2_MESSAGE_TYPE << 28) | (group << 24) | (status << 20)
    | (channel << 16) | (controller << 8)) >>> 0;
  return [...source, { beat, words: [header, value >>> 0], wordCount: 2 }];
}

/** Deletes recognized controller packets only; opaque UMP entries are retained. */
export function removePianoRollUmpControllerEvents(
  source: MidiUmpEventRow[],
  sourceIndices: number[],
): MidiUmpEventRow[] | null {
  if (source.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS || sourceIndices.length === 0)
    return null;
  const removals = new Set<number>();
  for (const index of sourceIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= source.length
        || removals.has(index) || !decodeKind(source[index])) return null;
    removals.add(index);
  }
  return source.filter((_event, index) => !removals.has(index));
}

export function createPianoRollUmpControllerDraftRow(
  id: string,
  kind: PianoRollUmpControllerKind,
  beat: number,
  defaults: { group?: number; channel?: number } = {},
): PianoRollUmpControllerDraftRow {
  return {
    id,
    sourceIndex: null,
    kind,
    beat: Math.max(0, beat),
    group: defaults.group ?? 0,
    channel: defaults.channel ?? 0,
    controller: kind === "cc" ? 1 : 0,
    value: kind === "pitchBend" ? 0x8000_0000 : 0,
  };
}
