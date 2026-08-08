import type { SongRow, TrackRow } from "../../lib/types";
import { getTrackColor } from "./constants";

// One row per unique track NAME across the whole project (tracks belong to
// individual songs in this schema, so "continuous" means aligning
// same-named tracks -- e.g. every song's "Drums" -- into one lane spanning
// all songs, Logic-Pro-style). Rows backed by a track in the *currently
// staged* song get full TrackHeaderControl (gain/pan/mute/solo); rows that
// only exist in other songs get a plain label -- there's no staged track
// index to drive mixer.set*() with for those.
export interface TimelineRow {
  name: string;
  color: string;
  headerIndex: number | null;
}

export function buildRows(
  currentTracks: TrackRow[],
  songs: SongRow[],
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const seen = new Set<string>();
  const trackIdToRowName = new Map<string, string>();
  currentTracks.forEach((t, i) => {
    const name = t.name || t.id;
    if (seen.has(name)) return;
    seen.add(name);
    trackIdToRowName.set(t.id, name);
    rows.push({
      name,
      color: getTrackColor(i),
      headerIndex: i,
    });
  });
  for (const s of songs) {
    for (const r of s.regions ?? []) {
      const name = trackIdToRowName.get(r.trackId) ?? r.trackId;
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({
        name,
        color: getTrackColor(rows.length),
        headerIndex: null,
      });
    }
  }
  return rows;
}

export function songDurationSeconds(
  song: SongRow,
  peaksForSong:
    | { id: string; trackId?: string; durationSeconds: number }[]
    | undefined,
): number {
  let max = 0;
  for (const r of song.regions ?? []) {
    if (r.durationSeconds) max = Math.max(max, r.durationSeconds);
  }
  for (const p of peaksForSong ?? []) {
    if (p.durationSeconds) max = Math.max(max, p.durationSeconds);
  }
  for (const e of song.events) {
    if (e.timeSeconds) max = Math.max(max, e.timeSeconds);
  }
  return Math.max(max, 1);
}
