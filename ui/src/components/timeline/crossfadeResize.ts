/**
 * Growing and shrinking a crossfade without moving either region in time.
 *
 * The crossfade length and the overlap are the same number -- two regions
 * sound together for exactly as long as they overlap, and the engine sums
 * them there. So "make the crossfade longer" has to mean "make the overlap
 * longer", and the question is only which edges move.
 *
 * Moving a region does it, but moves its audio: everything in the later
 * region slides in time, which is wrong when you are joining two takes that
 * are already where they belong. So this grows the overlap SYMMETRICALLY from
 * its centre by trimming instead:
 *
 *   - the earlier region's end extends later, revealing more of its own source
 *   - the later region's start extends earlier, revealing more of its own
 *
 * Neither region's existing audio changes position. Both sides move by the
 * same amount, so the seam -- the point where the two curves cross, which is
 * what the ear locates the join by -- stays put.
 *
 * Each side can run out of source independently (a region trimmed hard
 * against the head of its file has nothing to reveal), and letting one side
 * grow while the other could not would slide the seam. So the growth is
 * clamped to twice the smaller headroom and then split evenly, which keeps
 * the gesture symmetric right up to the point where it stops.
 */

export interface CrossfadeSide {
  /** Seconds into the source file where this region starts reading. */
  sourceOffset: number;
  /** Length on the timeline, in seconds. */
  duration: number;
  /** Full length of the source file, in seconds. */
  fileDuration: number;
}

export interface CrossfadeResizeResult {
  /** How much the overlap actually changed by, after clamping. */
  appliedDelta: number;
  /** New timeline length of the earlier region. */
  earlierDuration: number;
  /** New start of the later region, relative to the same origin as before. */
  laterStartDelta: number;
  /** New source offset of the later region. */
  laterSourceOffset: number;
  /** New timeline length of the later region. */
  laterDuration: number;
}

/** Nothing shorter than this survives as a region; also the shrink floor. */
export const MIN_REGION_SECONDS = 0.05;

/**
 * Work out both regions' new geometry for a crossfade grown by `delta`
 * seconds (negative shrinks).
 *
 * Pure, and deliberately so: the clamping is where this gets subtle, and it
 * is much easier to be sure about here than inside a pointer handler.
 */
export function resizeCrossfade(
  earlier: CrossfadeSide,
  later: CrossfadeSide,
  currentOverlap: number,
  delta: number,
): CrossfadeResizeResult {
  const identity: CrossfadeResizeResult = {
    appliedDelta: 0,
    earlierDuration: earlier.duration,
    laterStartDelta: 0,
    laterSourceOffset: later.sourceOffset,
    laterDuration: later.duration,
  };

  if (delta >= 0) {
    // Source left past the earlier region's end, and before the later's start.
    const earlierHeadroom = Math.max(
      0,
      earlier.fileDuration - (earlier.sourceOffset + earlier.duration),
    );
    const laterHeadroom = Math.max(0, later.sourceOffset);
    // Twice the smaller: each side takes half, so the binding constraint is
    // whichever side runs dry first.
    const room = 2 * Math.min(earlierHeadroom, laterHeadroom);
    const applied = Math.min(delta, room);
    if (applied <= 0) return identity;
    const half = applied / 2;
    return {
      appliedDelta: applied,
      earlierDuration: earlier.duration + half,
      laterStartDelta: -half,
      laterSourceOffset: later.sourceOffset - half,
      laterDuration: later.duration + half,
    };
  }

  // Shrinking: bounded by the overlap itself and by each region staying
  // long enough to exist.
  const want = -delta;
  const applied = Math.min(
    want,
    Math.max(0, currentOverlap),
    2 * Math.max(0, earlier.duration - MIN_REGION_SECONDS),
    2 * Math.max(0, later.duration - MIN_REGION_SECONDS),
  );
  if (applied <= 0) return identity;
  const half = applied / 2;
  return {
    appliedDelta: -applied,
    earlierDuration: earlier.duration - half,
    laterStartDelta: half,
    laterSourceOffset: later.sourceOffset + half,
    laterDuration: later.duration - half,
  };
}
