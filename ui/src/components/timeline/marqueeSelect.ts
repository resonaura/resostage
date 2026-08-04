import type { SongRow } from "../../lib/types";
import type { CueSelKey } from "../light/LightTimeline";
import { regionSelKey, type RegionSelKey } from "./regionUtils";
import type { TimelineRow } from "./rows";

export type MarqueeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Axis-aligned rect intersection (inclusive edges with tiny epsilon). */
export function rectsIntersect(
  a: MarqueeRect,
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return !(
    a.left + a.width < b.left ||
    a.left > b.right ||
    a.top + a.height < b.top ||
    a.top > b.bottom
  );
}

export function normalizeMarquee(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): MarqueeRect {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  return {
    left,
    top,
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/**
 * Hit-test audio regions under a marquee in track-lane coordinates
 * (origin = top-left of the first audio row, x = absolute timeline px).
 */
export function marqueeHitRegions(
  marquee: MarqueeRect,
  rows: TimelineRow[],
  songs: SongRow[],
  songOffsets: number[],
  songLengths: number[],
  pxPerSec: number,
  laneH: number,
  tracks: { id: string; name: string }[],
): RegionSelKey[] {
  const keys: RegionSelKey[] = [];
  rows.forEach((row, ri) => {
    const y0 = ri * laneH;
    const y1 = y0 + laneH;
    const track = tracks.find(
      (t) => (t.name || t.id) === row.name || t.id === row.name,
    );
    songs.forEach((song, si) => {
      const segStart = (songOffsets[si] ?? 0) * pxPerSec;
      for (const r of song.regions ?? []) {
        if (!r.file) continue;
        if (!(r.trackId === track?.id || r.trackId === row.name)) continue;
        const start = r.startSeconds;
        const dur =
          r.durationSeconds > 0
            ? r.durationSeconds
            : Math.max(0.05, (songLengths[si] ?? 0) - start);
        const left = segStart + start * pxPerSec;
        const right = left + Math.max(4, dur * pxPerSec);
        if (
          rectsIntersect(marquee, {
            left,
            top: y0,
            right,
            bottom: y1,
          })
        ) {
          keys.push(regionSelKey(si, r.id));
        }
      }
    });
  });
  return keys;
}

/**
 * Hit-test light cues under a marquee in light-lane coordinates
 * (origin = top-left of the first light track row).
 */
export function marqueeHitCues(
  marquee: MarqueeRect,
  lightTrackIds: string[],
  songs: SongRow[],
  songOffsets: number[],
  pxPerSec: number,
  laneH: number,
): CueSelKey[] {
  const keys: CueSelKey[] = [];
  lightTrackIds.forEach((trackId, ti) => {
    const y0 = ti * laneH;
    const y1 = y0 + laneH;
    songs.forEach((song, si) => {
      const segStart = (songOffsets[si] ?? 0) * pxPerSec;
      for (const c of song.lightCues ?? []) {
        if (c.trackId !== trackId) continue;
        const left = segStart + c.startSeconds * pxPerSec;
        const right = left + Math.max(3, c.durationSeconds * pxPerSec);
        if (
          rectsIntersect(marquee, {
            left,
            top: y0,
            right,
            bottom: y1,
          })
        ) {
          keys.push({ songIndex: si, cueId: c.id });
        }
      }
    });
  });
  return keys;
}
