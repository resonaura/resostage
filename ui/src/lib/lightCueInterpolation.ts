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

export type BlendMode = "normal" | "additive" | "multiply" | "difference" | "lighten" | "subtractive";

export function blendChannel(mode: BlendMode, base: number, top: number): number {
  switch (mode) {
    case "additive": return Math.min(1, base + top);
    case "multiply": return base * top;
    case "difference": return Math.abs(base - top);
    case "lighten": return Math.max(base, top);
    case "subtractive": return Math.max(0, base - top);
    default: return top;
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
  else if (fadeOut > 0 && t >= fadeOutStart) level = Math.max(0, (dur - t) / fadeOut);

  return {
    r: active.colorR,
    g: active.colorG,
    b: active.colorB,
    intensity: active.intensity * level,
  };
}

// ─── Per-LED addressable shape ────────────────────────────────────────────
//
// TypeScript port of engine/lighting/LightCueInterpolation.h's
// addressableEffectLedColor/hsvToRgb -- kept in sync by hand, same as
// resolveLightCueValue above. Converge and GradientFlow are the first two
// effects with genuine spatial meaning across a physical LED strip; the
// backend forwards effectType/effectTSec/effectRateHz per fixture (see
// WebUiState::LightOutputRow) instead of a full per-LED color array, so the
// preview computes the identical shape client-side rather than shipping
// that array over the wire every frame.

const GRADIENT_FLOW_SPEED_SCALE = 0.15;

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h -= Math.floor(h);
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let rf = v, gf = v, bf = v;
  switch (i % 6) {
    case 0: rf = v; gf = t; bf = p; break;
    case 1: rf = q; gf = v; bf = p; break;
    case 2: rf = p; gf = v; bf = t; break;
    case 3: rf = p; gf = q; bf = v; break;
    case 4: rf = t; gf = p; bf = v; break;
    default: rf = v; gf = p; bf = q; break;
  }
  const clamp255 = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
  return [clamp255(rf), clamp255(gf), clamp255(bf)];
}

export type SpatialEffectType =
  | "converge" | "gradientflow" | "chase" | "helix" | "plasma" | "twinkle" | "sonicboom"
  | "fire" | "bouncing" | "drip" | "fireworks" | "colorwaves" | "strobeswipe" | "vupeak";

export interface AddressableLedColor {
  r: number;
  g: number;
  b: number;
  /** 0..1 multiplier meant to be applied ON TOP OF the fixture's existing
   * resolved intensity, not in place of it. */
  level: number;
}

// ─── Gradient stop sampling (TS port of engine/lighting/LightGradient.h) ───

export interface GradientStop {
  r: number;
  g: number;
  b: number;
}

const BUILTIN_PALETTES: Record<string, GradientStop[]> = {
  vulcanFire: [{ r: 0, g: 0, b: 0 }, { r: 120, g: 0, b: 0 }, { r: 255, g: 90, b: 0 }, { r: 255, g: 200, b: 40 }, { r: 255, g: 255, b: 220 }],
  toxicFire: [{ r: 0, g: 0, b: 0 }, { r: 10, g: 60, b: 10 }, { r: 40, g: 220, b: 60 }, { r: 190, g: 255, b: 120 }, { r: 255, g: 255, b: 255 }],
  cryoFire: [{ r: 0, g: 0, b: 0 }, { r: 10, g: 20, b: 60 }, { r: 20, g: 110, b: 200 }, { r: 100, g: 220, b: 255 }, { r: 255, g: 255, b: 255 }],
  cyberpunkFire: [{ r: 10, g: 0, b: 20 }, { r: 80, g: 0, b: 120 }, { r: 220, g: 0, b: 200 }, { r: 0, g: 220, b: 255 }, { r: 255, g: 255, b: 255 }],
};

export function builtinPalette(name: string): GradientStop[] {
  return BUILTIN_PALETTES[name] ?? BUILTIN_PALETTES.vulcanFire;
}

/** Parses "#RRGGBB,#RRGGBB,..." -- see LightGradient.h's parseGradientStops. */
export function parseGradientStops(csv: string, fallback: GradientStop[]): GradientStop[] {
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

/** Linearly-interpolated color at `t` (0..1, clamped) across `stops`. */
export function sampleGradient(stops: GradientStop[], t: number): [number, number, number] {
  if (stops.length === 0) return [0, 0, 0];
  if (stops.length === 1) return [stops[0].r, stops[0].g, stops[0].b];
  const c = Math.max(0, Math.min(1, t));
  const scaled = c * (stops.length - 1);
  const i0 = Math.floor(scaled);
  const i1 = Math.min(stops.length - 1, i0 + 1);
  const f = scaled - i0;
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * f);
  return [lerp(stops[i0].r, stops[i1].r), lerp(stops[i0].g, stops[i1].g), lerp(stops[i0].b, stops[i1].b)];
}

// ─── Deterministic value noise (Fire) -- TS port of LightCueInterpolation.h ─

function noiseHash01(ix: number, iy: number): number {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffffff) / 0xffffff;
}
function valueNoise2D(x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const v00 = noiseHash01(x0, y0), v10 = noiseHash01(x0 + 1, y0);
  const v01 = noiseHash01(x0, y0 + 1), v11 = noiseHash01(x0 + 1, y0 + 1);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}
const pointFalloff = (t: number, center: number, width: number) =>
  Math.max(0, Math.min(1, 1 - Math.abs(t - center) / width));

/**
 * Per-LED color/level for LED `i` of `totalLeds`, for effect types with a
 * real spatial pattern across the strip. `tSec`/`rateHz` come straight from
 * the matching WebUiState.lightOutput row (effectTSec/effectRateHz) so the
 * animation phase always matches the real DMX output exactly. `palette`
 * (optional): resolved custom/named gradient stops for Fire/Colorwaves --
 * see LightOutputResolver.h's resolveGradientStops, ported as
 * parseGradientStops/builtinPalette above. `audioLevel` (optional):
 * VuPeak only.
 */
export function addressableEffectLedColor(
  i: number,
  totalLeds: number,
  type: SpatialEffectType,
  tSec: number,
  rateHz: number,
  baseR: number,
  baseG: number,
  baseB: number,
  palette?: GradientStop[],
  audioLevel = 0,
): AddressableLedColor {
  const t = totalLeds > 1 ? i / (totalLeds - 1) : 0;

  const phase = (Math.max(0, tSec) * rateHz) % 1;
  const TAU = Math.PI * 2;
  if (type === "converge") {
    const bandPos = phase * 0.5; // 0 (edge) .. 0.5 (centre)
    const distFromEdge = Math.min(t, 1 - t); // 0 at either edge, 0.5 at centre
    const kBandWidth = 0.12;
    const level = Math.max(0, Math.min(1, 1 - Math.abs(distFromEdge - bandPos) / kBandWidth));
    return { r: baseR, g: baseG, b: baseB, level };
  }

  if (type === "gradientflow") {
    const [r, g, b] = hsvToRgb(t + Math.max(0, tSec) * rateHz * GRADIENT_FLOW_SPEED_SCALE, 1, 1);
    return { r, g, b, level: 1 };
  }
  if (type === "chase") return { r: baseR, g: baseG, b: baseB, level: Math.max(0, Math.min(1, 1 - Math.abs(t - phase) / 0.16)) };
  if (type === "helix") {
    const [r, g, b] = hsvToRgb(t + phase, 0.85, 1);
    return { r, g, b, level: Math.pow(0.5 + 0.5 * Math.sin(Math.PI * 2 * (t * 2 + phase)), 3) };
  }
  if (type === "plasma") {
    const field = 0.5 + 0.5 * (Math.sin(Math.PI * 2 * (t * 1.7 + phase)) + Math.sin(Math.PI * 2 * (t * 3.1 - phase)) + Math.sin(Math.PI * 2 * (t * 0.7 + phase * 2))) / 3;
    const [r, g, b] = hsvToRgb(field + phase * 0.35, 0.9, 0.35 + field * 0.65);
    return { r, g, b, level: 1 };
  }
  if (type === "twinkle") {
    const timeCell = Math.floor(Math.max(0, tSec) * rateHz * 3);
    const h = ((i * 1103515245) ^ (timeCell * 2654435761)) >>> 0;
    const [r, g, b] = hsvToRgb((h % 360) / 360, 0.55, 1);
    return { r, g, b, level: (h & 1023) < 60 ? 1 : 0.03 };
  }
  if (type === "sonicboom") {
    const radius = phase * 0.5;
    return { r: baseR, g: baseG, b: baseB, level: Math.max(0, Math.min(1, 1 - Math.abs(Math.abs(t - 0.5) - radius) / 0.10)) };
  }

  if (type === "fire") {
    const rise = Math.max(0, tSec) * rateHz * 0.6;
    let n = 0.6 * valueNoise2D(0.0, t * 6.0 - rise * 4.0) + 0.4 * valueNoise2D(3.7, t * 11.0 - rise * 7.0);
    n = Math.max(0, Math.min(1, n));
    const attenuation = Math.max(0, Math.min(1, 1 - t * 1.15));
    let heat = Math.max(0, Math.min(1, n * attenuation * 1.35));
    heat = Math.pow(heat, 1.4);
    const [r, g, b] = sampleGradient(palette && palette.length ? palette : builtinPalette("vulcanFire"), heat);
    return { r, g, b, level: 1 };
  }
  if (type === "colorwaves") {
    const idx = Math.sin(4.0 * t + phase * TAU) + Math.sin(7.0 * t - 1.5 * phase * TAU) + Math.cos(2.3 * t + 2.0 * phase * TAU);
    const idx01 = Math.max(0, Math.min(1, (idx + 3.0) / 6.0));
    const [r, g, b] = palette && palette.length ? sampleGradient(palette, idx01) : hsvToRgb(idx01, 1, 1);
    return { r, g, b, level: 1 };
  }
  if (type === "bouncing") {
    const kBalls = 3;
    let best = 0, bestBall = 0;
    for (let k = 0; k < kBalls; k++) {
      const cycleLen = 1.6 + k * 0.35;
      const cyclePos = (Math.max(0, tSec) * rateHz / cycleLen + k * 0.29) % 1;
      const period = 0.10 + k * 0.015;
      const envelope = Math.exp(-3.2 * cyclePos);
      const bouncePhase = (cyclePos / period) % 1;
      const height = envelope * Math.abs(Math.sin(TAU * 0.5 * bouncePhase));
      const lvl = pointFalloff(t, height, 0.05);
      if (lvl > best) { best = lvl; bestBall = k; }
    }
    const [r, g, b] = hsvToRgb(0.08 * bestBall, 0.7, 1);
    return { r, g, b, level: best };
  }
  if (type === "drip") {
    const kDrips = 2;
    let best = 0;
    for (let j = 0; j < kDrips; j++) {
      const cyclePos = (Math.max(0, tSec) * rateHz * 0.5 + j * 0.53) % 1;
      let lvl: number;
      if (cyclePos < 0.8) {
        const f = cyclePos / 0.8;
        const y = 1 - f * f;
        lvl = pointFalloff(t, y, 0.045);
      } else {
        const f = (cyclePos - 0.8) / 0.2;
        lvl = (1 - f) * pointFalloff(t, 0, 0.05 + f * 0.25);
      }
      best = Math.max(best, lvl);
    }
    return { r: baseR, g: baseG, b: baseB, level: best };
  }
  if (type === "fireworks") {
    const cyclePos = (Math.max(0, tSec) * rateHz * 0.4) % 1;
    const shot = Math.floor(Math.max(0, tSec) * rateHz * 0.4);
    const apex = 0.55 + 0.4 * noiseHash01(shot, 97);
    if (cyclePos < 0.3) {
      const f = cyclePos / 0.3;
      return { r: baseR, g: baseG, b: baseB, level: pointFalloff(t, f * apex, 0.05) * (0.6 + 0.4 * f) };
    }
    const f = (cyclePos - 0.3) / 0.7;
    const h = noiseHash01(i, shot * 131 + 7);
    const speed = 0.25 + 0.9 * h;
    const dist = speed * f;
    const isSpark = h < 0.35;
    const level = isSpark ? pointFalloff(t, apex - dist, 0.035) * Math.exp(-3.0 * f) : 0;
    const [r, g, b] = hsvToRgb(0.02 + h * 0.12, 0.85, 1);
    return { r, g, b, level };
  }
  if (type === "strobeswipe") {
    const elapsedBeats = phase / Math.max(1e-6, rateHz);
    const kSwipeFrac = 0.08;
    const level = phase < kSwipeFrac
      ? (t <= phase / kSwipeFrac ? 1 : 0)
      : Math.exp(-elapsedBeats / 0.15);
    return { r: baseR, g: baseG, b: baseB, level };
  }
  // vupeak
  const level01 = Math.max(0, Math.min(1, audioLevel));
  const capWidth = totalLeds > 1 ? 1 / (totalLeds - 1) : 1;
  const level = t <= level01 ? (t >= level01 - capWidth * 1.5 ? 1 : 0.65) : 0;
  return { r: baseR, g: baseG, b: baseB, level };
}
