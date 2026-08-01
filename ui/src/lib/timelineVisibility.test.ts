import { describe, expect, it } from "vitest";
import { isPositionVisible } from "./timelineVisibility";

describe("isPositionVisible", () => {
  it("is true for a position comfortably inside the viewport", () => {
    expect(isPositionVisible(500, 0, 1000)).toBe(true);
  });

  it("is false when off-screen to the left", () => {
    expect(isPositionVisible(-10, 0, 1000)).toBe(false);
  });

  it("is false when off-screen to the right", () => {
    expect(isPositionVisible(1500, 0, 1000)).toBe(false);
  });

  it("respects the margin at the left edge", () => {
    expect(isPositionVisible(39, 0, 1000)).toBe(false);
    expect(isPositionVisible(40, 0, 1000)).toBe(true);
  });

  it("respects the margin at the right edge", () => {
    expect(isPositionVisible(961, 0, 1000)).toBe(false);
    expect(isPositionVisible(960, 0, 1000)).toBe(true);
  });

  it("accounts for a non-zero scrollLeft (position is in document space, not screen space)", () => {
    expect(isPositionVisible(500, 2000, 1000)).toBe(false);
    expect(isPositionVisible(2500, 2000, 1000)).toBe(true);
  });

  it("supports a custom margin", () => {
    expect(isPositionVisible(5, 0, 1000, 0)).toBe(true);
    expect(isPositionVisible(5, 0, 1000, 10)).toBe(false);
  });

  it("a viewport wider than the margins on both sides still reports the center visible", () => {
    expect(isPositionVisible(50, 0, 20000)).toBe(true);
  });
});
