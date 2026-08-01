import { describe, expect, it } from "vitest";
import { resolveLightCueValue } from "./lightCueInterpolation";
import type { LightCueRow } from "./types";

function makeCue(
  start: number,
  dur: number,
  r: number,
  g: number,
  b: number,
  intensity = 1,
  fadeInSeconds = 0,
  fadeOutSeconds = 0,
  trackId = "t1",
): LightCueRow {
  return {
    id: `cue_${start}_${trackId}`,
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
  };
}

describe("resolveLightCueValue", () => {
  it("no cues is black", () => {
    expect(resolveLightCueValue([], 5)).toEqual({ r: 0, g: 0, b: 0, intensity: 0 });
  });

  it("before/after every cue is black (end exclusive)", () => {
    const cues = [makeCue(10, 5, 255, 0, 0)];
    expect(resolveLightCueValue(cues, 9.999).intensity).toBe(0);
    expect(resolveLightCueValue(cues, 15).intensity).toBe(0);
  });

  it("held region with no fades returns the cue's full value", () => {
    const cues = [makeCue(10, 5, 10, 20, 30, 0.8)];
    const v = resolveLightCueValue(cues, 12);
    expect(v).toEqual({ r: 10, g: 20, b: 30, intensity: 0.8 });
  });

  it("fade-in ramps intensity linearly, color is instant", () => {
    const cues = [makeCue(0, 4, 255, 0, 0, 1, 2)];
    expect(resolveLightCueValue(cues, 0).intensity).toBeCloseTo(0);
    expect(resolveLightCueValue(cues, 1).intensity).toBeCloseTo(0.5);
    expect(resolveLightCueValue(cues, 1).r).toBe(255);
    expect(resolveLightCueValue(cues, 2).intensity).toBeCloseTo(1);
  });

  it("fade-out ramps intensity down by the cue's end", () => {
    const cues = [makeCue(0, 4, 0, 255, 0, 1, 0, 2)];
    expect(resolveLightCueValue(cues, 1.9).intensity).toBeCloseTo(1);
    expect(resolveLightCueValue(cues, 3).intensity).toBeCloseTo(0.5);
    expect(resolveLightCueValue(cues, 3.999).intensity).toBeLessThan(0.001);
  });

  it("overlapping cues: the later-starting one wins outright, regardless of input order", () => {
    const cues = [
      makeCue(5, 10, 0, 0, 255, 1), // blue, later-starting, listed first
      makeCue(0, 10, 255, 0, 0, 1), // red, earlier-starting, listed second
    ];
    expect(resolveLightCueValue(cues, 2).r).toBe(255);
    expect(resolveLightCueValue(cues, 7).b).toBe(255);
    expect(resolveLightCueValue(cues, 7).r).toBe(0);
  });
});
