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

const MAX_SOURCE_EVENTS_SCANNED = 65_536;
const MAX_EXPANDED_EVENTS = 10_000;
const SWITCH_PEDAL_NAMES: Readonly<Record<number, string>> = {
  64: "Sustain",
  65: "Portamento",
  66: "Sostenuto",
  67: "Soft pedal",
  68: "Legato",
  69: "Hold 2",
};

export interface MidiControllerPreviewEvent {
  beat: number;
  channel: number;
  controller: number;
  value: number;
  order: number;
}

export interface MidiPedalInterval {
  start: number;
  end: number;
  channel: number;
  controller: number;
}

export interface MidiControllerPreview {
  events: MidiControllerPreviewEvent[];
  pedals: MidiPedalInterval[];
  truncated: boolean;
}

export interface MidiControllerMarkerBin {
  beat: number;
  eventCount: number;
  minValue: number;
  maxValue: number;
  controllers: number[];
  channels: number[];
}

export function midiControllerName(controller: number): string | null {
  return SWITCH_PEDAL_NAMES[controller] ?? null;
}

export function midiControllerLabel(controller: number): string {
  const name = midiControllerName(controller);
  return name ? `CC ${controller} · ${name}` : `CC ${controller}`;
}

/**
 * Expand persisted CC messages into the region's visible timeline coordinates.
 * The scan and loop expansion are explicitly bounded; source project data is
 * never modified when the visual preview reaches its display budget.
 */
export function buildMidiControllerPreview(
  sourceRegion: MidiRegionRow,
  durationBeats: number,
): MidiControllerPreview {
  const events: MidiControllerPreviewEvent[] = [];
  const sourceEvents = sourceRegion.events ?? [];
  const scanLimit = Math.min(sourceEvents.length, MAX_SOURCE_EVENTS_SCANNED);
  const visibleDuration = Number.isFinite(durationBeats)
    ? Math.max(0, durationBeats)
    : 0;
  const sourceLoopLength = sourceRegion.loopLengthBeats;
  const loopLength = Number.isFinite(sourceLoopLength) && sourceLoopLength > 0
    ? Math.max(0.03125, sourceLoopLength)
    : Math.max(0.03125, visibleDuration);
  const clipOffsetBeats = Number.isFinite(sourceRegion.clipOffsetBeats)
    ? sourceRegion.clipOffsetBeats
    : 0;
  const lastIteration = sourceRegion.loop
    ? Math.ceil(visibleDuration / loopLength)
    : 0;
  let truncated = sourceEvents.length > scanLimit;

  for (let sourceIndex = 0; sourceIndex < scanLimit; sourceIndex++) {
    const event = sourceEvents[sourceIndex];
    if (
      !Number.isInteger(event.status) || event.status < 0x80 || event.status > 0xff ||
      (event.status & 0xf0) !== 0xb0 || !Array.isArray(event.data) || event.data.length < 2 ||
      !Number.isFinite(event.beat) || !Number.isFinite(event.data[0]) ||
      !Number.isFinite(event.data[1])
    ) continue;
    if (sourceRegion.loop && !midiRegionContainsLoopSourceBeat(sourceRegion, event.beat)) continue;

    const firstBeat = sourceRegion.loop
      ? midiRegionLoopOccurrence(sourceRegion, event.beat)
      : event.beat - clipOffsetBeats;
    for (let iteration = 0; iteration <= lastIteration; iteration++) {
      const beat = firstBeat + iteration * (sourceRegion.loop ? loopLength : 0);
      if (beat >= visibleDuration) continue;
      if (events.length >= MAX_EXPANDED_EVENTS) {
        truncated = true;
        break;
      }
      events.push({
        beat,
        channel: event.status & 0x0f,
        controller: Math.max(0, Math.min(127, Math.trunc(event.data[0]))),
        value: Math.max(0, Math.min(127, Math.trunc(event.data[1]))),
        order: sourceIndex,
      });
    }
  }

  events.sort((left, right) => left.beat - right.beat || left.order - right.order);
  return {
    events,
    // A missing release could be beyond the scan budget; never show a held
    // span inferred from a deliberately incomplete event sequence.
    pedals: truncated ? [] : buildMidiPedalIntervals(events, visibleDuration),
    truncated,
  };
}

/**
 * Collapse event detail into at most one marker per horizontal pixel bin.
 * This keeps a dense region inexpensive to paint while preserving controller,
 * channel, and value ranges in the marker's accessible tooltip.
 */
export function buildMidiControllerMarkerBins(
  events: readonly MidiControllerPreviewEvent[],
  durationBeats: number,
  requestedBinCount: number,
): MidiControllerMarkerBin[] {
  if (!(durationBeats > 0) || !Number.isFinite(durationBeats)) return [];
  const binCount = Math.max(1, Math.min(1200, Math.trunc(requestedBinCount) || 1));
  const bins = new Map<number, MidiControllerMarkerBin>();
  for (const event of events) {
    if (!Number.isFinite(event.beat) || event.beat < 0 || event.beat > durationBeats) continue;
    const index = Math.min(binCount - 1, Math.floor((event.beat / durationBeats) * binCount));
    const bin = bins.get(index);
    if (bin) {
      bin.eventCount += 1;
      bin.minValue = Math.min(bin.minValue, event.value);
      bin.maxValue = Math.max(bin.maxValue, event.value);
      if (!bin.controllers.includes(event.controller) && bin.controllers.length < 8)
        bin.controllers.push(event.controller);
      if (!bin.channels.includes(event.channel) && bin.channels.length < 8)
        bin.channels.push(event.channel);
    } else {
      bins.set(index, {
        beat: Math.max(0, Math.min(durationBeats, (index / binCount) * durationBeats)),
        eventCount: 1,
        minValue: event.value,
        maxValue: event.value,
        controllers: [event.controller],
        channels: [event.channel],
      });
    }
  }
  return [...bins.values()];
}

/** Build held spans only for the standardized switch-pedal CCs (64–69). */
export function buildMidiPedalIntervals(
  events: readonly MidiControllerPreviewEvent[],
  durationBeats: number,
): MidiPedalInterval[] {
  const visibleDuration = Number.isFinite(durationBeats)
    ? Math.max(0, durationBeats)
    : 0;
  const byControl = new Map<string, MidiControllerPreviewEvent[]>();
  for (const event of events) {
    if (!midiControllerName(event.controller)) continue;
    const key = `${event.channel}:${event.controller}`;
    const list = byControl.get(key);
    if (list) list.push(event);
    else byControl.set(key, [event]);
  }

  const intervals: MidiPedalInterval[] = [];
  for (const group of byControl.values()) {
    group.sort((left, right) => left.beat - right.beat || left.order - right.order);
    const first = group[0];
    let down = false;
    let start = 0;
    for (const event of group) {
      // MIDI switch controllers use zero for off and any non-zero value for on.
      const nextDown = event.value > 0;
      if (nextDown === down) continue;
      if (nextDown) {
        start = Math.max(0, event.beat);
        down = true;
      } else {
        const end = Math.min(visibleDuration, event.beat);
        if (down && end > start) {
          intervals.push({ start, end, channel: first.channel, controller: first.controller });
        }
        down = false;
      }
    }
    if (down && visibleDuration > start) {
      intervals.push({ start, end: visibleDuration, channel: first.channel, controller: first.controller });
    }
  }
  return intervals;
}
