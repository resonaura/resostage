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

const MAX_SOURCE_EVENTS = 16_384;
const MAX_PROJECTED_EVENTS = 12_000;
const MAX_LOOP_PASSES = 1_200;

export interface PianoRollPedalTransition {
  beat: number;
  down: boolean;
}

export interface PianoRollPedalSpan {
  startBeat: number;
  endBeat: number;
}

export interface PianoRollPedalProjection {
  transitions: PianoRollPedalTransition[];
  spans: PianoRollPedalSpan[];
  truncated: boolean;
}

interface MappedPedalEvent extends PianoRollPedalTransition {
  order: number;
  channel: number;
}

/**
 * Projects one switch-pedal CC into region-local transitions and held spans.
 * Work is bounded for imported MIDI files with huge event counts or tiny loops.
 */
export function buildPianoRollPedalProjection(
  region: MidiRegionRow,
  controller: number,
  minBeat: number,
  maxBeat: number,
): PianoRollPedalProjection {
  const result: PianoRollPedalProjection = {
    transitions: [],
    spans: [],
    truncated: false,
  };
  if (controller < 64 || controller > 69 || !Number.isFinite(minBeat)
      || !Number.isFinite(maxBeat) || maxBeat < 0 || region.durationBeats <= 0)
    return result;

  const source = region.events ?? [];
  const events = source.slice(0, MAX_SOURCE_EVENTS)
    .map((event, order) => ({ event, order }))
    .filter(({ event }) => (event.status & 0xf0) === 0xb0
      && event.data[0] === controller && event.data.length > 1)
    .sort((left, right) => left.event.beat - right.event.beat || left.order - right.order);
  result.truncated = source.length > MAX_SOURCE_EVENTS;

  const repeatLength = region.loop && region.loopLengthBeats > 0
    ? region.loopLengthBeats
    : 0;
  const groups: MappedPedalEvent[][] = [];
  if (repeatLength > 0) {
    const loopEvents = events.filter(({ event }) =>
      midiRegionContainsLoopSourceBeat(region, event.beat));
    const firstRepeat = Math.max(0, Math.floor(Math.max(0, minBeat) / repeatLength) - 1);
    const lastRepeat = Math.min(
      Math.ceil(region.durationBeats / repeatLength),
      Math.ceil(Math.max(0, maxBeat) / repeatLength),
    );
    const passCount = Math.max(0, lastRepeat - firstRepeat + 1);
    if (passCount > MAX_LOOP_PASSES) result.truncated = true;

    let projectedCount = 0;
    for (let repeat = firstRepeat;
         repeat <= lastRepeat && repeat - firstRepeat < MAX_LOOP_PASSES;
         repeat += 1) {
      const group: MappedPedalEvent[] = [];
      for (const { event, order } of loopEvents) {
        if (projectedCount >= MAX_PROJECTED_EVENTS) {
          result.truncated = true;
          break;
        }
        projectedCount += 1;
        const beat = midiRegionLoopOccurrence(region, event.beat) + repeat * repeatLength;
        if (beat >= 0 && beat < region.durationBeats) {
          group.push({
            beat,
            down: event.data[1] > 0,
            order,
            channel: event.status & 0x0f,
          });
        }
      }
      if (group.length > 0) groups.push(group);
      if (projectedCount >= MAX_PROJECTED_EVENTS) {
        if (repeat < lastRepeat) result.truncated = true;
        break;
      }
    }
  } else {
    const group = events.slice(0, MAX_PROJECTED_EVENTS).map(({ event, order }) => ({
      beat: event.beat - region.clipOffsetBeats,
      down: event.data[1] > 0,
      order,
      channel: event.status & 0x0f,
    })).filter((event) => event.beat < region.durationBeats);
    if (events.length > MAX_PROJECTED_EVENTS) result.truncated = true;
    if (group.length > 0) groups.push(group);
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    group.sort((left, right) => left.beat - right.beat || left.order - right.order);
    const downChannels = new Set<number>();
    let down = false;
    let startBeat = 0;
    for (const event of group) {
      const wasDown = downChannels.size > 0;
      if (event.down) downChannels.add(event.channel);
      else downChannels.delete(event.channel);
      const isDown = downChannels.size > 0;
      if (isDown === wasDown) continue;
      result.transitions.push({ beat: event.beat, down: event.down });
      if (isDown) {
        startBeat = event.beat;
      } else if (event.beat > startBeat) {
        result.spans.push({ startBeat, endBeat: event.beat });
      }
      down = isDown;
    }

    if (down) {
      const repeatEnd = repeatLength > 0
        ? Math.min(region.durationBeats, (Math.floor(group[0].beat / repeatLength) + 1) * repeatLength)
        : region.durationBeats;
      if (repeatEnd > startBeat) result.spans.push({ startBeat, endBeat: repeatEnd });
    }
  }

  return result;
}
