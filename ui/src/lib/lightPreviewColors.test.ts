import { describe, expect, it } from "vitest";
import {
  computeFixturePreviewColors,
  fixturePreviewColor,
} from "./lightPreviewColors";
import type { LightCueRow, LightFixtureRow, LightTrackRow } from "./types";

function makeFixture(id: string): LightFixtureRow {
  return {
    id,
    name: id,
    kind: "resoLightBar",
    gridColumn: 0,
    gridRow: 0,
    ledCount: 48,
    addressable: true,
    posX: 0,
    posY: 0,
    posZ: 0,
    rotationYDeg: 0,
    mountedHorizontally: false,
    dmxUniverse: 0,
    dmxStartChannel: 1,
    dmxChannelCount: 3,
    shape: "bar",
    matrixCols: 0,
    channelProfile: "rgb",
    tiltDeg: 0,
    refreshRateHz: 0,
  };
}

function makeCue(
  trackId: string,
  start: number,
  dur: number,
  r: number,
  g: number,
  b: number,
  intensity = 1,
  fadeInSeconds = 0,
  fadeOutSeconds = 0,
): LightCueRow {
  return {
    id: `${trackId}_${start}`,
    trackId,
    startSeconds: start,
    durationSeconds: dur,
    colorR: r,
    colorG: g,
    colorB: b,
    intensity,
    fadeInSeconds,
    fadeOutSeconds,
    label: "",
    effectType: "none",
    effectSourceType: "bus",
    effectSourceId: "",
    effectIntensity: 0.8,
    tempoSync: false,
    tempoSubdiv: "1/4",
    effectRateHz: 2,
    gradientPreset: "solid",
  };
}

describe("fixturePreviewColor", () => {
  it("returns black when the fixture is not assigned to any light track", () => {
    const fixture = makeFixture("f1");
    const tracks: LightTrackRow[] = [{ id: "t1", name: "wash", fixtureIds: ["f2"] }];
    const cues = [makeCue("t1", 0, 10, 255, 0, 0)];
    expect(fixturePreviewColor(fixture, tracks, cues, 5)).toEqual({
      r: 0,
      g: 0,
      b: 0,
      intensity: 0,
    });
  });

  it("resolves a cue from the track the fixture belongs to", () => {
    const fixture = makeFixture("f1");
    const tracks: LightTrackRow[] = [
      { id: "t1", name: "wash", fixtureIds: ["f1"] },
      { id: "t2", name: "back", fixtureIds: ["f2"] },
    ];
    const cues = [makeCue("t2", 0, 10, 0, 255, 0)];
    expect(fixturePreviewColor(fixture, tracks, cues, 5).g).toBe(0);
  });

  it("later-starting active cue wins across the fixture's own tracks", () => {
    const fixture = makeFixture("f1");
    const tracks: LightTrackRow[] = [
      { id: "t1", name: "wash", fixtureIds: ["f1"] },
      { id: "t2", name: "back", fixtureIds: ["f1"] },
    ];
    const cues = [
      makeCue("t1", 0, 10, 255, 0, 0),
      makeCue("t2", 4, 10, 0, 0, 255),
    ];
    const v = fixturePreviewColor(fixture, tracks, cues, 6);
    expect(v.b).toBe(255);
    expect(v.r).toBe(0);
  });

  it("a cue on a different track does not win over an earlier cue on the fixture's track", () => {
    const fixture = makeFixture("f1");
    const tracks: LightTrackRow[] = [
      { id: "t1", name: "wash", fixtureIds: ["f1"] },
      { id: "t2", name: "back", fixtureIds: ["f2"] },
    ];
    const cues = [
      makeCue("t1", 0, 10, 255, 0, 0),
      makeCue("t2", 4, 10, 0, 0, 255),
    ];
    const v = fixturePreviewColor(fixture, tracks, cues, 6);
    expect(v.r).toBe(255);
    expect(v.b).toBe(0);
  });
});

describe("computeFixturePreviewColors", () => {
  it("maps every fixture to its resolved value at the query time", () => {
    const fixtures = [makeFixture("f1"), makeFixture("f2")];
    const tracks: LightTrackRow[] = [{ id: "t1", name: "wash", fixtureIds: ["f1"] }];
    const cues = [makeCue("t1", 0, 10, 10, 20, 30, 0.8)];
    const colors = computeFixturePreviewColors(fixtures, tracks, cues, 5);
    expect(colors["f1"]).toEqual({ r: 10, g: 20, b: 30, intensity: 0.8 });
    expect(colors["f2"].intensity).toBe(0);
  });
});
