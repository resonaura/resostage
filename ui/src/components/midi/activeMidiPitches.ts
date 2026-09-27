import type { MidiRegionRow, WebUiState } from "../../lib/state/types";

function regionLocalBeat(region: MidiRegionRow, songBeat: number): number | null {
  if (
    region.muted ||
    songBeat < region.startBeats ||
    songBeat >= region.startBeats + region.durationBeats
  ) {
    return null;
  }

  const sourceBeat = songBeat - region.startBeats + region.clipOffsetBeats;
  if (region.loop && region.loopLengthBeats > 0) {
    return ((sourceBeat % region.loopLengthBeats) + region.loopLengthBeats) % region.loopLengthBeats;
  }
  return sourceBeat;
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
        if (!note.muted && localBeat >= note.startBeats && localBeat < note.startBeats + note.durationBeats) {
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
    const relativeBeat = regionRelativePlayhead - regionOffset + candidate.clipOffsetBeats;
    if (relativeBeat < 0 || relativeBeat >= candidate.durationBeats || candidate.muted) continue;
    const localBeat = candidate.loop && candidate.loopLengthBeats > 0
      ? ((relativeBeat % candidate.loopLengthBeats) + candidate.loopLengthBeats) % candidate.loopLengthBeats
      : relativeBeat;
    for (const note of candidate.notes) {
      if (!note.muted && localBeat >= note.startBeats && localBeat < note.startBeats + note.durationBeats) {
        active.add(note.pitch);
      }
    }
  }
  return active;
}
