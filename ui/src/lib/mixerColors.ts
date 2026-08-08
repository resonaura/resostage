import { resolveCssVar } from "./cssColor";

/**
 * Mixer role accents — source of truth is theme.css `--mixer-*`.
 * Always returns concrete `#rrggbb` for canvas / meter fill / hex math.
 */

export function masterColor(): string {
  return resolveCssVar("--mixer-master", "#0091ff");
}

/** Aux / send bus strip + send-knob arc. */
export function sendColor(): string {
  return resolveCssVar("--mixer-send", "#ff9230");
}

export function metronomeColor(): string {
  return resolveCssVar("--mixer-metronome", "#ff9230");
}

/** Stereo Ext. Out / Direct Output family. */
export function extOutColor(): string {
  return resolveCssVar("--mixer-ext-out", "#7c3aed");
}

/** Mono physical output lane (wedge / sub / mono IEM). */
export function monoOutColor(): string {
  return resolveCssVar("--mixer-mono-out", "#30d158");
}

const BUS_CYCLE_COUNT = 5;

/** Non-master, non-aux bus accent on the player meters panel. */
export function busCycleColor(index: number): string {
  const i = ((index % BUS_CYCLE_COUNT) + BUS_CYCLE_COUNT) % BUS_CYCLE_COUNT;
  const fallbacks = ["#30d158", "#ff9230", "#db34f2", "#00d2e0", "#ffd600"];
  return resolveCssVar(`--mixer-bus-${i}`, fallbacks[i]);
}
