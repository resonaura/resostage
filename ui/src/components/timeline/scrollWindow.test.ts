import { describe, expect, it } from "vitest";
import {
  quantizeScrollWindow,
  sameScrollWindow,
  SCROLL_QUANTUM_PX,
} from "./scrollWindow";

const Q = SCROLL_QUANTUM_PX;

describe("quantizeScrollWindow", () => {
  it("floors the left edge to the step", () => {
    expect(quantizeScrollWindow(0, 1000).scrollLeft).toBe(0);
    expect(quantizeScrollWindow(Q - 1, 1000).scrollLeft).toBe(0);
    expect(quantizeScrollWindow(Q, 1000).scrollLeft).toBe(Q);
    expect(quantizeScrollWindow(Q * 3 + 7, 1000).scrollLeft).toBe(Q * 3);
  });

  it("never produces a negative left edge", () => {
    // Rubber-band scrolling and mid-zoom reads can both hand us a negative.
    expect(quantizeScrollWindow(-40, 1000).scrollLeft).toBe(0);
  });

  it("always covers the real viewport", () => {
    // The property that matters: nothing on screen may fall outside the
    // window, or a lane gets culled while the user is looking at it.
    for (let sl = 0; sl < Q * 4; sl += 13) {
      const vw = 1126;
      const w = quantizeScrollWindow(sl, vw);
      expect(w.scrollLeft).toBeLessThanOrEqual(sl);
      expect(w.scrollLeft + w.viewportWidth).toBeGreaterThanOrEqual(sl + vw);
    }
  });

  it("holds still across a whole step of scrolling", () => {
    const first = quantizeScrollWindow(Q, 1000);
    for (let d = 0; d < Q; d += 7) {
      expect(sameScrollWindow(quantizeScrollWindow(Q + d, 1000), first)).toBe(
        true,
      );
    }
    expect(sameScrollWindow(quantizeScrollWindow(Q * 2, 1000), first)).toBe(
      false,
    );
  });

  it("still reacts to a resize at the same scroll position", () => {
    const a = quantizeScrollWindow(Q, 1000);
    const b = quantizeScrollWindow(Q, 1400);
    expect(sameScrollWindow(a, b)).toBe(false);
  });
});
