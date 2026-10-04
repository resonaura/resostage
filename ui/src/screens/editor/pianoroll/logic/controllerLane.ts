/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiClipEventRow, MidiRegionRow } from "@/lib/state/types";
import {
  midiRegionContainsLoopSourceBeat,
  midiRegionLoopOccurrence,
} from "@/lib/midi/midiRegionTiming";
import type { GridSnapValue, PianoRollBottomLane } from "@/screens/editor/pianoroll/logic/types";

const MAX_SOURCE_EVENTS = 16_384;
const MAX_PROJECTED_EVENTS = 12_000;
const MAX_LOOP_PASSES = 1_200;
export const MAX_EDITABLE_CONTROLLER_EVENTS = MAX_SOURCE_EVENTS;
export const MAX_CONTROLLER_PAINT_POINTS_PER_SEGMENT = 256;
export const MAX_CONTROLLER_PAINT_EVENTS_PER_GESTURE = 1_024;
const DISPLAY_BEAT_EPSILON = 1e-6;

export interface PianoRollControllerPaintPoint {
  beat: number;
  value: number;
}

export interface PianoRollControllerPaintResult {
  events: MidiClipEventRow[];
  sourceEventIndices: number[];
}

export interface PianoRollControllerPaintOptions {
  maxEventCount?: number;
  maxTouchedEventCount?: number;
  alreadyTouchedEventIndices?: ReadonlySet<number>;
  sourceEventIndexByBeat?: Map<number, number>;
}

/** Keep newly drawn events inside the region's half-open visible time range. */
export function clampControllerDisplayBeat(
  beat: number,
  durationBeats: number,
  snap: GridSnapValue,
): number {
  if (!Number.isFinite(beat) || !Number.isFinite(durationBeats) || durationBeats <= 0)
    return 0;
  const lastVisibleBeat = Math.max(0, durationBeats - DISPLAY_BEAT_EPSILON);
  if (snap <= 0) return Math.max(0, Math.min(lastVisibleBeat, beat));
  const lastGridBeat = Math.max(0, Math.floor(lastVisibleBeat / snap) * snap);
  return Math.max(0, Math.min(lastGridBeat, Math.round(beat / snap) * snap));
}

export interface PianoRollControllerValueEvent {
  beat: number;
  value: number;
  channel: number;
  /** Index in the source region event array, before loop projection. */
  sourceEventIndex: number;
}

export interface PianoRollControllerProjection {
  events: PianoRollControllerValueEvent[];
  truncated: boolean;
}

/** Collect visible CC lane IDs without cloning the bounded source prefix. */
export function collectPianoRollControllerNumbers(
  events: MidiClipEventRow[],
): Set<number> {
  const controllerNumbers = new Set<number>();
  const eventCount = Math.min(events.length, MAX_SOURCE_EVENTS);
  for (let index = 0; index < eventCount; index += 1) {
    const event = events[index];
    if ((event.status & 0xf0) === 0xb0 && event.data.length > 1)
      controllerNumbers.add(event.data[0]);
  }
  return controllerNumbers;
}

/** Return source-array identities for the active lane, or null when editing is over cap. */
export function collectControllerEventSourceIndices(
  events: MidiClipEventRow[],
  lane: PianoRollBottomLane,
): number[] | null {
  if (events.length > MAX_EDITABLE_CONTROLLER_EVENTS) return null;
  const pitchBend = lane === "pitchBend";
  const controller = pitchBend ? -1 : Number(lane.slice(2));
  if (!pitchBend && (!lane.startsWith("cc") || !Number.isInteger(controller)
      || controller < 0 || controller > 127))
    return [];
  const indices: number[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const command = event.status & 0xf0;
    if (pitchBend ? command === 0xe0
      : command === 0xb0 && event.data[0] === controller)
      indices.push(index);
  }
  return indices;
}

/** Remove a selected source-index set only when every member belongs to this lane. */
export function removeControllerEvents(
  events: MidiClipEventRow[],
  sourceEventIndices: number[],
  lane: PianoRollBottomLane,
): MidiClipEventRow[] | null {
  if (events.length > MAX_EDITABLE_CONTROLLER_EVENTS || sourceEventIndices.length === 0)
    return null;
  const pitchBend = lane === "pitchBend";
  const controller = pitchBend ? -1 : Number(lane.slice(2));
  if (!pitchBend && (!lane.startsWith("cc") || !Number.isInteger(controller)
      || controller < 0 || controller > 127))
    return null;
  const indices = new Set(sourceEventIndices);
  if (indices.size !== sourceEventIndices.length) return null;
  for (const index of indices) {
    const event = events[index];
    if (!Number.isInteger(index) || index < 0 || index >= events.length || !event)
      return null;
    if (pitchBend ? (event.status & 0xf0) !== 0xe0
      : (event.status & 0xf0) !== 0xb0 || event.data[0] !== controller)
      return null;
  }
  return events.filter((_, index) => !indices.has(index))
    .map((event) => ({ ...event, data: [...event.data] }));
}

/** Move one or more lane events as a rigid group, preserving their spacing and channels. */
export function moveControllerEvents(
  events: MidiClipEventRow[],
  sourceEventIndices: number[],
  lane: PianoRollBottomLane,
  region: MidiRegionRow,
  beatDelta: number,
  valueDelta: number,
): MidiClipEventRow[] | null {
  if (events.length > MAX_EDITABLE_CONTROLLER_EVENTS || sourceEventIndices.length === 0
      || !Number.isFinite(beatDelta) || !Number.isFinite(valueDelta)
      || !Number.isFinite(region.durationBeats) || region.durationBeats <= 0
      || !Number.isFinite(region.clipOffsetBeats)
      || !Number.isFinite(region.loopStartBeats ?? 0)
      || !Number.isFinite(region.loopLengthBeats)
      || (region.loop && region.loopLengthBeats <= 1e-9))
    return null;
  const indices = new Set(sourceEventIndices);
  if (indices.size !== sourceEventIndices.length) return null;

  const pitchBend = lane === "pitchBend";
  const controller = pitchBend ? -1 : Number(lane.slice(2));
  if (!pitchBend && (!lane.startsWith("cc") || !Number.isInteger(controller)
      || controller < 0 || controller > 127))
    return null;

  let minSourceBeat = Number.POSITIVE_INFINITY;
  let maxSourceBeat = Number.NEGATIVE_INFINITY;
  for (const index of indices) {
    const event = events[index];
    if (!Number.isInteger(index) || index < 0 || index >= events.length || !event
        || !Number.isFinite(event.beat))
      return null;
    if (pitchBend ? (event.status & 0xf0) !== 0xe0
      : (event.status & 0xf0) !== 0xb0 || event.data[0] !== controller)
      return null;
    minSourceBeat = Math.min(minSourceBeat, event.beat);
    maxSourceBeat = Math.max(maxSourceBeat, event.beat);
  }

  const looped = region.loop && region.loopLengthBeats > 1e-9;
  const windowStart = looped ? (region.loopStartBeats ?? 0) : region.clipOffsetBeats;
  const windowLength = looped ? region.loopLengthBeats : region.durationBeats;
  const windowEnd = windowStart + windowLength - DISPLAY_BEAT_EPSILON;
  const minDelta = windowStart - minSourceBeat;
  const maxDelta = windowEnd - maxSourceBeat;
  if (maxDelta < minDelta) return null;
  const boundedBeatDelta = Math.max(minDelta, Math.min(maxDelta, beatDelta));
  const updated = events.map((event) => ({ ...event, data: [...event.data] }));
  for (const index of indices) {
    const original = events[index];
    const value = pitchBend
      ? ((Math.max(0, Math.min(127, Math.trunc(original.data[1]))) << 7)
        + Math.max(0, Math.min(127, Math.trunc(original.data[0])))) - 8192
      : Math.max(0, Math.min(127, Math.trunc(original.data[1])));
    if (original.data.length < 2 || !Number.isFinite(value)) return null;
    const replacement = createControllerEvent(
      lane,
      original.beat + boundedBeatDelta,
      value + valueDelta,
      original.status & 0x0f,
    );
    if (!replacement) return null;
    replacement.data = [...replacement.data, ...original.data.slice(replacement.data.length)];
    updated[index] = replacement;
  }
  return updated;
}

/** Sample a bounded, grid-aligned line between two pointer samples. */
export function sampleControllerPaintSegment(
  startBeat: number,
  endBeat: number,
  startValue: number,
  endValue: number,
  snap: number,
): PianoRollControllerPaintPoint[] | null {
  if (![startBeat, endBeat, startValue, endValue, snap].every(Number.isFinite)
      || snap < 0)
    return null;
  const distance = Math.abs(endBeat - startBeat);
  if (distance <= DISPLAY_BEAT_EPSILON) {
    return startValue === endValue ? [] : [{ beat: endBeat, value: endValue }];
  }

  const minimumStep = snap > 0 ? snap : 0.125;
  const idealSteps = Math.max(1, Math.ceil(distance / minimumStep));
  const stride = minimumStep * Math.max(
    1,
    Math.ceil(idealSteps / MAX_CONTROLLER_PAINT_POINTS_PER_SEGMENT),
  );
  const direction = endBeat < startBeat ? -1 : 1;
  const steps = Math.floor((distance - DISPLAY_BEAT_EPSILON) / stride);
  const points: PianoRollControllerPaintPoint[] = [];
  for (let index = 1; index <= steps; index += 1) {
    const offset = Math.min(distance, index * stride);
    const fraction = offset / distance;
    points.push({
      beat: startBeat + direction * offset,
      value: startValue + (endValue - startValue) * fraction,
    });
  }
  points.push({ beat: endBeat, value: endValue });
  return points;
}

/** Build the per-gesture source index once, rather than scanning events per pointer move. */
export function indexControllerEventSourcesByBeat(
  events: MidiClipEventRow[],
  lane: PianoRollBottomLane,
  channel: number,
): Map<number, number> | null {
  if (events.length > MAX_EDITABLE_CONTROLLER_EVENTS
      || !Number.isInteger(channel) || channel < 0 || channel > 15)
    return null;
  const pitchBend = lane === "pitchBend";
  const controller = pitchBend ? -1 : Number(lane.slice(2));
  if (!pitchBend && (!lane.startsWith("cc") || !Number.isInteger(controller)
      || controller < 0 || controller > 127))
    return null;

  const sourceByBeat = new Map<number, number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const matchesLane = pitchBend
      ? (event.status & 0xf0) === 0xe0 && event.data.length >= 2
      : (event.status & 0xf0) === 0xb0 && event.data.length >= 2
        && event.data[0] === controller;
    if (matchesLane && (event.status & 0x0f) === channel && Number.isFinite(event.beat))
      sourceByBeat.set(Math.round(event.beat / DISPLAY_BEAT_EPSILON), index);
  }
  return sourceByBeat;
}

/** Upsert one bounded freehand segment without changing unrelated MIDI events. */
export function paintControllerEventPoints(
  events: MidiClipEventRow[],
  lane: PianoRollBottomLane,
  channel: number,
  points: PianoRollControllerPaintPoint[],
  options: PianoRollControllerPaintOptions = {},
): PianoRollControllerPaintResult | null {
  const maxEventCount = options.maxEventCount ?? MAX_EDITABLE_CONTROLLER_EVENTS;
  const maxTouchedEventCount = options.maxTouchedEventCount
    ?? MAX_CONTROLLER_PAINT_EVENTS_PER_GESTURE;
  if (events.length > MAX_EDITABLE_CONTROLLER_EVENTS || points.length === 0
      || points.length > MAX_CONTROLLER_PAINT_POINTS_PER_SEGMENT
      || !Number.isInteger(maxEventCount) || maxEventCount < events.length
      || maxEventCount > MAX_EDITABLE_CONTROLLER_EVENTS
      || !Number.isInteger(maxTouchedEventCount) || maxTouchedEventCount < 0
      || !Number.isInteger(channel) || channel < 0 || channel > 15)
    return null;

  const pitchBend = lane === "pitchBend";
  const controller = pitchBend ? -1 : Number(lane.slice(2));
  if (!pitchBend && (!lane.startsWith("cc") || !Number.isInteger(controller)
      || controller < 0 || controller > 127))
    return null;

  const sourceByBeat = options.sourceEventIndexByBeat
    ?? indexControllerEventSourcesByBeat(events, lane, channel);
  if (!sourceByBeat) return null;
  const touchedIndices = new Set(options.alreadyTouchedEventIndices ?? []);
  for (const index of touchedIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= events.length) return null;
  }

  const updated = [...events];
  const paintedIndices = new Set<number>();
  const stagedSourceByBeat = new Map<number, number>();
  for (const point of points) {
    if (!Number.isFinite(point.beat) || point.beat < 0 || !Number.isFinite(point.value))
      return null;
    const replacement = createControllerEvent(lane, point.beat, point.value, channel);
    if (!replacement) return null;
    const key = Math.round(point.beat / DISPLAY_BEAT_EPSILON);
    const existingIndex = stagedSourceByBeat.get(key) ?? sourceByBeat.get(key);
    if (existingIndex !== undefined) {
      if (!Number.isInteger(existingIndex) || existingIndex < 0
          || existingIndex >= updated.length)
        return null;
      const original = updated[existingIndex];
      const matchesSource = pitchBend
        ? (original.status & 0xf0) === 0xe0 && original.data.length >= 2
        : (original.status & 0xf0) === 0xb0 && original.data.length >= 2
          && original.data[0] === controller;
      if (!matchesSource || (original.status & 0x0f) !== channel
          || Math.abs(original.beat - point.beat) > DISPLAY_BEAT_EPSILON)
        return null;
      replacement.data = [...replacement.data, ...original.data.slice(replacement.data.length)];
      updated[existingIndex] = replacement;
      paintedIndices.add(existingIndex);
      touchedIndices.add(existingIndex);
      if (touchedIndices.size > maxTouchedEventCount) return null;
      continue;
    }
    if (updated.length >= maxEventCount) return null;
    const index = updated.length;
    updated.push(replacement);
    stagedSourceByBeat.set(key, index);
    paintedIndices.add(index);
    touchedIndices.add(index);
    if (touchedIndices.size > maxTouchedEventCount) return null;
  }

  for (const [key, index] of stagedSourceByBeat)
    sourceByBeat.set(key, index);

  return { events: updated, sourceEventIndices: [...paintedIndices] };
}

interface SelectedEvent {
  beat: number;
  value: number;
  channel: number;
  order: number;
}

/**
 * Projects raw MIDI CC or pitch-bend events into visible region time.
 * This is a read-only view of event data; automation lanes remain independent.
 * Input scanning, loop expansion, and output size are deliberately bounded.
 */
export function buildPianoRollControllerProjection(
  region: MidiRegionRow,
  lane: PianoRollBottomLane,
  minBeat: number,
  maxBeat: number,
): PianoRollControllerProjection {
  const result: PianoRollControllerProjection = { events: [], truncated: false };
  if (!Number.isFinite(minBeat) || !Number.isFinite(maxBeat) || maxBeat < minBeat
      || !Number.isFinite(region.durationBeats) || region.durationBeats <= 0
      || !Number.isFinite(region.clipOffsetBeats))
    return result;

  const pitchBend = lane === "pitchBend";
  const controller = pitchBend ? -1 : Number(lane.slice(2));
  if (!pitchBend && (!lane.startsWith("cc") || !Number.isInteger(controller)
      || controller < 0 || controller > 127))
    return result;

  const source = region.events ?? [];
  const sourceEventCount = Math.min(source.length, MAX_SOURCE_EVENTS);
  result.truncated = source.length > sourceEventCount;
  const selected: SelectedEvent[] = [];
  for (let order = 0; order < sourceEventCount; order += 1) {
    const event = source[order];
    if (!Number.isFinite(event.beat)) continue;
    const command = event.status & 0xf0;
    let value: number;
    if (pitchBend) {
      if (command !== 0xe0 || event.data.length < 2
          || !Number.isFinite(event.data[0]) || !Number.isFinite(event.data[1])) continue;
      const lsb = Math.max(0, Math.min(127, Math.trunc(event.data[0])));
      const msb = Math.max(0, Math.min(127, Math.trunc(event.data[1])));
      value = (msb << 7) + lsb - 8192;
    } else {
      if (command !== 0xb0 || event.data.length < 2 || event.data[0] !== controller)
        continue;
      if (!Number.isFinite(event.data[1])) continue;
      value = Math.max(0, Math.min(127, Math.trunc(event.data[1])));
    }
    selected.push({ beat: event.beat, value, channel: event.status & 0x0f, order });
  }

  const repeatLength = region.loop && region.loopLengthBeats > 1e-9
    ? region.loopLengthBeats
    : 0;
  const append = (event: SelectedEvent, beat: number) => {
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
      sourceEventIndex: event.order,
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
      const beat = event.beat - region.clipOffsetBeats;
      if (append(event, beat)) return result;
    }
  }

  result.events.sort((left, right) => left.beat - right.beat || left.channel - right.channel);
  return result;
}

/**
 * Creates one MIDI 1.0 channel event for a Piano Roll controller lane.
 * Pedal switches use the MIDI off/on convention; other CC values remain 7-bit.
 */
export function createControllerEvent(
  lane: PianoRollBottomLane,
  beat: number,
  value: number,
  channel = 0,
): MidiClipEventRow | null {
  if (!Number.isFinite(beat) || beat < 0 || !Number.isFinite(value) || !Number.isInteger(channel)
      || channel < 0 || channel > 15)
    return null;
  const pitchBend = lane === "pitchBend";
  const controller = pitchBend ? -1 : Number(lane.slice(2));
  if (!pitchBend && (!lane.startsWith("cc") || !Number.isInteger(controller)
      || controller < 0 || controller > 127))
    return null;

  if (pitchBend) {
    const bend = Math.max(-8192, Math.min(8191, Math.round(value)));
    const unsigned = bend + 8192;
    return {
      beat,
      status: 0xe0 | channel,
      data: [unsigned & 0x7f, (unsigned >> 7) & 0x7f],
    };
  }

  const isPedalSwitch = controller >= 64 && controller <= 69;
  const ccValue = isPedalSwitch ? (value >= 64 ? 127 : 0)
    : Math.max(0, Math.min(127, Math.round(value)));
  return { beat, status: 0xb0 | channel, data: [controller, ccValue] };
}

/** Reuse a lane's existing MIDI channel; new lanes default to channel one. */
export function defaultControllerChannel(
  events: MidiClipEventRow[],
  lane: PianoRollBottomLane,
): number {
  const pitchBend = lane === "pitchBend";
  const controller = pitchBend ? -1 : Number(lane.slice(2));
  const match = events.find((event) => pitchBend
    ? (event.status & 0xf0) === 0xe0
    : (event.status & 0xf0) === 0xb0 && event.data[0] === controller);
  return match ? match.status & 0x0f : 0;
}

/** Updates the position and value bytes of one source event without altering channel/order data. */
export function editControllerEvent(
  events: MidiClipEventRow[],
  sourceEventIndex: number,
  lane: PianoRollBottomLane,
  beat: number,
  value: number,
): MidiClipEventRow[] | null {
  if (!Number.isInteger(sourceEventIndex) || sourceEventIndex < 0
      || sourceEventIndex >= events.length || !Number.isFinite(beat) || beat < 0)
    return null;
  const original = events[sourceEventIndex];
  const pitchBend = lane === "pitchBend";
  const controller = pitchBend ? -1 : Number(lane.slice(2));
  const command = original.status & 0xf0;
  if (pitchBend ? command !== 0xe0
    : command !== 0xb0 || original.data[0] !== controller)
    return null;

  const replacement = createControllerEvent(
    lane,
    beat,
    value,
    original.status & 0x0f,
  );
  if (!replacement) return null;
  replacement.data = [...replacement.data, ...original.data.slice(replacement.data.length)];
  const updated = events.map((event) => ({ ...event, data: [...event.data] }));
  updated[sourceEventIndex] = replacement;
  return updated;
}

/** Removes one CC/pitch-bend event by stable source index, preserving all other MIDI bytes. */
export function removeControllerEvent(
  events: MidiClipEventRow[],
  sourceEventIndex: number,
  lane: PianoRollBottomLane,
): MidiClipEventRow[] | null {
  return removeControllerEvents(events, [sourceEventIndex], lane);
}

/** Compare complete event data independent of Core's stable beat sort. */
export function sameEditableMidiEvents(
  left: MidiClipEventRow[],
  right: MidiClipEventRow[],
): boolean {
  if (left.length !== right.length) return false;
  const order = (a: MidiClipEventRow, b: MidiClipEventRow) => {
    const beatOrder = a.beat - b.beat;
    if (beatOrder !== 0) return beatOrder;
    const statusOrder = a.status - b.status;
    if (statusOrder !== 0) return statusOrder;
    const lengthOrder = a.data.length - b.data.length;
    if (lengthOrder !== 0) return lengthOrder;
    for (let index = 0; index < a.data.length; index += 1) {
      const byteOrder = a.data[index] - b.data[index];
      if (byteOrder !== 0) return byteOrder;
    }
    return 0;
  };
  const sortedLeft = [...left].sort(order);
  const sortedRight = [...right].sort(order);
  return sortedLeft.every((event, index) => {
    const actual = sortedRight[index];
    return Math.abs(event.beat - actual.beat) < 1e-6
      && event.status === actual.status
      && event.data.length === actual.data.length
      && event.data.every((byte, byteIndex) => byte === actual.data[byteIndex]);
  });
}
