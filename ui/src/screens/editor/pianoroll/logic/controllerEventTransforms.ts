/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiClipEventRow } from "@/lib/state/types";
import { evaluateEditorCurve } from "@/screens/editor/logic/curveShape";
import {
  createControllerEvent,
  MAX_EDITABLE_CONTROLLER_EVENTS,
} from "@/screens/editor/pianoroll/logic/controllerLane";
import type { PianoRollBottomLane } from "@/screens/editor/pianoroll/logic/types";

const MAX_CONTROLLER_EVENT_SELECTION = MAX_EDITABLE_CONTROLLER_EVENTS;
const EVENT_BEAT_EPSILON = 1e-6;

export interface PianoRollControllerEventTransformAvailability {
  curve: boolean;
  smooth: boolean;
}

interface SelectedControllerEvent {
  index: number;
  event: MidiClipEventRow;
  value: number;
}

function controllerEventValue(
  event: MidiClipEventRow,
  lane: PianoRollBottomLane,
): number | null {
  if (event.data.length < 2) return null;
  if (lane === "pitchBend") {
    if ((event.status & 0xf0) !== 0xe0
        || !Number.isFinite(event.data[0]) || !Number.isFinite(event.data[1]))
      return null;
    const lsb = Math.max(0, Math.min(127, Math.trunc(event.data[0])));
    const msb = Math.max(0, Math.min(127, Math.trunc(event.data[1])));
    return (msb << 7) + lsb - 8192;
  }
  const controller = Number(lane.slice(2));
  if (!lane.startsWith("cc") || !Number.isInteger(controller)
      || controller < 0 || controller > 127
      || (event.status & 0xf0) !== 0xb0 || event.data[0] !== controller
      || !Number.isFinite(event.data[1]))
    return null;
  return Math.max(0, Math.min(127, Math.trunc(event.data[1])));
}

function collectSelectedControllerGroups(
  events: MidiClipEventRow[],
  sourceEventIndices: number[],
  lane: PianoRollBottomLane,
): SelectedControllerEvent[][] | null {
  if (events.length > MAX_EDITABLE_CONTROLLER_EVENTS
      || sourceEventIndices.length < 3
      || sourceEventIndices.length > MAX_CONTROLLER_EVENT_SELECTION)
    return null;
  if (lane !== "pitchBend") {
    const controller = Number(lane.slice(2));
    if (!lane.startsWith("cc") || !Number.isInteger(controller)
        || controller < 0 || controller > 127
        || (controller >= 64 && controller <= 69))
      return null;
  }

  const uniqueIndices = new Set(sourceEventIndices);
  if (uniqueIndices.size !== sourceEventIndices.length) return null;
  const byChannel = new Map<number, SelectedControllerEvent[]>();
  for (const index of uniqueIndices) {
    const event = events[index];
    if (!Number.isInteger(index) || index < 0 || index >= events.length
        || !event || !Number.isFinite(event.beat) || event.beat < 0)
      return null;
    const value = controllerEventValue(event, lane);
    if (value === null) return null;
    const channel = event.status & 0x0f;
    const group = byChannel.get(channel) ?? [];
    group.push({ index, event, value });
    byChannel.set(channel, group);
  }
  return [...byChannel.values()].map((group) => group.sort(
    (left, right) => left.event.beat - right.event.beat || left.index - right.index,
  ));
}

function hasTransformableControllerGroup(groups: SelectedControllerEvent[][]): boolean {
  return groups.some((group) => group.length >= 3
    && group[group.length - 1].event.beat - group[0].event.beat > EVENT_BEAT_EPSILON);
}

/** Report whether selected events can produce a meaningful value transform. */
export function controllerEventTransformAvailability(
  events: MidiClipEventRow[],
  sourceEventIndices: number[],
  lane: PianoRollBottomLane,
): PianoRollControllerEventTransformAvailability {
  const groups = collectSelectedControllerGroups(events, sourceEventIndices, lane);
  const available = Boolean(groups && hasTransformableControllerGroup(groups));
  return { curve: available, smooth: available };
}

function setControllerEventValue(
  event: MidiClipEventRow,
  lane: PianoRollBottomLane,
  value: number,
): MidiClipEventRow | null {
  const replacement = createControllerEvent(
    lane,
    event.beat,
    value,
    event.status & 0x0f,
  );
  if (!replacement) return null;
  replacement.data = [...replacement.data, ...event.data.slice(replacement.data.length)];
  return replacement;
}

/** Shape selected controller values over existing times, independently per channel. */
export function shapeControllerEventSelection(
  events: MidiClipEventRow[],
  sourceEventIndices: number[],
  lane: PianoRollBottomLane,
  curve: number,
): MidiClipEventRow[] | null {
  if (!Number.isFinite(curve) || curve < -1 || curve > 1) return null;
  const groups = collectSelectedControllerGroups(events, sourceEventIndices, lane);
  if (!groups || !hasTransformableControllerGroup(groups)) return null;

  const updated = [...events];
  let changed = false;
  for (const group of groups) {
    if (group.length < 3) continue;
    const first = group[0];
    const last = group[group.length - 1];
    const span = last.event.beat - first.event.beat;
    if (span <= EVENT_BEAT_EPSILON) continue;
    for (let index = 1; index < group.length - 1; index += 1) {
      const selected = group[index];
      const position = (selected.event.beat - first.event.beat) / span;
      const value = first.value + (last.value - first.value)
        * evaluateEditorCurve(position, curve);
      const replacement = setControllerEventValue(selected.event, lane, value);
      if (!replacement) return null;
      if (replacement.data.some((byte, byteIndex) => byte !== selected.event.data[byteIndex])) {
        updated[selected.index] = replacement;
        changed = true;
      }
    }
  }
  return changed ? updated : null;
}

/** Smooth selected controller values with two time-weighted passes and fixed endpoints. */
export function smoothControllerEventSelection(
  events: MidiClipEventRow[],
  sourceEventIndices: number[],
  lane: PianoRollBottomLane,
): MidiClipEventRow[] | null {
  const groups = collectSelectedControllerGroups(events, sourceEventIndices, lane);
  if (!groups || !hasTransformableControllerGroup(groups)) return null;

  const valuesByIndex = new Map<number, number>();
  for (const group of groups) {
    if (group.length < 3) continue;
    let values = group.map((item) => item.value);
    for (let pass = 0; pass < 2; pass += 1) {
      const previous = values;
      values = previous.map((value, index) => {
        if (index === 0 || index === previous.length - 1) return value;
        const before = group[index - 1];
        const current = group[index];
        const after = group[index + 1];
        const timeSpan = after.event.beat - before.event.beat;
        if (timeSpan <= EVENT_BEAT_EPSILON) return value;
        const fraction = (current.event.beat - before.event.beat) / timeSpan;
        const neighborValue = previous[index - 1]
          + fraction * (previous[index + 1] - previous[index - 1]);
        return (value + neighborValue) * 0.5;
      });
    }
    group.forEach((item, index) => valuesByIndex.set(item.index, values[index]));
  }

  const updated = [...events];
  let changed = false;
  for (const [index, value] of valuesByIndex) {
    const original = events[index];
    const replacement = setControllerEventValue(original, lane, value);
    if (!replacement) return null;
    if (replacement.data.some((byte, byteIndex) => byte !== original.data[byteIndex])) {
      updated[index] = replacement;
      changed = true;
    }
  }
  return changed ? updated : null;
}
