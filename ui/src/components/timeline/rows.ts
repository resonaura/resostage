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

/** Shortest song the timeline will draw, so an empty one is still workable. */
export const MIN_SONG_SECONDS = 1;

/**
 * How long the song's CONTENT is -- the furthest thing in it.
 *
 * This is the floor the end marker can be dragged down to, and the length used
 * when no end has been authored.
 */
export function songContentSeconds(
  song: SongRow,
  peaksForSong:
    | { id: string; trackId?: string; durationSeconds: number }[]
    | undefined,
): number {
  let max = 0;
  for (const r of song.regions ?? []) {
    if (r.durationSeconds)
      max = Math.max(max, (r.startSeconds ?? 0) + r.durationSeconds);
  }
  for (const p of peaksForSong ?? []) {
    if (p.durationSeconds) max = Math.max(max, p.durationSeconds);
  }
  for (const e of song.events) {
    if (e.timeSeconds) max = Math.max(max, e.timeSeconds);
  }
  for (const s of song.sections ?? []) {
    if (s.startSeconds) max = Math.max(max, s.startSeconds);
  }
  return max;
}

/**
 * How long the song IS.
 *
 * An authored end (`endSeconds`, the draggable marker) wins over the content:
 * that is the entire point of having one. A song can then be longer than
 * anything in it -- room to write into, and the only way an empty song has a
 * length at all -- or shorter, which shows the tail as out of bounds rather
 * than silently deleting it.
 */
export function songDurationSeconds(
  song: SongRow,
  peaksForSong:
    | { id: string; trackId?: string; durationSeconds: number }[]
    | undefined,
): number {
  const authored = song.endSeconds ?? 0;
  if (authored > 0) return Math.max(authored, MIN_SONG_SECONDS);
  return Math.max(songContentSeconds(song, peaksForSong), MIN_SONG_SECONDS);
}
