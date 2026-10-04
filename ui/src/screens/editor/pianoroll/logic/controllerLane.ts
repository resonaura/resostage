/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiRegionRow } from "@/lib/state/types";
import {
  midiRegionContainsLoopSourceBeat,
  midiRegionLoopOccurrence,
} from "@/lib/midi/midiRegionTiming";
import type { PianoRollBottomLane } from "@/screens/editor/pianoroll/logic/types";

const MAX_SOURCE_EVENTS = 16_384;
const MAX_PROJECTED_EVENTS = 12_000;
const MAX_LOOP_PASSES = 1_200;

export interface PianoRollControllerValueEvent {
  beat: number;
  value: number;
  channel: number;
}

export interface PianoRollControllerProjection {
  events: PianoRollControllerValueEvent[];
  truncated: boolean;
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
  const sourceEvents = source.slice(0, MAX_SOURCE_EVENTS);
  result.truncated = source.length > sourceEvents.length;
  const selected: SelectedEvent[] = [];
  for (let order = 0; order < sourceEvents.length; order += 1) {
    const event = sourceEvents[order];
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
    result.events.push({ beat, value: event.value, channel: event.channel });
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
