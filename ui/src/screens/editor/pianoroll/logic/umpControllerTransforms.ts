/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiUmpEventRow } from "@/lib/state/types";
import { evaluateEditorCurve } from "@/screens/editor/logic/curveShape";
import {
  decodePianoRollUmpControllerPoint,
  MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS,
} from "@/screens/editor/pianoroll/logic/umpControllerLane";
import {
  editPianoRollUmpControllerPoints,
} from "@/screens/editor/pianoroll/logic/umpControllerEditing";
import type { PianoRollBottomLane } from "@/screens/editor/pianoroll/logic/types";

const MAX_SELECTION = MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS;
const BEAT_EPSILON = 1e-6;
const UINT32_MAX = 0xffff_ffff;

export interface PianoRollUmpControllerTransformAvailability {
  curve: boolean;
  smooth: boolean;
}

interface SelectedPoint {
  sourceIndex: number;
  beat: number;
  value: number;
}

function isSwitchControllerLane(lane: PianoRollBottomLane): boolean {
  if (!lane.startsWith("umpCc")) return false;
  const controller = Number(lane.slice(5));
  return controller >= 64 && controller <= 69;
}

function collectGroups(
  events: MidiUmpEventRow[],
  sourceIndices: number[],
  lane: PianoRollBottomLane,
  groupFilter: number | null,
  channelFilter: number | null,
): SelectedPoint[][] | null {
  if (events.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS
      || sourceIndices.length < 3 || sourceIndices.length > MAX_SELECTION
      || isSwitchControllerLane(lane)) return null;

  const uniqueIndices = new Set(sourceIndices);
  if (uniqueIndices.size !== sourceIndices.length) return null;
  const byGroupChannel = new Map<number, SelectedPoint[]>();
  for (const sourceIndex of uniqueIndices) {
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= events.length)
      return null;
    const event = events[sourceIndex];
    if (!event) return null;
    const decoded = decodePianoRollUmpControllerPoint(event, sourceIndex, lane);
    if (!decoded || (groupFilter !== null && decoded.group !== groupFilter)
        || (channelFilter !== null && decoded.channel !== channelFilter)) return null;
    const key = (decoded.group << 4) | decoded.channel;
    const points = byGroupChannel.get(key) ?? [];
    points.push({
      sourceIndex,
      beat: decoded.beat,
      value: decoded.rawValue,
    });
    byGroupChannel.set(key, points);
  }

  return [...byGroupChannel.values()].map((points) => points.sort(
    (left, right) => left.beat - right.beat || left.sourceIndex - right.sourceIndex,
  ));
}

function hasTransformableGroup(groups: SelectedPoint[][]): boolean {
  return groups.some((points) => points.length >= 3
    && points[points.length - 1].beat - points[0].beat > BEAT_EPSILON);
}

/** Report whether a selection contains a continuous, transformable UMP lane. */
export function umpControllerTransformAvailability(
  events: MidiUmpEventRow[],
  sourceIndices: number[],
  lane: PianoRollBottomLane,
  groupFilter: number | null = null,
  channelFilter: number | null = null,
): PianoRollUmpControllerTransformAvailability {
  const groups = collectGroups(events, sourceIndices, lane, groupFilter, channelFilter);
  const available = Boolean(groups && hasTransformableGroup(groups));
  return { curve: available, smooth: available };
}

/** Shape selected full-resolution values over their existing times, per group/channel. */
export function shapeUmpControllerSelection(
  events: MidiUmpEventRow[],
  sourceIndices: number[],
  lane: PianoRollBottomLane,
  curve: number,
  groupFilter: number | null = null,
  channelFilter: number | null = null,
): MidiUmpEventRow[] | null {
  if (!Number.isFinite(curve) || curve < -1 || curve > 1) return null;
  const groups = collectGroups(events, sourceIndices, lane, groupFilter, channelFilter);
  if (!groups || !hasTransformableGroup(groups)) return null;

  const edits: Array<{ sourceIndex: number; beat: number; value: number }> = [];
  for (const points of groups) {
    if (points.length < 3) continue;
    const first = points[0];
    const last = points[points.length - 1];
    const span = last.beat - first.beat;
    if (span <= BEAT_EPSILON) continue;
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index];
      const position = (point.beat - first.beat) / span;
      const value = Math.max(0, Math.min(UINT32_MAX, Math.round(
        first.value + (last.value - first.value) * evaluateEditorCurve(position, curve),
      )));
      if (value !== point.value)
        edits.push({ sourceIndex: point.sourceIndex, beat: point.beat, value });
    }
  }
  return edits.length > 0 ? editPianoRollUmpControllerPoints(events, edits) : null;
}

/** Smooth selected UMP values with two time-weighted passes and fixed endpoints. */
export function smoothUmpControllerSelection(
  events: MidiUmpEventRow[],
  sourceIndices: number[],
  lane: PianoRollBottomLane,
  groupFilter: number | null = null,
  channelFilter: number | null = null,
): MidiUmpEventRow[] | null {
  const groups = collectGroups(events, sourceIndices, lane, groupFilter, channelFilter);
  if (!groups || !hasTransformableGroup(groups)) return null;

  const edits: Array<{ sourceIndex: number; beat: number; value: number }> = [];
  for (const points of groups) {
    if (points.length < 3) continue;
    let values = points.map((point) => point.value);
    for (let pass = 0; pass < 2; pass += 1) {
      const previous = values;
      values = previous.map((value, index) => {
        if (index === 0 || index === previous.length - 1) return value;
        const before = points[index - 1];
        const current = points[index];
        const after = points[index + 1];
        const timeSpan = after.beat - before.beat;
        if (timeSpan <= BEAT_EPSILON) return value;
        const fraction = (current.beat - before.beat) / timeSpan;
        const neighborValue = previous[index - 1]
          + fraction * (previous[index + 1] - previous[index - 1]);
        return (value + neighborValue) * 0.5;
      });
    }
    points.forEach((point, index) => {
      if (index === 0 || index === points.length - 1) return;
      const value = Math.max(0, Math.min(UINT32_MAX, Math.round(values[index])));
      if (value !== point.value)
        edits.push({ sourceIndex: point.sourceIndex, beat: point.beat, value });
    });
  }
  return edits.length > 0 ? editPianoRollUmpControllerPoints(events, edits) : null;
}
