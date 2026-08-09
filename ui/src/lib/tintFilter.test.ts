import { describe, expect, it } from "vitest";
import { duotoneColor, hasTintableHue } from "./tintFilter";

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};
const luma = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

const TINT = "#ff4d06"; // Sunset's accent

describe("duotoneColor", () => {
  it("keeps light content light and dark content dark", () => {
    // The complaint that killed the sepia version: white cues came out grey
    // and dark ones came out drenched. Ordering by brightness has to survive.
    const light = duotoneColor("#ffffff", TINT);
    const mid = duotoneColor("#808080", TINT);
    const dark = duotoneColor("#202020", TINT);
    expect(luma(light)).toBeGreaterThan(luma(mid));
    expect(luma(mid)).toBeGreaterThan(luma(dark));
  });

  it("gives every shade the same hue", () => {
    // A duotone is one hue across the whole ramp; that is what makes it read
    // as a single quiet layer rather than as a second palette.
    const hueOf = (hex: string) => {
      const [r, g, b] = rgb(hex);
      return Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b);
    };
    // Compared in the mid range: at the very top the ramp desaturates
    // toward white, where hue stops being a meaningful measurement.
    const a = hueOf(duotoneColor("#909090", TINT));
    const b = hueOf(duotoneColor("#404040", TINT));
    expect(Math.abs(a - b)).toBeLessThan(0.15);
  });

  it("does not clip a bright source into a different colour", () => {
    // The linear-scaling version blew out one channel at a time here, so a
    // light cue ended up a different hue from a dark one.
    const [r, g, b] = rgb(duotoneColor("#e8e8e8", TINT));
    expect(Math.max(r, g, b)).toBeLessThanOrEqual(255);
    expect(r).toBeGreaterThan(g); // still leaning warm, like the tint
  });

  it("actually tints, rather than leaving grey", () => {
    const [r, g, b] = rgb(duotoneColor("#808080", TINT));
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(20);
  });

  it("falls back to greyscale for a themeless tint", () => {
    // Mono has no hue to lend; the result must be a clean grey, not a
    // slightly-off one.
    const [r, g, b] = rgb(duotoneColor("#3399ff", "#808080"));
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("strength 0 is plain greyscale", () => {
    const [r, g, b] = rgb(duotoneColor("#3399ff", TINT, 0));
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("returns the input unchanged when it cannot parse it", () => {
    expect(duotoneColor("var(--x)", TINT)).toBe("var(--x)");
  });
});

describe("hasTintableHue", () => {
  it("accepts a real colour and rejects greys", () => {
    expect(hasTintableHue("#0485f7")).toBe(true);
    expect(hasTintableHue("#808080")).toBe(false);
    expect(hasTintableHue("")).toBe(false);
  });
});
