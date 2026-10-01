/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiNoteRow, MidiRegionRow } from "@/lib/state/types";
import {
  midiRegionContainsLoopSourceBeat,
  midiRegionLoopOccurrence,
  midiRegionNotePlaybackDuration,
} from "@/lib/midi/midiRegionTiming";
import { paintBrushNote } from "@/screens/editor/pianoroll/logic/pianoRollModel";

/** A marquee adds to the pointer-down selection only when Shift was held. */
export function marqueeSelection(
  hits: Iterable<number>,
  additiveSelection?: ReadonlySet<number>,
): Set<number> {
  const selected = new Set(additiveSelection);
  for (const id of hits) selected.add(id);
  return selected;
}

/**
 * Finds all note IDs whose visible bodies intersect the timeline beat / pitch box,
 * correctly evaluating occurrences across looped iterations.
 */
export function findNotesInMarquee(
  notes: readonly MidiNoteRow[],
  region: MidiRegionRow,
  minBeat: number,
  maxBeat: number,
  minPitch: number,
  maxPitch: number,
): number[] {
  const hitIds: number[] = [];
  const loopLength = region.loopLengthBeats;
  const isLooped = region.loop && loopLength > 0;
  const repeats = isLooped
    ? Math.max(1, Math.ceil(region.durationBeats / loopLength) + 1)
    : 1;

  for (const note of notes) {
    if (note.pitch < minPitch || note.pitch > maxPitch) continue;

    if (!isLooped) {
      const displayStart = note.startBeats - region.clipOffsetBeats;
      const displayEnd = displayStart + note.durationBeats;
      if (displayEnd >= minBeat && displayStart <= maxBeat) {
        hitIds.push(note.id);
      }
      continue;
    }

    if (!midiRegionContainsLoopSourceBeat(region, note.startBeats)) continue;
    const firstStart = midiRegionLoopOccurrence(region, note.startBeats);
    const duration = midiRegionNotePlaybackDuration(region, note.startBeats, note.durationBeats);

    const minRepeat = Math.max(0, Math.floor((minBeat - (firstStart + duration)) / loopLength));
    const maxRepeat = Math.min(repeats - 1, Math.floor((maxBeat - firstStart) / loopLength));

    for (let r = minRepeat; r <= maxRepeat; r++) {
      const displayStart = firstStart + r * loopLength;
      const displayEnd = displayStart + duration;
      if (displayStart < region.durationBeats && displayEnd >= minBeat && displayStart <= maxBeat) {
        hitIds.push(note.id);
        break;
      }
    }
  }

  return hitIds;
}

/**
 * Clamp one delta for a whole note group. Individual clamps flatten chords at
 * pitches 0/127 and collapse rhythms at beat zero; shared bounds preserve both.
 */
export function boundedNoteMove(
  notes: Iterable<MidiNoteRow>,
  deltaBeats: number,
  deltaPitch: number,
): { deltaBeats: number; deltaPitch: number } {
  let earliestBeat = Number.POSITIVE_INFINITY;
  let lowestPitch = 127;
  let highestPitch = 0;
  let count = 0;
  for (const note of notes) {
    earliestBeat = Math.min(earliestBeat, note.startBeats);
    lowestPitch = Math.min(lowestPitch, note.pitch);
    highestPitch = Math.max(highestPitch, note.pitch);
    count += 1;
  }
  if (count === 0) return { deltaBeats: 0, deltaPitch: 0 };
  const clampedBeats = Math.max(-earliestBeat, deltaBeats);
  const clampedPitch = Math.max(-lowestPitch, Math.min(127 - highestPitch, deltaPitch));
  return {
    deltaBeats: clampedBeats === 0 ? 0 : clampedBeats,
    deltaPitch: clampedPitch === 0 ? 0 : clampedPitch,
  };
}

/**
 * Clamp one resize delta for a whole note group based on the shortest note.
 * Preserves relative duration differences between notes in a selection,
 * ensuring no note shrinks below the minimum allowed duration (snap or 0.125).
 */
export function boundedNoteResize(
  notes: Iterable<MidiNoteRow>,
  deltaBeats: number,
  snap = 0,
): number {
  let shortestDuration = Number.POSITIVE_INFINITY;
  let count = 0;
  for (const note of notes) {
    shortestDuration = Math.min(shortestDuration, note.durationBeats);
    count += 1;
  }
  if (count === 0) return 0;
  const minDuration = snap > 0 ? snap : 0.125;
  const maxShrink = Math.max(0, shortestDuration - minDuration);
  const clampedDelta = Math.max(-maxShrink, deltaBeats);
  const snappedDelta =
    snap > 0 ? Math.round(clampedDelta / snap) * snap : clampedDelta;
  const boundedDelta = Math.max(-maxShrink, snappedDelta);
  return boundedDelta === 0 ? 0 : boundedDelta;
}

/**
 * Sweeps the snapped grid interval between two pointer events during a Brush gesture.
 * Prevents fast horizontal movements from skipping intervening cells, up to a bounded
 * maximum per event (default 64) to avoid accidental unbounded allocations.
 */
export function sweepBrushNotes(
  currentNotes: MidiNoteRow[],
  fromBeat: number,
  toBeat: number,
  pitch: number,
  stepDuration: number,
  maxNotes = 64,
  velocity = 0.8,
  idGen?: () => number,
): { updatedNotes: MidiNoteRow[]; addedNotes: MidiNoteRow[] } | null {
  const step = Math.max(0.0625, stepDuration);
  const minBeat = Math.min(fromBeat, toBeat);
  const maxBeat = Math.max(fromBeat, toBeat);

  const startIdx = Math.max(0, Math.round(minBeat / step));
  const endIdx = Math.max(startIdx, Math.round(maxBeat / step));
  const boundedEndIdx = Math.min(endIdx, startIdx + maxNotes - 1);

  let workingNotes = currentNotes;
  const addedNotes: MidiNoteRow[] = [];

  for (let idx = startIdx; idx <= boundedEndIdx; idx++) {
    const beat = idx * step;
    const result = paintBrushNote(workingNotes, beat, pitch, step, velocity, idGen);
    if (result) {
      workingNotes = result.updatedNotes;
      addedNotes.push(result.newNote);
    }
  }

  if (addedNotes.length === 0) return null;
  return { updatedNotes: workingNotes, addedNotes };
}

