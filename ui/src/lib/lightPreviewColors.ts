import { resolveLightCueValue, type LightCueValue } from "./lightCueInterpolation";
import type { LightCueRow, LightFixtureRow, LightTrackRow } from "./types";

/**
 * Resolves the color+intensity a single fixture should show at `timeSeconds`,
 * given the project's light tracks and the currently-playing song's cues.
 *
 * A fixture can be driven by more than one light track; when that happens the
 * "latest-starting active cue wins" rule (the same one resolveLightCueValue
 * applies within a single track) is extended across all of the fixture's
 * tracks -- deterministic, no color blending, matches the engine's Phase A
 * overlap resolution. Used by the Timeline Light mode's live 3D preview.
 */
export function fixturePreviewColor(
  fixture: LightFixtureRow,
  lightTracks: LightTrackRow[],
  songCues: LightCueRow[],
  timeSeconds: number,
): LightCueValue {
  const trackIds = new Set<string>();
  for (const t of lightTracks) {
    if (t.fixtureIds.includes(fixture.id)) trackIds.add(t.id);
  }
  if (trackIds.size === 0) return { r: 0, g: 0, b: 0, intensity: 0 };
  const cues = songCues.filter((c) => trackIds.has(c.trackId));
  return resolveLightCueValue(cues, timeSeconds);
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
