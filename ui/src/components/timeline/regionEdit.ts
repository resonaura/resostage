import { builder } from "../../lib/api";
import type { SongRow } from "../../lib/types";
import {
  allRegionSelKeys,
  lookupRegion,
  type RegionClipboardEntry,
  type RegionSelKey,
} from "./regionUtils";

export function resolveSelectedRegions(
  selectedRegionKeys: RegionSelKey[],
  songs: SongRow[],
): RegionClipboardEntry[] {
  const out: RegionClipboardEntry[] = [];
  for (const key of selectedRegionKeys) {
    const hit = lookupRegion(songs, key);
    if (!hit) continue;
    const r = hit.region;
    out.push({
      songIndex: hit.songIndex,
      trackId: r.trackId,
      file: r.file,
      startSeconds: r.startSeconds,
      sourceOffsetSeconds: r.sourceOffsetSeconds,
      durationSeconds: r.durationSeconds,
      gainDb: r.gainDb,
      fadeInSeconds: r.fadeInSeconds,
      fadeOutSeconds: r.fadeOutSeconds,
    });
  }
  return out;
}

export function deleteSelectedRegions(
  selectedRegionKeys: RegionSelKey[],
  songs: SongRow[],
): void {
  // Shared gestureId so the backend's undo history collapses this
  // multi-region delete into ONE undo step instead of N.
  const gestureId = crypto.randomUUID();
  for (const key of selectedRegionKeys) {
    const hit = lookupRegion(songs, key);
    if (hit) void builder.regionRemove(hit.songIndex, hit.region.id, gestureId);
  }
}

export async function addRegionEntries(
  entries: RegionClipboardEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const gestureId = crypto.randomUUID();
  for (const r of entries) {
    await builder.regionAdd({
      songIndex: r.songIndex,
      trackId: r.trackId,
      file: r.file,
      startSeconds: r.startSeconds,
      sourceOffsetSeconds: r.sourceOffsetSeconds,
      durationSeconds: r.durationSeconds,
      gainDb: r.gainDb,
      fadeInSeconds: r.fadeInSeconds,
      fadeOutSeconds: r.fadeOutSeconds,
      gestureId,
    });
  }
}

/** Split selected region(s) at the absolute playhead (Logic-style ⌘T). */
export async function splitRegionsAtPlayhead(
  selectedRegionKeys: RegionSelKey[],
  songs: SongRow[],
  songOffsets: number[],
  songLengths: number[],
  playheadAbsoluteSec: number,
): Promise<number> {
  let splitCount = 0;
  // Shared across every region split (each is regionUpdate + regionAdd)
  // so the whole multi-region split collapses into ONE undo step.
  const gestureId = crypto.randomUUID();
  for (const key of selectedRegionKeys) {
    const hit = lookupRegion(songs, key);
    if (!hit) continue;
    const { songIndex, region: r } = hit;
    const songStart = songOffsets[songIndex] ?? 0;
    const songLen = songLengths[songIndex] ?? 0;
    const localPlayhead = playheadAbsoluteSec - songStart;
    if (localPlayhead < 0 || (songLen > 0 && localPlayhead > songLen)) continue;

    const regionStart = r.startSeconds;
    const regionDur =
      r.durationSeconds > 0
        ? r.durationSeconds
        : Math.max(0.05, songLen - regionStart);
    const regionEnd = regionStart + regionDur;

    if (
      localPlayhead <= regionStart + 0.05 ||
      localPlayhead >= regionEnd - 0.05
    )
      continue;

    const leftDur = localPlayhead - regionStart;
    const rightDur = regionEnd - localPlayhead;
    const rightSourceOffset = r.sourceOffsetSeconds + leftDur;

    await builder.regionUpdate({
      songIndex,
      regionId: r.id,
      durationSeconds: leftDur,
      fadeOutSeconds: 0,
      gestureId,
    });
    await builder.regionAdd({
      songIndex,
      trackId: r.trackId,
      file: r.file,
      startSeconds: localPlayhead,
      sourceOffsetSeconds: rightSourceOffset,
      durationSeconds: rightDur,
      gainDb: r.gainDb,
      fadeInSeconds: 0,
      fadeOutSeconds: r.fadeOutSeconds,
      gestureId,
    });
    splitCount += 1;
  }
  return splitCount;
}

export function selectRegionKeys(
  key: RegionSelKey,
  e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  selectedRegionKeys: RegionSelKey[],
  songs: SongRow[],
): RegionSelKey[] {
  if (e.metaKey || e.ctrlKey) {
    return selectedRegionKeys.includes(key)
      ? selectedRegionKeys.filter((x) => x !== key)
      : [...selectedRegionKeys, key];
  }
  if (e.shiftKey && selectedRegionKeys.length > 0) {
    const all = allRegionSelKeys(songs);
    const last = selectedRegionKeys[selectedRegionKeys.length - 1];
    const a = all.indexOf(last);
    const b = all.indexOf(key);
    if (a >= 0 && b >= 0) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return all.slice(lo, hi + 1);
    }
  }
  return [key];
}
