/**
 * Telling "this strip changed" apart from "this strip got louder".
 *
 * Peak and loudness numbers live inside the same wire rows as the structural
 * ones -- a TrackRow carries `name`, `mute` and `output` next to `peakDb`.
 * They are also the only fields that change on a quiet frame, so during
 * playback every row object is new ~60 times a second and structural sharing
 * (see ./structuralShare) has nothing left to share. To React that reads as
 * "every track changed", and a `memo` around a mixer strip never once hits.
 *
 * That was costing the console its frame budget: the whole strip -- routing
 * selects, send knobs, fader -- was being reconciled at telemetry rate purely
 * because a meter moved, while the meters themselves were not even reading
 * those props (they sample `getLiveLevels()` during their own canvas paint,
 * which is the entire reason the binary telemetry frame exists).
 *
 * So a component that draws levels through the live getters should memo with
 * these helpers rather than with the default shallow compare. The level props
 * it still receives are a first-paint fallback for the frames before the first
 * binary frame lands -- NOT a live value. Anything that has to show a number
 * that moves must read `getLiveLevels()` off the shared rAF instead; see
 * GainPeakReadout.
 */

/** Row fields the engine rewrites on essentially every telemetry frame. */
const LEVEL_FIELDS: ReadonlySet<string> = new Set([
  "peakDb",
  "peakDbL",
  "peakDbR",
  "shortTermLufs",
]);

/**
 * Shallow-equal ignoring the level fields.
 *
 * Shallow is enough because structural sharing runs first: a nested object
 * that did not change is still the very same object, so `Object.is` on
 * `output` answers "did this track's routing change" correctly and in one
 * comparison.
 */
export function sameExceptLevels<T extends object>(
  a: T | undefined,
  b: T | undefined,
): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b) return false;
  // Interfaces carry no index signature, so the read has to be widened here
  // rather than pushed onto every caller's row type.
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  for (const key of aKeys) {
    if (LEVEL_FIELDS.has(key)) continue;
    if (!Object.is(ao[key], bo[key])) return false;
  }
  return true;
}

/** Element-wise {@link sameExceptLevels}; length change is a change. */
export function rowsSameExceptLevels<T extends object>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameExceptLevels(a[i], b[i])) return false;
  }
  return true;
}
