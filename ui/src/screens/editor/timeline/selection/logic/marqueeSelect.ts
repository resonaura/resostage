import type { SongRow } from "@/lib/state/types";
import type { CueSelKey } from "@/screens/editor/timeline/lighting/logic/types";
import { regionSelKey, type RegionSelKey } from "@/screens/editor/timeline/regions/logic/regionUtils";
import type { TimelineRow } from "@/screens/editor/timeline/layout/logic/rows";

export type MarqueeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type MarqueeSelection = {
  cueKeys: CueSelKey[];
  selectedCue: CueSelKey | null;
  regionKeys: RegionSelKey[];
};

/** Axis-aligned rect intersection (inclusive edges with tiny epsilon). */
function rectsIntersect(
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
 * Hit-test audio and MIDI regions under a marquee in track-lane coordinates
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
        if (!r.source.file) continue;
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
      const bpm = song.bpm > 0 ? song.bpm : 120;
      for (const r of song.midiRegions ?? []) {
        if (!(r.trackId === track?.id || r.trackId === row.name)) continue;
        const start = (r.startBeats * 60) / bpm;
        const dur = Math.max(0.05, (r.durationBeats * 60) / bpm);
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

/**
 * Resolve the live selection produced by a marquee gesture. Additive selection
 * preserves the original selection order and appends newly hit items, matching
 * the component's historical pointer-drag behavior.
 */
export function resolveMarqueeSelection(args: {
  mode: "audio" | "light";
  marquee: MarqueeRect;
  additive: boolean;
  baseCueKeys: CueSelKey[];
  baseRegionKeys: RegionSelKey[];
  lightTrackIds: string[];
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  laneHeight: number;
  rows: TimelineRow[];
  tracks: { id: string; name: string }[];
}): MarqueeSelection {
  if (args.mode === "light") {
    const hits = marqueeHitCues(
      args.marquee,
      args.lightTrackIds,
      args.songs,
      args.songOffsets,
      args.pxPerSec,
      args.laneHeight,
    );
    const cueKeys = args.additive
      ? mergeCueSelection(args.baseCueKeys, hits)
      : hits;
    return {
      cueKeys,
      selectedCue: cueKeys[cueKeys.length - 1] ?? null,
      regionKeys: [],
    };
  }

  const hits = marqueeHitRegions(
    args.marquee,
    args.rows,
    args.songs,
    args.songOffsets,
    args.songLengths,
    args.pxPerSec,
    args.laneHeight,
    args.tracks,
  );
  return {
    cueKeys: [],
    selectedCue: null,
    regionKeys: args.additive
      ? [...new Set([...args.baseRegionKeys, ...hits])]
      : hits,
  };
}

function mergeCueSelection(
  base: CueSelKey[],
  hits: CueSelKey[],
): CueSelKey[] {
  const merged = new Map(
    base.map((cue) => [`${cue.songIndex}:${cue.cueId}`, cue] as const),
  );
  for (const cue of hits) merged.set(`${cue.songIndex}:${cue.cueId}`, cue);
  return [...merged.values()];
}
