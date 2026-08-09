/**
 * Crossfades between overlapping regions on the same track.
 *
 * There is no crossfade object anywhere in the project format, and there does
 * not need to be one: a crossfade IS a fade-out on the earlier region plus a
 * fade-in on the later one, over the same span of time. The engine already
 * sums overlapping regions on a track and already applies per-region fades
 * with a curve, so the whole feature is a matter of deriving the two fades
 * from the geometry the user dragged -- no schema change, no DSP, and it
 * plays back correctly in a build of the engine that has never heard of
 * crossfades.
 *
 * That framing is also why this file is pure. The hard part is not writing
 * the fades, it is deciding which pairs overlap and by how much after a drag
 * that may have moved a region across tracks, past its neighbours, or on top
 * of three of them at once -- so that part is separated out and tested.
 */

/** The shape this module needs from a region; the real row has much more. */
export interface CrossfadeRegion {
  id: string;
  trackId: string;
  startSeconds: number;
  /** Already resolved -- 0 means "to the end of the song", not "no length". */
  durationSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  fadeInCurve: number;
  fadeOutCurve: number;
}

/** One region's new fades, ready to hand to builder.regionUpdate. */
export interface CrossfadeUpdate {
  regionId: string;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  fadeInCurve: number;
  fadeOutCurve: number;
}

/**
 * Crossfade shapes, as the curve parameter the engine already understands
 * (`gain = pow(t, 2^(-curve*2))`, curve in [-1, +1]).
 *
 * `equalPower` is the default and the only one most sessions want. A linear
 * pair sums to a dip of about -3dB in the middle whenever the two sides are
 * not phase-coherent, which is the normal case for two different takes; the
 * square-root shape that curve=+0.5 produces is the standard fix and is close
 * enough to a true sin/cos pair to be indistinguishable here.
 */
export const CROSSFADE_SHAPES = {
  equalPower: 0.5,
  linear: 0,
  /** Slow at both ends -- for joins where the middle should not be noticed. */
  sCurve: -0.5,
} as const;

export type CrossfadeShape = keyof typeof CROSSFADE_SHAPES;

export const DEFAULT_CROSSFADE_SHAPE: CrossfadeShape = "equalPower";

/**
 * Overlaps shorter than this are a dragging artefact, not an intention.
 *
 * Snapping puts region edges on exactly the same grid line all the time, and
 * floating-point start/duration arithmetic then leaves a sliver of overlap.
 * A 1ms crossfade is inaudible but it is not free: it rewrites both regions'
 * fades, which costs an undo step and stomps whatever fades the user had.
 */
export const MIN_CROSSFADE_SECONDS = 0.005;

/** Longest crossfade to generate from an overlap, so a nudge cannot swallow a region. */
export const MAX_CROSSFADE_SECONDS = 4;

function endOf(r: CrossfadeRegion): number {
  return r.startSeconds + r.durationSeconds;
}

/**
 * How long the two regions overlap, in seconds. 0 when they do not, or when
 * one wholly contains the other -- a region buried inside another is not a
 * join, and fading it in and out at its own edges would be wrong.
 */
export function overlapSeconds(
  a: CrossfadeRegion,
  b: CrossfadeRegion,
): number {
  const [first, second] = a.startSeconds <= b.startSeconds ? [a, b] : [b, a];
  // Containment: the later region ends before the earlier one does.
  if (endOf(second) <= endOf(first)) return 0;
  return Math.max(0, endOf(first) - second.startSeconds);
}

/**
 * The crossfade to apply between two regions, or null if there is not one.
 *
 * Clamped to each side's own duration: a crossfade longer than the region it
 * fades would mean a region that never reaches full level, which reads as a
 * bug rather than as a long fade.
 */
export function crossfadeBetween(
  a: CrossfadeRegion,
  b: CrossfadeRegion,
  shape: CrossfadeShape = DEFAULT_CROSSFADE_SHAPE,
): { earlier: CrossfadeUpdate; later: CrossfadeUpdate } | null {
  if (a.trackId !== b.trackId) return null;
  if (a.id === b.id) return null;

  const [earlier, later] = a.startSeconds <= b.startSeconds ? [a, b] : [b, a];
  const raw = overlapSeconds(earlier, later);
  if (raw < MIN_CROSSFADE_SECONDS) return null;

  const length = Math.min(
    raw,
    MAX_CROSSFADE_SECONDS,
    earlier.durationSeconds,
    later.durationSeconds,
  );
  if (length < MIN_CROSSFADE_SECONDS) return null;

  const curve = CROSSFADE_SHAPES[shape];
  return {
    earlier: {
      regionId: earlier.id,
      // The earlier region keeps its own fade-in: only the join is ours.
      fadeInSeconds: earlier.fadeInSeconds,
      fadeInCurve: earlier.fadeInCurve,
      fadeOutSeconds: length,
      fadeOutCurve: curve,
    },
    later: {
      regionId: later.id,
      fadeInSeconds: length,
      fadeInCurve: curve,
      fadeOutSeconds: later.fadeOutSeconds,
      fadeOutCurve: later.fadeOutCurve,
    },
  };
}

/**
 * Every crossfade on one track, as one update per affected region.
 *
 * A region can be joined on both sides, so updates are merged rather than
 * emitted per pair -- otherwise the second pair's write would revert the
 * first's. Regions that need no change are left out entirely, which is what
 * keeps a drag that happens not to overlap anything from costing a round trip.
 */
export function planTrackCrossfades(
  regions: readonly CrossfadeRegion[],
  shape: CrossfadeShape = DEFAULT_CROSSFADE_SHAPE,
): CrossfadeUpdate[] {
  const sorted = [...regions].sort((x, y) => x.startSeconds - y.startSeconds);
  const byId = new Map<string, CrossfadeUpdate>();

  const seed = (r: CrossfadeRegion): CrossfadeUpdate => {
    const existing = byId.get(r.id);
    if (existing) return existing;
    const fresh: CrossfadeUpdate = {
      regionId: r.id,
      fadeInSeconds: r.fadeInSeconds,
      fadeOutSeconds: r.fadeOutSeconds,
      fadeInCurve: r.fadeInCurve,
      fadeOutCurve: r.fadeOutCurve,
    };
    byId.set(r.id, fresh);
    return fresh;
  };

  for (let i = 0; i < sorted.length - 1; i++) {
    // Only the immediate neighbour: a stack of three overlapping regions is a
    // mess the user has to sort out, and inventing fades between the outer
    // two would bury the middle one under a fade it never asked for.
    const pair = crossfadeBetween(sorted[i], sorted[i + 1], shape);
    if (!pair) continue;
    seed(sorted[i]).fadeOutSeconds = pair.earlier.fadeOutSeconds;
    seed(sorted[i]).fadeOutCurve = pair.earlier.fadeOutCurve;
    seed(sorted[i + 1]).fadeInSeconds = pair.later.fadeInSeconds;
    seed(sorted[i + 1]).fadeInCurve = pair.later.fadeInCurve;
  }

  // Drop no-ops so an unchanged track produces no writes at all.
  const changed: CrossfadeUpdate[] = [];
  for (const r of sorted) {
    const u = byId.get(r.id);
    if (!u) continue;
    if (
      u.fadeInSeconds === r.fadeInSeconds &&
      u.fadeOutSeconds === r.fadeOutSeconds &&
      u.fadeInCurve === r.fadeInCurve &&
      u.fadeOutCurve === r.fadeOutCurve
    ) {
      continue;
    }
    changed.push(u);
  }
  return changed;
}
