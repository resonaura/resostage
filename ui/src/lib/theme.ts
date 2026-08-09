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
      "#0485f7",
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

// Fallbacks here are what the default theme's tokens actually resolve to --
// they are only reached before the stylesheet applies, so a stale one shows up
// as a single wrong-coloured frame and nothing else ever notices.
export const ROLE_COLORS = {
  master: { varName: "--mixer-master", fallback: "#0485f7" },
  /** Aux / send bus strip and send-knob arc. */
  send: { varName: "--mixer-send", fallback: "#ff9230" },
  metronome: { varName: "--mixer-metronome", fallback: "#ff9230" },
  /** Stereo Ext. Out / Direct Output family. */
  extOut: { varName: "--mixer-ext-out", fallback: "#db34f2" },
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

  /** Latched-clip red, shared by every meter and readout that shows one. */
  meterClip: { varName: "--meter-clip", fallback: "#ff3b30" },
  /** The analogue VU dial: plate, printed scale, hot zone, needle. */
  vuPlate: { varName: "--vu-plate", fallback: "#000000" },
  vuScale: { varName: "--vu-scale", fallback: "#cccccc" },
  vuHot: { varName: "--vu-hot", fallback: "#ff3b30" },
  vuNeedle: { varName: "--vu-needle", fallback: "#ffffff" },
} as const;

export type ColorRole = keyof typeof ROLE_COLORS;

export function roleColor(role: ColorRole): string {
  const { varName, fallback } = ROLE_COLORS[role];
  return resolveCssVar(varName, fallback);
}

// ── Themes ───────────────────────────────────────────────────────────────

/**
 * A theme is a name, and nothing else.
 *
 * There is deliberately no light mode. This is a stage surface: it is looked
 * at in a dark room, next to a lit stage, by someone who cannot afford for
 * their eyes to readjust -- a light interface is not a preference here, it is
 * a hazard. So the root is pinned to `dark` (which is what HeroUI's own
 * stylesheet keys off) and the name alone picks the colour family, landing on
 * `data-theme-name`. See styles/themes.css.
 */
export const THEME_NAMES = [
  "default",
  "sunset",
  "forest",
  "purple",
  "pinky",
  "sky",
  "blue",
  "mono",
] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const THEME_LABELS: Record<ThemeName, string> = {
  default: "Default",
  sunset: "Sunset",
  forest: "Forest",
  purple: "Purple Haze",
  pinky: "Pinky Pie",
  sky: "Sky",
  blue: "Blue Foundation",
  mono: "Mono",
};

export interface ThemeChoice {
  name: ThemeName;
}

export const DEFAULT_THEME: ThemeChoice = { name: "default" };

const STORAGE_KEY = "resostage.theme";

export function readThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    // Stored values may still carry a `mode` from when light was an option;
    // it is read past rather than migrated, since ignoring it IS the migration.
    const parsed = JSON.parse(raw) as Partial<ThemeChoice>;
    return {
      name: (THEME_NAMES as readonly string[]).includes(parsed.name ?? "")
        ? (parsed.name as ThemeName)
        : DEFAULT_THEME.name,
    };
  } catch {
    return DEFAULT_THEME; // private mode / corrupt value
  }
}

function writeThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    /* best-effort */
  }
}

const themeListeners = new Set<(choice: ThemeChoice) => void>();
let current: ThemeChoice = DEFAULT_THEME;
let version = 0;

/**
 * Bumped on every swap.
 *
 * Resolved colours are concrete hex by the time they reach a canvas or a
 * `useMemo`, so clearing the caches is not enough on its own -- a memo that
 * already captured "track 3 is #0091ff" will happily keep it. Anything that
 * MEMOISES a colour has to depend on this; see useThemeVersion.
 */
export function themeVersion(): number {
  return version;
}

export function getTheme(): ThemeChoice {
  return current;
}

/**
 * Apply a theme and remember it.
 *
 * Every resolved colour in the app is cached -- `resolveCssVar` and the
 * control tones both memoise, because a DOM probe per colour per paint would
 * be absurd. Dropping those caches is the reason this has to be a function
 * rather than a class swap at the call site: change the stylesheet without
 * clearing them and half the UI keeps painting the old theme until something
 * happens to remount.
 */
export function applyTheme(choice: ThemeChoice): void {
  current = choice;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.classList.add("dark");
    root.classList.remove("light");
    root.setAttribute("data-theme", "dark");
    // The default family is the base stylesheet, so it carries no name --
    // that keeps its selectors the plain ones and one less thing to override.
    if (choice.name === "default") root.removeAttribute("data-theme-name");
    else root.setAttribute("data-theme-name", choice.name);
  }
  writeThemeChoice(choice);
  version += 1;
  clearCssColorCache();
  clearToneColorCache();
  for (const fn of themeListeners) fn(choice);
}

/**
 * Notified after a swap, once the caches are already clear.
 *
 * For the imperative painters -- canvas meters, waveform overlays, the light
 * preview's grid -- which hold resolved colours of their own and have no
 * React render to recompute them in.
 */
export function onThemeChanged(fn: (choice: ThemeChoice) => void): () => void {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

/** Subscribe form of {@link themeVersion}, for React memo dependencies. */
export function subscribeTheme(fn: () => void): () => void {
  return onThemeChanged(fn);
}
