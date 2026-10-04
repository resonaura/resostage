/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiRegionRow, MidiUmpEventRow } from "@/lib/state/types";
import {
  midiRegionContainsLoopSourceBeat,
  midiRegionLoopOccurrence,
} from "@/lib/midi/midiRegionTiming";
import { MAX_EDITABLE_CONTROLLER_EVENTS } from "@/screens/editor/pianoroll/logic/controllerLane";
import type { PianoRollBottomLane } from "@/screens/editor/pianoroll/logic/types";
import type { PianoRollControllerProjection } from "@/screens/editor/pianoroll/logic/controllerLane";

export const MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS = MAX_EDITABLE_CONTROLLER_EVENTS;
const MAX_PROJECTED_EVENTS = 12_000;
const MAX_LOOP_PASSES = 1_200;
const BEAT_EPSILON = 1e-6;
const MIDI2_CC_STATUS = 0x0b;
const MIDI2_PITCH_BEND_STATUS = 0x0e;

interface Midi2ControllerLaneDescriptor {
  kind: "cc" | "pitchBend";
  controller: number;
}

interface SelectedUmpControllerEvent {
  beat: number;
  value: number;
  group: number;
  channel: number;
  sourceEventIndex: number;
}

export interface PianoRollUmpControllerDimensions {
  groups: Set<number>;
  /** Channels present in the selected group, or all channels when groupFilter is null. */
  channels: Set<number>;
}

const MIDI2_CC_RESERVED_FOR_COMPOUND_MESSAGES = new Set([
  0, 6, 32, 38, 88, 98, 99, 100, 101,
]);

export function isPianoRollUmpControllerLane(
  lane: PianoRollBottomLane,
): boolean {
  return lane === "umpPitchBend" || /^umpCc(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(lane);
}

function describeLane(lane: PianoRollBottomLane): Midi2ControllerLaneDescriptor | null {
  if (lane === "umpPitchBend") return { kind: "pitchBend", controller: -1 };
  if (!lane.startsWith("umpCc")) return null;
  const controller = Number(lane.slice(5));
  if (!Number.isInteger(controller) || controller < 0 || controller > 127
      || MIDI2_CC_RESERVED_FOR_COMPOUND_MESSAGES.has(controller))
    return null;
  return { kind: "cc", controller };
}

function decodeEvent(
  event: MidiUmpEventRow,
  index: number,
  lane: Midi2ControllerLaneDescriptor,
): SelectedUmpControllerEvent | null {
  if (event.wordCount !== 2 || event.words.length < 2
      || !Number.isFinite(event.beat) || event.beat < 0)
    return null;
  const header = event.words[0];
  const value32 = event.words[1];
  if (!Number.isInteger(header) || header < 0 || header > 0xffff_ffff
      || !Number.isInteger(value32) || value32 < 0 || value32 > 0xffff_ffff
      || (header >>> 28) !== 0x4 || (header & 0xff) !== 0)
    return null;
  const status = (header >>> 20) & 0xf;
  const controller = (header >>> 8) & 0xff;
  if (lane.kind === "cc") {
    if (status !== MIDI2_CC_STATUS || controller !== lane.controller) return null;
  } else if (status !== MIDI2_PITCH_BEND_STATUS || controller !== 0) {
    return null;
  }

  const value = lane.kind === "cc"
    ? Math.round(value32 / 0xffff_ffff * 127)
    : Math.max(-8192, Math.min(8191, Math.round((value32 - 0x8000_0000) / 0x1_0000_0000 * 16384)));
  return {
    beat: event.beat,
    value,
    group: (header >>> 24) & 0xf,
    channel: (header >>> 16) & 0xf,
    sourceEventIndex: index,
  };
}

/** Discover bounded group/channel choices for one selected MIDI 2.0 lane. */
export function collectPianoRollUmpControllerDimensions(
  events: MidiUmpEventRow[],
  lane: PianoRollBottomLane,
  groupFilter: number | null = null,
): PianoRollUmpControllerDimensions {
  const dimensions: PianoRollUmpControllerDimensions = {
    groups: new Set(),
    channels: new Set(),
  };
  const descriptor = describeLane(lane);
  if (!descriptor) return dimensions;
  const count = Math.min(events.length, MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS);
  for (let index = 0; index < count; index += 1) {
    const event = events[index];
    if (!event) continue;
    const decoded = decodeEvent(event, index, descriptor);
    if (!decoded) continue;
    dimensions.groups.add(decoded.group);
    if (groupFilter === null || decoded.group === groupFilter)
      dimensions.channels.add(decoded.channel);
  }
  return dimensions;
}

/** Return only source indices visible in the selected, supported UMP lane. */
export function collectPianoRollUmpControllerSourceIndices(
  events: MidiUmpEventRow[],
  lane: PianoRollBottomLane,
  groupFilter: number | null = null,
  channelFilter: number | null = null,
): number[] {
  const descriptor = describeLane(lane);
  if (!descriptor) return [];
  const indices: number[] = [];
  const count = Math.min(events.length, MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS);
  for (let index = 0; index < count; index += 1) {
    const event = events[index];
    if (!event) continue;
    const decoded = decodeEvent(event, index, descriptor);
    if (!decoded || (groupFilter !== null && decoded.group !== groupFilter)
        || (channelFilter !== null && decoded.channel !== channelFilter)) continue;
    indices.push(index);
  }
  return indices;
}

/** Discover only standard MIDI 2.0 CCs with a defined MIDI 1.0 fallback. */
export function collectPianoRollUmpControllerNumbers(
  events: MidiUmpEventRow[],
): Set<number> {
  const controllerNumbers = new Set<number>();
  const eventCount = Math.min(events.length, MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS);
  for (let index = 0; index < eventCount; index += 1) {
    const event = events[index];
    if (!event || event.wordCount !== 2 || event.words.length < 2
        || !Number.isFinite(event.beat) || event.beat < 0
        || !Number.isInteger(event.words[1]) || event.words[1] < 0
        || event.words[1] > 0xffff_ffff)
      continue;
    const header = event.words[0];
    const controller = (header >>> 8) & 0xff;
    if (Number.isInteger(header) && header >= 0 && header <= 0xffff_ffff
        && (header >>> 28) === 0x4 && ((header >>> 20) & 0xf) === MIDI2_CC_STATUS
        && (header & 0xff) === 0
        && ((header >>> 8) & 0xff) <= 127
        && !MIDI2_CC_RESERVED_FOR_COMPOUND_MESSAGES.has(controller))
      controllerNumbers.add((header >>> 8) & 0xff);
  }
  return controllerNumbers;
}

export function hasPianoRollUmpPitchBend(events: MidiUmpEventRow[]): boolean {
  const eventCount = Math.min(events.length, MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS);
  for (let index = 0; index < eventCount; index += 1) {
    const event = events[index];
    if (!event || event.wordCount !== 2 || event.words.length < 2
        || !Number.isFinite(event.beat) || event.beat < 0
        || !Number.isInteger(event.words[0]) || event.words[0] < 0
        || event.words[0] > 0xffff_ffff
        || !Number.isInteger(event.words[1]) || event.words[1] < 0
        || event.words[1] > 0xffff_ffff)
      continue;
    const header = event.words[0];
    if ((header >>> 28) === 0x4 && ((header >>> 20) & 0xf) === MIDI2_PITCH_BEND_STATUS
        && ((header >>> 8) & 0xff) === 0 && (header & 0xff) === 0)
      return true;
  }
  return false;
}

/** Project recognized 32-bit MIDI 2.0 controls without changing opaque UMP data. */
export function buildPianoRollUmpControllerProjection(
  region: MidiRegionRow,
  lane: PianoRollBottomLane,
  minBeat: number,
  maxBeat: number,
  groupFilter: number | null = null,
  channelFilter: number | null = null,
): PianoRollControllerProjection {
  const result: PianoRollControllerProjection = { events: [], truncated: false };
  const descriptor = describeLane(lane);
  if (!descriptor || !Number.isFinite(minBeat) || !Number.isFinite(maxBeat)
      || maxBeat < minBeat || !Number.isFinite(region.durationBeats)
      || region.durationBeats <= 0 || !Number.isFinite(region.clipOffsetBeats))
    return result;

  const source = region.umpEvents ?? [];
  const sourceCount = Math.min(source.length, MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS);
  result.truncated = source.length > sourceCount;
  const selected: SelectedUmpControllerEvent[] = [];
  for (let index = 0; index < sourceCount; index += 1) {
    const decoded = decodeEvent(source[index], index, descriptor);
    if (decoded && (groupFilter === null || decoded.group === groupFilter)
        && (channelFilter === null || decoded.channel === channelFilter))
      selected.push(decoded);
  }

  const repeatLength = region.loop && region.loopLengthBeats > BEAT_EPSILON
    ? region.loopLengthBeats
    : 0;
  const append = (event: SelectedUmpControllerEvent, beat: number): boolean => {
    if (beat < Math.max(0, minBeat) || beat > maxBeat || beat >= region.durationBeats)
      return false;
    if (result.events.length >= MAX_PROJECTED_EVENTS) {
      result.truncated = true;
      return true;
    }
    result.events.push({
      beat,
      value: event.value,
      channel: event.channel,
      sourceEventIndex: event.sourceEventIndex,
    });
    return false;
  };

  if (repeatLength > 0) {
    const loopEvents = selected.filter((event) =>
      midiRegionContainsLoopSourceBeat(region, event.beat));
    const maxRepeat = Math.max(0, Math.ceil(region.durationBeats / repeatLength) - 1);
    const firstRepeat = Math.max(0, Math.floor(Math.max(0, minBeat) / repeatLength));
    const lastRepeat = Math.min(maxRepeat, Math.floor(Math.max(0, maxBeat) / repeatLength));
    if (lastRepeat - firstRepeat + 1 > MAX_LOOP_PASSES) result.truncated = true;
    const boundedLastRepeat = Math.min(lastRepeat, firstRepeat + MAX_LOOP_PASSES - 1);
    for (let repeat = firstRepeat; repeat <= boundedLastRepeat; repeat += 1) {
      for (const event of loopEvents) {
        const beat = midiRegionLoopOccurrence(region, event.beat) + repeat * repeatLength;
        if (append(event, beat)) return result;
      }
    }
  } else {
    for (const event of selected) {
      if (append(event, event.beat - region.clipOffsetBeats)) return result;
    }
  }
  result.events.sort((left, right) => left.beat - right.beat || left.channel - right.channel);
  return result;
}
