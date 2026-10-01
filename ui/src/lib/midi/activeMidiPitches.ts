// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import type { MidiRegionRow, WebUiState } from "@/lib/state/types";
import {
  midiRegionNotePlaybackDuration,
  midiRegionSourceBeat,
} from "@/lib/midi/midiRegionTiming";

function regionLocalBeat(region: MidiRegionRow, songBeat: number): number | null {
  if (
    region.muted ||
    songBeat < region.startBeats ||
    songBeat >= region.startBeats + region.durationBeats
  ) {
    return null;
  }

  return midiRegionSourceBeat(region, songBeat - region.startBeats);
}

/** MIDI pitches active at the current transport position, plus notes held by
 * the live MIDI record preview. When trackId is supplied every source is
 * scoped to that one actual/focused track. This is a view-only projection;
 * Core remains the clock and playback authority. */
export function getActiveMidiPitches(
  state: WebUiState,
  trackId?: string | null,
): Set<number> {
  const active = new Set<number>();
  for (const note of state.activeMidiNotes ?? []) {
    if (!trackId || note.trackId === trackId) active.add(note.pitch);
  }
  if (state.playing && state.bpm > 0 && state.songIndex >= 0) {
    const song = state.songs[state.songIndex];
    const songBeat = state.playheadSeconds * state.bpm / 60;
    for (const region of song?.midiRegions ?? []) {
      if (trackId && region.trackId !== trackId) continue;
      const localBeat = regionLocalBeat(region, songBeat);
      if (localBeat === null) continue;
      for (const note of region.notes) {
        const noteEnd = note.startBeats + midiRegionNotePlaybackDuration(
          region, note.startBeats, note.durationBeats,
        );
        if (!note.muted && localBeat >= note.startBeats && localBeat < noteEnd) {
          active.add(note.pitch);
        }
      }
    }
  }

  for (const recording of state.liveRecordings ?? []) {
    if (trackId && recording.trackId !== trackId) continue;
    for (const note of recording.midiNotes ?? []) {
      if (note.active) active.add(note.pitch);
    }
  }
  return active;
}

export function getRegionActivePitches(
  region: MidiRegionRow,
  companions: MidiRegionRow[],
  regionRelativePlayhead: number,
  isPlaying: boolean,
): Set<number> {
  const active = new Set<number>();
  if (!isPlaying) return active;
  const all = [region, ...companions];
  for (const candidate of all) {
    const regionOffset = candidate.startBeats - region.startBeats;
    const elapsedBeat = regionRelativePlayhead - regionOffset;
    if (elapsedBeat < 0 || elapsedBeat >= candidate.durationBeats || candidate.muted) continue;
    const localBeat = midiRegionSourceBeat(candidate, elapsedBeat);
    for (const note of candidate.notes) {
      const noteEnd = note.startBeats + midiRegionNotePlaybackDuration(
        candidate, note.startBeats, note.durationBeats,
      );
      if (!note.muted && localBeat >= note.startBeats && localBeat < noteEnd) {
        active.add(note.pitch);
      }
    }
  }
  return active;
}
