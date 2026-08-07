import type { RegionRow, SongRow } from "../../lib/types";

// ── Region UI state (mute overlay; geometry lives in project RegionRow) ──
export interface RegionUiState {
  muted: boolean;
}

/** Stable id for a project region block (selection + drag + mute). */
export type RegionSelKey = string; // `${songIndex}:${regionId}`
export const regionSelKey = (
  songIndex: number,
  regionId: string,
): RegionSelKey => `${songIndex}:${regionId}`;

export interface RegionClipboardEntry {
  songIndex: number;
  trackId: string;
  file: string;
  startSeconds: number;
  sourceOffsetSeconds: number;
  durationSeconds: number;
  gainDb: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

export function lookupRegion(
  songs: SongRow[],
  key: RegionSelKey,
): { songIndex: number; region: RegionRow } | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const songIndex = Number(key.slice(0, colon));
  const regionId = key.slice(colon + 1);
  if (!Number.isFinite(songIndex) || songIndex < 0 || songIndex >= songs.length)
    return null;
  const region = songs[songIndex]?.regions?.find((r) => r.id === regionId);
  if (!region) return null;
  return { songIndex, region };
}

export function allRegionSelKeys(songs: SongRow[]): RegionSelKey[] {
  const keys: RegionSelKey[] = [];
  songs.forEach((song, si) => {
    for (const r of song.regions ?? []) {
      if (r.source.file && r.id) keys.push(regionSelKey(si, r.id));
    }
  });
  return keys;
}
