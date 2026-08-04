import { describe, expect, it } from "vitest";
import {
  formatTimeShort,
  getSnapInterval,
  getTickConfig,
  snapToGridSec,
} from "./geometry";

describe("formatTimeShort", () => {
  it("formats minutes and tenths with zero-padded seconds", () => {
    expect(formatTimeShort(0)).toBe("0:00.0");
    expect(formatTimeShort(65.25)).toBe("1:05.3");
    expect(formatTimeShort(75.0)).toBe("1:15.0");
  });

  it("clamps non-finite / negative", () => {
    expect(formatTimeShort(-3)).toBe("0:00.0");
    expect(formatTimeShort(Number.NaN)).toBe("0:00.0");
  });
});

describe("getTickConfig", () => {
  it("returns beat-aware steps when bpm is set", () => {
    const tc = getTickConfig(40, 120, 4);
    expect(tc.isBeatGrid).toBe(true);
    expect(tc.beatSec).toBeCloseTo(0.5);
    expect(tc.barSec).toBeCloseTo(2);
    expect(tc.majorStepSec).toBeGreaterThan(0);
    expect(tc.minorStepSec).toBeGreaterThan(0);
    expect(tc.minorStepSec).toBeLessThanOrEqual(tc.majorStepSec + 1e-12);
  });

  it("falls back to absolute seconds without bpm", () => {
    const tc = getTickConfig(20, 0, 4);
    expect(tc.isBeatGrid).toBe(false);
    expect(tc.majorStepSec).toBeGreaterThan(0);
  });
});

describe("snapToGridSec", () => {
  it("is a no-op when snap is disabled", () => {
    expect(snapToGridSec(1.23, 40, 120, 4, false)).toBe(1.23);
  });

  it("snaps to the current minor interval", () => {
    const interval = getSnapInterval(40, 120, 4);
    const raw = interval * 3.4;
    const snapped = snapToGridSec(raw, 40, 120, 4, true);
    expect(snapped % interval).toBeCloseTo(0, 5);
  });
});
