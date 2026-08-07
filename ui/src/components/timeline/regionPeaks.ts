import type {
  AllPeaksResponse,
  PeakLevelData,
  RegionRow,
  TrackPeaks,
} from "../../lib/types";

/** What a region actually needs to draw a waveform. */
export interface ResolvedPeaks {
  durationSeconds: number;
  levels: PeakLevelData[];
}

export interface SongPeakLookup {
  /** Peaks this region should draw, or undefined while none are available. */
  forRegion(
    region: RegionRow,
    trackId: string | undefined,
  ): ResolvedPeaks | undefined;
}

/**
 * Resolves regions to waveform data for one song, in three steps.
 *
 * 1. The region's own row in the all-peaks payload, dereferenced through the
 *    shared file table.
 * 2. Failing that, the file table directly, by source path. Peaks are keyed by
 *    FILE and cover the whole file, so any region cut from the same wav draws
 *    exactly the same levels -- which is what lets a region the payload has
 *    not caught up with render instantly. That is the normal state right after
 *    a split: the new half has an id the payload has never seen, and the
 *    backend rebuilds that payload on its own timer, fetched over a separate
 *    HTTP request. Without this step the new half sat on a spinner waiting to
 *    re-download peaks the browser was already drawing next to it.
 * 3. Failing that, the coarse per-track payload for the staged song, which
 *    lands before the whole-project sweep finishes.
 */
export function buildSongPeakLookup(
  regionEntries: AllPeaksResponse["songs"][number]["tracks"] | undefined,
  files: AllPeaksResponse["files"] | undefined,
  coarseTrackEntries: TrackPeaks[] | undefined,
): SongPeakLookup {
  const byRegionId = new Map<string, AllPeaksResponse["songs"][number]["tracks"][number]>();
  for (const entry of regionEntries ?? []) byRegionId.set(entry.id, entry);

  const byFile = new Map<string, AllPeaksResponse["files"][number]>();
  for (const f of files ?? []) if (f.levels.length > 0) byFile.set(f.file, f);

  return {
    forRegion(region, trackId) {
      const entry = byRegionId.get(region.id);
      if (entry && entry.levelsIndex >= 0) {
        const f = files?.[entry.levelsIndex];
        if (f && f.levels.length > 0)
          return { durationSeconds: entry.durationSeconds, levels: f.levels };
      }

      const shared = region.source.file
        ? byFile.get(region.source.file)
        : undefined;
      if (shared)
        return {
          durationSeconds: shared.durationSeconds,
          levels: shared.levels,
        };

      const coarse = coarseTrackEntries?.find((t) => t.id === trackId);
      if (coarse && coarse.levels.length > 0)
        return {
          durationSeconds: coarse.durationSeconds,
          levels: coarse.levels,
        };

      return undefined;
    },
  };
}
