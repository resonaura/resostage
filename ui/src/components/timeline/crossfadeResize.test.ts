import { describe, expect, it } from "vitest";
import {
  MIN_REGION_SECONDS,
  resizeCrossfade,
  type CrossfadeSide,
} from "./crossfadeResize";

const side = (over: Partial<CrossfadeSide> = {}): CrossfadeSide => ({
  sourceOffset: 10,
  duration: 20,
  fileDuration: 60,
  ...over,
});

describe("resizeCrossfade", () => {
  it("splits growth evenly between the two sides", () => {
    const r = resizeCrossfade(side(), side(), 2, 4);
    expect(r.appliedDelta).toBeCloseTo(4);
    expect(r.earlierDuration).toBeCloseTo(22); // +2
    expect(r.laterStartDelta).toBeCloseTo(-2);
    expect(r.laterSourceOffset).toBeCloseTo(8); // -2
    expect(r.laterDuration).toBeCloseTo(22); // start moved back, end fixed
  });

  it("keeps the seam still while growing", () => {
    // The earlier region's end moves later by exactly as much as the later
    // region's start moves earlier, so the midpoint of the overlap does not
    // shift -- which is what the ear uses to locate the join.
    const r = resizeCrossfade(side(), side(), 2, 3);
    const earlierEndMoved = r.earlierDuration - 20;
    const laterStartMoved = -r.laterStartDelta;
    expect(earlierEndMoved).toBeCloseTo(laterStartMoved);
  });

  it("stops when the earlier region runs out of source", () => {
    // 1s of file left past its end -> at most 2s of growth, 1s per side.
    const earlier = side({ sourceOffset: 10, duration: 20, fileDuration: 31 });
    const r = resizeCrossfade(earlier, side(), 2, 10);
    expect(r.appliedDelta).toBeCloseTo(2);
    expect(r.earlierDuration).toBeCloseTo(21);
  });

  it("stops when the later region is hard against the head of its file", () => {
    const later = side({ sourceOffset: 0 });
    const r = resizeCrossfade(side(), later, 2, 5);
    expect(r.appliedDelta).toBe(0);
    expect(r.laterSourceOffset).toBe(0);
    expect(r.earlierDuration).toBe(20); // symmetric: neither side moves alone
  });

  it("never shrinks past the overlap itself", () => {
    const r = resizeCrossfade(side(), side(), 1.5, -10);
    expect(r.appliedDelta).toBeCloseTo(-1.5);
  });

  it("leaves both regions long enough to exist", () => {
    const tiny = side({ duration: MIN_REGION_SECONDS + 0.1 });
    const r = resizeCrossfade(tiny, side(), 100, -100);
    expect(r.earlierDuration).toBeGreaterThanOrEqual(MIN_REGION_SECONDS);
    expect(r.laterDuration).toBeGreaterThanOrEqual(MIN_REGION_SECONDS);
  });

  it("is a no-op for zero, and for a clamp that leaves no room", () => {
    expect(resizeCrossfade(side(), side(), 2, 0).appliedDelta).toBe(0);
    expect(resizeCrossfade(side(), side(), 0, -1).appliedDelta).toBe(0);
  });
});
