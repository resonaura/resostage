import type { LightCueRow } from "./types";

export interface LightCueValue {
  r: number;
  g: number;
  b: number;
  intensity: number; // 0-1
}

const BLACK: LightCueValue = { r: 0, g: 0, b: 0, intensity: 0 };

// ─── Cross-track layering / blend modes ───────────────────────────────────
//
// TypeScript port of engine/lighting/LightBlend.h -- kept in sync by hand,
// same as everything else in this file. See that header's class comment for
// why blending happens on the resolved color, not a per-LED array merge.

export type BlendMode =
  | "normal"
  | "additive"
  | "multiply"
  | "difference"
  | "lighten"
  | "subtractive";

export function blendChannel(
  mode: BlendMode,
  base: number,
  top: number,
): number {
  switch (mode) {
    case "additive":
      return Math.min(1, base + top);
    case "multiply":
      return base * top;
    case "difference":
      return Math.abs(base - top);
    case "lighten":
      return Math.max(base, top);
    case "subtractive":
      return Math.max(0, base - top);
    default:
      return top;
  }
}

/**
 * TypeScript port of engine/lighting/LightCueInterpolation.h's
 * resolveLightCueValue -- kept in sync by hand (no shared schema generator
 * yet, same as types.ts/WebServer.cpp). Used for the live ResoLight preview
 * (Timeline's Light mode / the 3D stage's preview mode), where porting a
 * few lines of pure math is cheaper than a server round-trip every frame.
 * See the C++ header for the full rule set; duplicated here only in brief:
 * later-starting active cue wins on overlap, fades ramp intensity only.
 */
export function resolveLightCueValue(
  cues: LightCueRow[],
  timeSeconds: number,
): LightCueValue {
  let active: LightCueRow | null = null;
  let activeStart = 0;

  for (const c of cues) {
    const end = c.startSeconds + c.durationSeconds;
    if (timeSeconds < c.startSeconds || timeSeconds >= end) continue;
    if (active === null || c.startSeconds >= activeStart) {
      active = c;
      activeStart = c.startSeconds;
    }
  }
  if (active === null) return BLACK;

  const dur = Math.max(0, active.durationSeconds);
  const fadeIn = Math.min(Math.max(active.fadeInSeconds, 0), dur);
  const fadeOut = Math.min(Math.max(active.fadeOutSeconds, 0), dur - fadeIn);
  const t = timeSeconds - active.startSeconds;
  const fadeOutStart = dur - fadeOut;

  let level = 1;
  if (fadeIn > 0 && t < fadeIn) level = t / fadeIn;
  else if (fadeOut > 0 && t >= fadeOutStart)
    level = Math.max(0, (dur - t) / fadeOut);

  return {
    r: active.colorR,
    g: active.colorG,
    b: active.colorB,
    intensity: active.intensity * level,
  };
}

// ─── Gradient stop sampling (TS port of engine/lighting/LightGradient.h) ───

export interface GradientStop {
  r: number;
  g: number;
  b: number;
}

const BUILTIN_PALETTES: Record<string, GradientStop[]> = {
  vulcanFire: [
    { r: 0, g: 0, b: 0 },
    { r: 120, g: 0, b: 0 },
    { r: 255, g: 90, b: 0 },
    { r: 255, g: 200, b: 40 },
    { r: 255, g: 255, b: 220 },
  ],
  toxicFire: [
    { r: 0, g: 0, b: 0 },
    { r: 10, g: 60, b: 10 },
    { r: 40, g: 220, b: 60 },
    { r: 190, g: 255, b: 120 },
    { r: 255, g: 255, b: 255 },
  ],
  cryoFire: [
    { r: 0, g: 0, b: 0 },
    { r: 10, g: 20, b: 60 },
    { r: 20, g: 110, b: 200 },
    { r: 100, g: 220, b: 255 },
    { r: 255, g: 255, b: 255 },
  ],
  cyberpunkFire: [
    { r: 10, g: 0, b: 20 },
    { r: 80, g: 0, b: 120 },
    { r: 220, g: 0, b: 200 },
    { r: 0, g: 220, b: 255 },
    { r: 255, g: 255, b: 255 },
  ],
};

export function builtinPalette(name: string): GradientStop[] {
  return BUILTIN_PALETTES[name] ?? BUILTIN_PALETTES.vulcanFire;
}

/** Parses "#RRGGBB,#RRGGBB,..." -- see LightGradient.h's parseGradientStops. */
export function parseGradientStops(
  csv: string,
  fallback: GradientStop[],
): GradientStop[] {
  const stops: GradientStop[] = [];
  for (const raw of csv.split(",")) {
    const token = raw.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(token)) {
      stops.push({
        r: parseInt(token.slice(1, 3), 16),
        g: parseInt(token.slice(3, 5), 16),
        b: parseInt(token.slice(5, 7), 16),
      });
    }
  }
  return stops.length >= 2 ? stops : fallback;
}
