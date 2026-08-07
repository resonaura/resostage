import type { RegionRow, SongRow, TrackPeaks } from "../../lib/types";

/**
 * One entry of a peak payload. `allPeaks` entries carry `trackId` and are keyed
 * by REGION id; the coarser per-song `peaks` fallback has no `trackId` and is
 * keyed by TRACK id. That one optional field is how the two are told apart --
 * the wire type does not declare it, so it is widened here rather than lied
 * about at each call site.
 */
export type PeakEntry = TrackPeaks & { trackId?: string };

/**
 * source file -> the peak entry of any region cut from it.
 *
 * The backend keys peak overviews by FILE and always ships the WHOLE file's
 * levels, so every region cut from one wav carries a byte-identical payload and
 * differs only in the window it draws (sourceOffset + duration). That makes any
 * sibling's entry a perfect stand-in for a region the payload has not caught up
 * with yet.
 */
export function buildPeaksByFile(
  song: SongRow | undefined,
  entries: PeakEntry[] | undefined,
): Map<string, PeakEntry> {
  const byFile = new Map<string, PeakEntry>();
  if (!entries || !song) return byFile;

  const fileByRegionId = new Map<string, string>();
  for (const r of song.regions ?? [])
    if (r.source.file) fileByRegionId.set(r.id, r.source.file);

  for (const entry of entries) {
    if (entry.levels.length === 0) continue;
    const file = fileByRegionId.get(entry.id);
    if (file && !byFile.has(file)) byFile.set(file, entry);
  }
  return byFile;
}

/**
 * The peak entry a region should draw from.
 *
 * Exact match on region id first. Failing that -- a freshly split or pasted
 * region has an id the payload has never seen, and the backend regenerates that
 * payload on its own timer over a separate HTTP request -- fall back to another
 * region cut from the same file, so the new clip draws instantly from peaks the
 * browser already holds in full rather than showing a spinner for a waveform it
 * is already rendering elsewhere on the same lane.
 */
export function resolveRegionPeakEntry(
  region: RegionRow,
  entries: PeakEntry[] | undefined,
  peaksByFile: Map<string, PeakEntry>,
  trackId: string | undefined,
): PeakEntry | undefined {
  const byId = entries?.find((p) =>
    p.trackId !== undefined ? p.id === region.id : p.id === trackId,
  );
  if (byId || !region.source.file) return byId;
  return peaksByFile.get(region.source.file);
}
