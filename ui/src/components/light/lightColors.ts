import { resolveCssVar } from "../../lib/cssColor";

// Distinct palette for light tracks so they read as a different layer from
// the audio track colors (which cycle getTrackColor). Warm/amber-heavy.
// Source of truth: theme.css `--light-color-N`.
export const LIGHT_COLOR_COUNT = 8;

const LIGHT_COLOR_FALLBACKS = [
  "#ff9f0a",
  "#ffd60a",
  "#ff375f",
  "#bf5af2",
  "#64d2ff",
  "#30d158",
  "#ff453a",
  "#00c7be",
];

/**
 * Resolved `#rrggbb` for a light-track palette slot.
 * Concrete hex so canvas and alpha suffixes keep working.
 */
export function getLightColor(index: number): string {
  const i =
    ((index % LIGHT_COLOR_COUNT) + LIGHT_COLOR_COUNT) % LIGHT_COLOR_COUNT;
  return resolveCssVar(`--light-color-${i}`, LIGHT_COLOR_FALLBACKS[i]);
}
