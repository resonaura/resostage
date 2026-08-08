import { describe, expect, it } from "vitest";

import { formatBarBeat, formatClock, formatClockPrecise } from "./timeFormat";

describe("formatClock", () => {
  it("formats minutes, seconds and tenths", () => {
    expect(formatClock(0)).toBe("0:00.0");
    expect(formatClock(9.45)).toBe("0:09.4");
    expect(formatClock(61.5)).toBe("1:01.5");
    expect(formatClock(600)).toBe("10:00.0");
  });

  it("truncates rather than rounds", () => {
    // A clock that rounds up shows a second the transport has not reached.
    expect(formatClock(1.99)).toBe("0:01.9");
  });

  it("clamps junk to zero", () => {
    // The playhead can read NaN for a frame during a project swap.
    expect(formatClock(Number.NaN)).toBe("0:00.0");
    expect(formatClock(-5)).toBe("0:00.0");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00.0");
  });
});

describe("formatClockPrecise", () => {
  it("pads to a fixed width so the readout never reflows", () => {
    expect(formatClockPrecise(0)).toBe("00:00.000");
    expect(formatClockPrecise(5.5)).toBe("00:05.500");
    expect(formatClockPrecise(61.25)).toBe("01:01.250");
  });

  it("keeps the same width past ten minutes", () => {
    expect(formatClockPrecise(600)).toBe("10:00.000");
    expect(formatClockPrecise(3599.999)).toBe("59:59.999");
  });

  it("clamps junk to zero", () => {
    expect(formatClockPrecise(Number.NaN)).toBe("00:00.000");
    expect(formatClockPrecise(-1)).toBe("00:00.000");
  });
});

describe("formatBarBeat", () => {
  it("counts from bar 1 beat 1", () => {
    expect(formatBarBeat(0, 120, 4)).toBe("1 | 1");
  });

  it("advances a beat every 60/bpm seconds", () => {
    expect(formatBarBeat(0.5, 120, 4)).toBe("1 | 2");
    expect(formatBarBeat(1.5, 120, 4)).toBe("1 | 4");
    expect(formatBarBeat(2.0, 120, 4)).toBe("2 | 1");
  });

  it("honours the time signature", () => {
    // 3/4: the bar turns over after three beats, not four.
    expect(formatBarBeat(1.5, 120, 3)).toBe("2 | 1");
  });

  it("treats a nonsensical time signature as a single beat per bar", () => {
    expect(formatBarBeat(0.5, 120, 0)).toBe("2 | 1");
  });

  it("refuses to invent a bar number without a tempo", () => {
    // A bar computed from bpm 0 would be a lie, not a zero.
    expect(formatBarBeat(10, 0, 4)).toBe("—");
    expect(formatBarBeat(-1, 120, 4)).toBe("—");
  });
});
