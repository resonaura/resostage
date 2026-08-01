import type { LightCueRow } from "./types";

export interface LightCueValue {
  r: number;
  g: number;
  b: number;
  intensity: number; // 0-1
}

const BLACK: LightCueValue = { r: 0, g: 0, b: 0, intensity: 0 };

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
