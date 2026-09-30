import { describe, expect, it } from "vitest";
import {
  getTrackPolarityOptions,
  resolveTrackPolarity,
  toggleTrackPolarity,
} from "../logic/polarity";

describe("track polarity", () => {
  it("resolves optimistic state before persisted and legacy state", () => {
    expect(resolveTrackPolarity("left", "right", false)).toBe("left");
    expect(resolveTrackPolarity(null, "right", true)).toBe("right");
    expect(resolveTrackPolarity(null, undefined, true)).toBe("both");
    expect(resolveTrackPolarity(null, undefined, false)).toBe("none");
  });

  it("enables mono on its left channel and stereo on both channels", () => {
    expect(toggleTrackPolarity("none", true)).toBe("left");
    expect(toggleTrackPolarity("none", false)).toBe("both");
    expect(toggleTrackPolarity("right", false)).toBe("none");
  });

  it("offers independent channel choices only for stereo strips", () => {
    expect(getTrackPolarityOptions(true).map(({ value }) => value)).toEqual([
      "both",
      "none",
    ]);
    expect(getTrackPolarityOptions(false).map(({ value }) => value)).toEqual([
      "both",
      "left",
      "right",
      "none",
    ]);
  });
});
