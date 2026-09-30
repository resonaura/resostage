import { MIN_CROSSFADE_SECONDS } from "@/screens/editor/timeline/crossfade/logic/crossfade";

interface PositionedRegion<TId extends string = string> {
  region: { id: TId };
  geom: { start: number; duration: number };
}

export interface PositionedCrossfadePair<T extends PositionedRegion> {
  earlier: T;
  later: T;
  overlap: number;
}

/**
 * Derive the visible crossfade joins for one track lane. Only adjacent
 * regions are considered; nested regions and overlaps below the shared
 * crossfade threshold are not treated as joins.
 */
export function buildCrossfadeLayout<T extends PositionedRegion>(
  items: readonly T[],
): {
  pairs: PositionedCrossfadePair<T>[];
  crossfadedOut: Set<string>;
  crossfadedIn: Set<string>;
} {
  const regions = [...items].sort((a, b) => a.geom.start - b.geom.start);
  const pairs: PositionedCrossfadePair<T>[] = [];

  for (let index = 0; index < regions.length - 1; index++) {
    const earlier = regions[index];
    const later = regions[index + 1];
    const earlierEnd = earlier.geom.start + earlier.geom.duration;
    const overlap = earlierEnd - later.geom.start;
    if (overlap < MIN_CROSSFADE_SECONDS) continue;
    // A region buried inside another is not a join.
    if (later.geom.start + later.geom.duration <= earlierEnd) continue;
    pairs.push({ earlier, later, overlap });
  }

  return {
    pairs,
    crossfadedOut: new Set(pairs.map((pair) => pair.earlier.region.id)),
    crossfadedIn: new Set(pairs.map((pair) => pair.later.region.id)),
  };
}
