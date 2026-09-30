import type { MidiRegionRow, RegionRow, SongRow } from "../../../../../lib/state/types";

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

export interface AudioRegionClipboardEntry {
  kind: "audio";
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

export interface MidiRegionClipboardEntry {
  kind: "midi";
  songIndex: number;
  trackId: string;
  /** Song-local placement, normalized to seconds for mixed audio/MIDI paste. */
  startSeconds: number;
  name: string;
  durationBeats: number;
  clipOffsetBeats: number;
  loop: boolean;
  loopLengthBeats: number;
  loopStartBeats?: number;
  muted: boolean;
  color?: string;
  notes: MidiRegionRow["notes"];
  events?: MidiRegionRow["events"];
  umpEvents?: MidiRegionRow["umpEvents"];
  automationLanes?: MidiRegionRow["automationLanes"];
}

export type RegionClipboardEntry =
  | AudioRegionClipboardEntry
  | MidiRegionClipboardEntry;

export type AnyRegionHit =
  | { kind: "audio"; songIndex: number; region: RegionRow }
  | { kind: "midi"; songIndex: number; region: MidiRegionRow };

export function lookupAnyRegion(
  songs: SongRow[],
  key: RegionSelKey,
): AnyRegionHit | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const songIndex = Number(key.slice(0, colon));
  const regionId = key.slice(colon + 1);
  if (!Number.isFinite(songIndex) || songIndex < 0 || songIndex >= songs.length)
    return null;
  const song = songs[songIndex];
  if (!song) return null;
  const audioRegion = song.regions?.find((r) => r.id === regionId);
  if (audioRegion) return { kind: "audio", songIndex, region: audioRegion };
  const midiRegion = song.midiRegions?.find((r) => r.id === regionId);
  if (midiRegion) return { kind: "midi", songIndex, region: midiRegion };
  return null;
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
    for (const mr of song.midiRegions ?? []) {
      if (mr.id) keys.push(regionSelKey(si, mr.id));
    }
  });
  return keys;
}
