import { paletteColor, roleColor } from "./theme";

/**
 * Mixer role accents.
 *
 * Thin names over the one colour registry (lib/theme) rather than a second
 * copy of the resolve-and-fall-back logic -- these are the words the mixer
 * code speaks, and keeping them means call sites read as "this strip is the
 * master" instead of "this strip is --mixer-master".
 */

export function masterColor(): string {
  return roleColor("master");
}

/** Aux / send bus strip + send-knob arc. */
export function sendColor(): string {
  return roleColor("send");
}

export function metronomeColor(): string {
  return roleColor("metronome");
}

/** Stereo Ext. Out / Direct Output family. */
export function extOutColor(): string {
  return roleColor("extOut");
}

/** Mono physical output lane (wedge / sub / mono IEM). */
export function monoOutColor(): string {
  return roleColor("monoOut");
}

/** Non-master, non-aux bus accent on the player meters panel. */
export function busCycleColor(index: number): string {
  return paletteColor("bus", index);
}
