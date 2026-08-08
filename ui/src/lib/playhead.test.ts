import { describe, expect, it } from "vitest";

import { advancePlayhead, type PlayheadStep } from "./optimistic";

const FRAME = 1 / 60;

const step = (over: Partial<PlayheadStep> = {}): PlayheadStep => ({
  prevPos: 10,
  dt: FRAME,
  serverSeconds: 10,
  serverAgeSec: 0,
  playing: true,
  seekLocked: false,
  ...over,
});

describe("advancePlayhead", () => {
  it("advances by dt when the local clock already agrees with the engine", () => {
    expect(advancePlayhead(step())).toBeCloseTo(10 + FRAME, 6);
  });

  it("keeps running during the seek lock", () => {
    // The bug this guards: the playhead used to be frozen for the whole lock
    // (800 ms on a committed drag), so dropping it and hitting play left it
    // sitting dead still before suddenly taking off. `serverSeconds` here is
    // still the PRE-seek frame, exactly as it is in that window.
    const afterSeek = step({
      prevPos: 60,
      serverSeconds: 10.3,
      seekLocked: true,
    });
    expect(advancePlayhead(afterSeek)).toBeCloseTo(60 + FRAME, 6);
  });

  it("ignores the stale engine frame entirely while the seek lock is held", () => {
    // A pre-seek frame is 50 s behind; without the skip its error term would
    // drag the clock backwards at the correction limit.
    const locked = advancePlayhead(
      step({ prevPos: 60, serverSeconds: 10, seekLocked: true }),
    );
    const unlocked = advancePlayhead(
      step({ prevPos: 60, serverSeconds: 10, seekLocked: false }),
    );
    expect(locked).toBeCloseTo(60 + FRAME, 6);
    expect(unlocked).toBeLessThan(locked); // correction pulls back once unlocked
  });

  it("soft-corrects toward the engine, bounded to ±5% of a frame", () => {
    const ahead = advancePlayhead(step({ prevPos: 10, serverSeconds: 30 }));
    const behind = advancePlayhead(step({ prevPos: 30, serverSeconds: 10 }));
    // Never more than a 5% speed deviation, however large the disagreement.
    expect(ahead).toBeLessThanOrEqual(10 + FRAME * 1.05 + 1e-9);
    expect(behind).toBeGreaterThanOrEqual(30 + FRAME * 0.95 - 1e-9);
  });

  it("extrapolates the engine position by the age of its last frame", () => {
    // The engine publishes at ~30 Hz; a frame 100 ms old describes a playhead
    // that has since moved on, so correcting toward the raw value would keep
    // the display permanently behind.
    const fresh = advancePlayhead(
      step({ prevPos: 10, serverSeconds: 10, serverAgeSec: 0 }),
    );
    const stale = advancePlayhead(
      step({ prevPos: 10, serverSeconds: 10, serverAgeSec: 0.1 }),
    );
    expect(stale).toBeGreaterThan(fresh);
  });

  it("does not extrapolate while stopped", () => {
    const stopped = advancePlayhead(
      step({ prevPos: 10, serverSeconds: 10, serverAgeSec: 5, playing: false }),
    );
    expect(stopped).toBeCloseTo(10 + FRAME, 6);
  });

  it("never goes negative", () => {
    expect(
      advancePlayhead(step({ prevPos: 0, dt: 0, serverSeconds: -100 })),
    ).toBe(0);
  });

  it("wraps at the right locator when it was inside the cycle", () => {
    const wrapped = advancePlayhead(
      step({
        prevPos: 19.99,
        dt: 0.02,
        serverSeconds: 19.99,
        cycleWrap: { loAbs: 10, hiAbs: 20 },
      }),
    );
    // Overshoot is carried, not clamped, so tiny cycles stay in time.
    expect(wrapped).toBeGreaterThanOrEqual(10);
    expect(wrapped).toBeLessThan(10.05);
  });

  it("leaves a playhead outside the cycle alone", () => {
    // Sitting past the loop is intentional (the user parked it there).
    const outside = advancePlayhead(
      step({
        prevPos: 30,
        serverSeconds: 30,
        cycleWrap: { loAbs: 10, hiAbs: 20 },
      }),
    );
    expect(outside).toBeCloseTo(30 + FRAME, 6);
  });
});
