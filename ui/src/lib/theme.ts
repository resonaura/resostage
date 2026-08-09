import { clearCssColorCache, resolveCssVar } from "./cssColor";
import { clearToneColorCache } from "../components/ui/tones";

/**
 * Every colour the app names, in one place.
 *
 * The colours themselves live in styles/theme.css as custom properties -- that
 * is what makes them themeable, and what lets CSS use them directly. This file
 * is the other half: canvas, hex maths and `${color}55` alpha suffixes cannot
 * consume `var(...)`, so anything that PAINTS has to resolve to a concrete
 * `#rrggbb` first.
 *
 * It exists because that resolution was written three times over -- the track
 * palette in timeline/constants, the light palette in light/lightColors, the
 * mixer roles in lib/mixerColors -- each with its own copy of the same
 * wrap-the-index-and-resolve logic and its own hardcoded fallback list. Adding
 * a fourth family meant a fourth copy, and the fallbacks had already drifted
 * from the stylesheet in ways nothing would have caught (see theme.test.ts,
 * which now fails the build if they do).
 */

// ── Cyclic palettes ──────────────────────────────────────────────────────
//
// A palette is indexed by position -- track 5, light track 2 -- and wraps.
// `fallbacks` is what to draw before the stylesheet has applied (first paint,
// tests, no DOM at all); its length IS the palette size, so the two can never
// disagree.

export interface Palette {
  /** CSS custom property prefix; slot N is `${prefix}-${N}`. */
  prefix: string;
  fallbacks: readonly string[];
}

export const PALETTES = {
  /** Audio tracks. Cool/blue-heavy, to contrast with the light palette. */
  track: {
    prefix: "--track-color",
    fallbacks: [
      "#0091ff",
      "#30d158",
      "#ff9230",
      "#db34f2",
      "#ff375f",
      "#00d2e0",
      "#ff4245",
      "#6d7cff",
      "#00dac3",
      "#3cd3fe",
      "#ffd600",
      "#b78a66",
    ],
  },
  /** Light tracks. Warm/amber-heavy, so they read as a different layer. */
  light: {
    prefix: "--light-color",
    fallbacks: [
      "#ff9f0a",
      "#ffd60a",
      "#ff375f",
      "#bf5af2",
      "#64d2ff",
      "#30d158",
      "#ff453a",
      "#00c7be",
    ],
  },
  /** Extra non-aux busses on the player's meter panel. */
  bus: {
    prefix: "--mixer-bus",
    fallbacks: ["#30d158", "#ff9230", "#db34f2", "#00d2e0", "#ffd600"],
  },
} as const satisfies Record<string, Palette>;

export type PaletteName = keyof typeof PALETTES;

export function paletteSize(name: PaletteName): number {
  return PALETTES[name].fallbacks.length;
}

/** Resolved `#rrggbb` for a palette slot. Wraps, so any index is valid. */
export function paletteColor(name: PaletteName, index: number): string {
  const { prefix, fallbacks } = PALETTES[name];
  const n = fallbacks.length;
  const i = ((Math.trunc(index) % n) + n) % n;
  return resolveCssVar(`${prefix}-${i}`, fallbacks[i]);
}

// ── Named roles ──────────────────────────────────────────────────────────
//
// One colour with a meaning, not a position in a cycle.

export const ROLE_COLORS = {
  master: { varName: "--mixer-master", fallback: "#0091ff" },
  /** Aux / send bus strip and send-knob arc. */
  send: { varName: "--mixer-send", fallback: "#ff9230" },
  metronome: { varName: "--mixer-metronome", fallback: "#ff9230" },
  /** Stereo Ext. Out / Direct Output family. */
  extOut: { varName: "--mixer-ext-out", fallback: "#7c3aed" },
  /** A mono physical lane (wedge / sub / mono IEM). */
  monoOut: { varName: "--mixer-mono-out", fallback: "#30d158" },

  eventProgramChange: {
    varName: "--event-color-program-change",
    fallback: "#30d158",
  },
  eventNoteOn: { varName: "--event-color-note-on", fallback: "#30d158" },
  eventNoteOff: { varName: "--event-color-note-off", fallback: "#30d158" },
  eventCc: { varName: "--event-color-cc", fallback: "#0091ff" },
  eventHttp: { varName: "--event-color-http", fallback: "#ff9230" },
  eventDmx: { varName: "--event-color-dmx", fallback: "#db34f2" },
} as const;

export type ColorRole = keyof typeof ROLE_COLORS;

export function roleColor(role: ColorRole): string {
  const { varName, fallback } = ROLE_COLORS[role];
  return resolveCssVar(varName, fallback);
}

// ── Themes ───────────────────────────────────────────────────────────────

/**
 * A theme is the set of custom properties in styles/theme.css selected by a
 * class plus a `data-theme` attribute -- HeroUI keys off both, so both are set.
 *
 * Only `dark` ships today. The app is a stage-side mirror of an always-dark
 * desktop app, so this is applied synchronously before the first render (see
 * main.tsx) rather than followed from the OS preference: a component that
 * reads a resolved colour in its own mount effect would otherwise capture the
 * light theme's near-white values and keep them.
 */
export const THEMES = ["dark", "light"] as const;
export type ThemeId = (typeof THEMES)[number];

const themeListeners = new Set<(id: ThemeId) => void>();
let currentTheme: ThemeId = "dark";

export function getTheme(): ThemeId {
  return currentTheme;
}

/**
 * Swap the theme at runtime.
 *
 * Every resolved colour in the app is cached -- `resolveCssVar` and the
 * control tones both memoise, because a DOM probe per colour per paint would
 * be absurd. Those caches are the reason this has to be a function rather than
 * a class swap at the call site: change the stylesheet without dropping them
 * and half the UI keeps painting the old theme until something remounts.
 */
export function applyTheme(id: ThemeId): void {
  currentTheme = id;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    for (const t of THEMES) root.classList.toggle(t, t === id);
    root.setAttribute("data-theme", id);
  }
  clearCssColorCache();
  clearToneColorCache();
  for (const fn of themeListeners) fn(id);
}

/**
 * Notified after a swap, once the caches are already clear.
 *
 * For the imperative painters -- canvas meters, waveform overlays, the light
 * preview's grid -- which hold resolved colours of their own and have no
 * React render to recompute them in.
 */
export function onThemeChanged(fn: (id: ThemeId) => void): () => void {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}
