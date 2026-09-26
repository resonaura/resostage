import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditGesture } from "./editGesture";

describe("createEditGesture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps one id for a continuous stream of writes", () => {
    const g = createEditGesture(350);
    const first = g.id();
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(16); // a frame apart, like a drag
      expect(g.id()).toBe(first);
    }
  });

  it("starts a new one after a pause", () => {
    const g = createEditGesture(350);
    const first = g.id();
    vi.advanceTimersByTime(400);
    expect(g.id()).not.toBe(first);
  });

  it("starts a new one when the caller says the gesture ended", () => {
    const g = createEditGesture(350);
    const first = g.id();
    g.end();
    expect(g.id()).not.toBe(first);
  });
});
