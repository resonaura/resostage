import { blendChannel, resolveLightCueValue, type BlendMode, type LightCueValue } from "./lightCueInterpolation";
import type { LightCueRow, LightFixtureRow, LightTrackRow } from "./types";

const effective = (v: LightCueValue, ch: 0 | 1 | 2) => {
  const c = ch === 0 ? v.r : ch === 1 ? v.g : v.b;
  return (c / 255) * v.intensity;
};

/**
 * Resolves the color+intensity a single fixture should show at `timeSeconds`,
 * given the project's light tracks and the currently-playing song's cues.
 *
 * Mirrors engine/lighting/LightOutputResolver.h's cross-track layering
 * exactly (see that header for the full reasoning): each track driving this
 * fixture resolves independently via resolveLightCueValue, tracks with no
 * CURRENTLY active cue contribute nothing (not a black layer), a single
 * active layer passes through untouched, and two or more fold together
 * bottom-to-top using each layer's own blendMode. Used by the Timeline
 * Light mode's live 3D preview.
 */
export function fixturePreviewColor(
  fixture: LightFixtureRow,
  lightTracks: LightTrackRow[],
  songCues: LightCueRow[],
  timeSeconds: number,
): LightCueValue {
  const layers: { value: LightCueValue; blendMode: BlendMode }[] = [];
  for (const t of lightTracks) {
    if (!t.fixtureIds.includes(fixture.id)) continue;
    const trackCues = songCues.filter((c) => c.trackId === t.id);
    if (trackCues.length === 0) continue;
    // Same "latest-starting active cue" rule resolveLightCueValue applies
    // internally -- re-derived here (not just re-checked) so blendMode
    // comes from the SAME cue that decided the color, not whichever
    // overlapping cue happens to be first in array order.
    let active: LightCueRow | null = null;
    let activeStart = 0;
    for (const c of trackCues) {
      const end = c.startSeconds + c.durationSeconds;
      if (timeSeconds < c.startSeconds || timeSeconds >= end) continue;
      if (active === null || c.startSeconds >= activeStart) {
        active = c;
        activeStart = c.startSeconds;
      }
    }
    if (!active) continue; // track has cues, just none active right now -- contributes nothing
    layers.push({
      value: resolveLightCueValue(trackCues, timeSeconds),
      blendMode: (active.blendMode || "normal") as BlendMode,
    });
  }
  if (layers.length === 0) return { r: 0, g: 0, b: 0, intensity: 0 };
  if (layers.length === 1) return layers[0].value;

  let acc = layers[0].value;
  for (let i = 1; i < layers.length; i++) {
    const { value: top, blendMode } = layers[i];
    if (blendMode === "normal") {
      acc = top;
      continue;
    }
    const mix = (ch: 0 | 1 | 2) =>
      Math.max(0, Math.min(255, Math.round(blendChannel(blendMode, effective(acc, ch), effective(top, ch)) * 255)));
    acc = { r: mix(0), g: mix(1), b: mix(2), intensity: 1 };
  }
  return acc;
}

/** Per-fixture preview colors for the whole rig at one instant in time. */
export function computeFixturePreviewColors(
  fixtures: LightFixtureRow[],
  lightTracks: LightTrackRow[],
  songCues: LightCueRow[],
  timeSeconds: number,
): Record<string, LightCueValue> {
  const out: Record<string, LightCueValue> = {};
  for (const f of fixtures) {
    out[f.id] = fixturePreviewColor(f, lightTracks, songCues, timeSeconds);
  }
  return out;
}
