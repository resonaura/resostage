import { describe, expect, it } from "vitest";
import { hasTintableHue, themeAdaptedColor } from "./tintFilter";

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};
const hsl = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
};
/** Shortest angular distance, for comparing hues across the 0/360 seam. */
const hueGap = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);

const THEME = "#ff4d06"; // Sunset's accent, ~17 degrees

describe("themeAdaptedColor", () => {
  it("keeps different cues different", () => {
    // The whole reason this is not a duotone: a lane of distinct cues has to
    // stay readable as distinct cues.
    const red = themeAdaptedColor("#ff0000", THEME);
    const cyan = themeAdaptedColor("#00ffff", THEME);
    expect(hueGap(hsl(red).h, hsl(cyan).h)).toBeGreaterThan(40);
  });

  it("moves each of them toward the theme", () => {
    for (const src of ["#00ffff", "#7c3aed", "#30d158"]) {
      const before = hueGap(hsl(src).h, hsl(THEME).h);
      const after = hueGap(hsl(themeAdaptedColor(src, THEME)).h, hsl(THEME).h);
      expect(after).toBeLessThan(before);
    }
  });

  it("takes the glare off white", () => {
    // The complaint: a white cue was the brightest thing on a dark timeline.
    expect(hsl(themeAdaptedColor("#ffffff", THEME)).l).toBeLessThan(0.75);
  });

  it("keeps bright brighter than dark", () => {
    const light = hsl(themeAdaptedColor("#ffffff", THEME)).l;
    const mid = hsl(themeAdaptedColor("#808080", THEME)).l;
    const dark = hsl(themeAdaptedColor("#101010", THEME)).l;
    expect(light).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(dark);
  });

  it("gives a colourless source the theme's hue rather than leaving a hole", () => {
    expect(hsl(themeAdaptedColor("#ffffff", THEME)).s).toBeGreaterThan(0);
  });

  it("still fixes contrast when the theme has no hue to lend", () => {
    // Mono: nothing to lean toward, but white still glares.
    expect(hsl(themeAdaptedColor("#ffffff", "#808080")).l).toBeLessThan(0.75);
  });

  it("respects an explicit hueBlend of 0", () => {
    const src = "#00ffff";
    const out = themeAdaptedColor(src, THEME, { hueBlend: 0, satBlend: 0 });
    expect(hueGap(hsl(out).h, hsl(src).h)).toBeLessThan(2);
  });

  it("returns the input unchanged when it cannot parse it", () => {
    expect(themeAdaptedColor("var(--x)", THEME)).toBe("var(--x)");
  });
});

describe("hasTintableHue", () => {
  it("accepts a real colour and rejects greys", () => {
    expect(hasTintableHue("#0485f7")).toBe(true);
    expect(hasTintableHue("#808080")).toBe(false);
    expect(hasTintableHue("")).toBe(false);
  });
});
