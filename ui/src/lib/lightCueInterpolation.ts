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

export type SpatialEffectType = "converge" | "gradientflow" | "chase" | "helix" | "plasma" | "twinkle" | "sonicboom";

export interface AddressableLedColor {
  r: number;
  g: number;
  b: number;
  /** 0..1 multiplier meant to be applied ON TOP OF the fixture's existing
   * resolved intensity, not in place of it. */
  level: number;
}

/**
 * Per-LED color/level for LED `i` of `totalLeds`, for effect types with a
 * real spatial pattern across the strip. `tSec`/`rateHz` come straight from
 * the matching WebUiState.lightOutput row (effectTSec/effectRateHz) so the
 * animation phase always matches the real DMX output exactly.
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
): AddressableLedColor {
  const t = totalLeds > 1 ? i / (totalLeds - 1) : 0;

  const phase = (Math.max(0, tSec) * rateHz) % 1;
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
  const radius = phase * 0.5;
  return { r: baseR, g: baseG, b: baseB, level: Math.max(0, Math.min(1, 1 - Math.abs(Math.abs(t - 0.5) - radius) / 0.10)) };
}
