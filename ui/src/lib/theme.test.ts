import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PALETTES,
  paletteColor,
  paletteSize,
  ROLE_COLORS,
  type PaletteName,
} from "./theme";

/**
 * The fallbacks in theme.ts and the custom properties in theme.css are two
 * copies of the same palette: one for painting before the stylesheet applies,
 * one for the stylesheet itself. Nothing at runtime compares them -- a
 * fallback is only ever reached when the real value is missing -- so a drift
 * would show up as "track 7 is the wrong colour for one frame", or not at all
 * until someone opened the app with a cold cache.
 *
 * Parsing the stylesheet here is the cheapest way to make that a build error.
 */
// Read from disk rather than imported with `?raw`: the Tailwind plugin claims
// every .css import in this project and hands back an empty string, so the
// check would silently pass on nothing.
const themeCss = readFileSync(
  fileURLToPath(new URL("../styles/theme.css", import.meta.url)),
  "utf8",
);

/** All `--name: #value;` declarations in the stylesheet. */
function declaredHexVars(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(themeCss)) !== null) out.set(m[1], m[2].toLowerCase());
  return out;
}

const declared = declaredHexVars();

describe("theme.css and theme.ts agree", () => {
  const names = Object.keys(PALETTES) as PaletteName[];

  it.each(names)("palette %s is fully declared and matches", (name) => {
    const { prefix, fallbacks } = PALETTES[name];
    fallbacks.forEach((fallback, i) => {
      const varName = `${prefix}-${i}`;
      expect(declared.has(varName), `${varName} missing from theme.css`).toBe(
        true,
      );
      expect(declared.get(varName), `${varName} differs`).toBe(
        fallback.toLowerCase(),
      );
    });
  });

  it.each(names)("palette %s declares no slots beyond its size", (name) => {
    const { prefix } = PALETTES[name];
    // A stylesheet slot with no fallback would be unreachable from TS, which
    // is the drift running the other way.
    const extra = [...declared.keys()].filter((v) => {
      if (!v.startsWith(`${prefix}-`)) return false;
      const idx = Number(v.slice(prefix.length + 1));
      return Number.isInteger(idx) && idx >= paletteSize(name);
    });
    expect(extra).toEqual([]);
  });

  it("every named role is declared", () => {
    for (const [role, { varName, fallback }] of Object.entries(ROLE_COLORS)) {
      // A role may legitimately point at another var (the player aliases do),
      // in which case it is not a literal hex here -- only check the ones that
      // are declared as hex.
      if (!declared.has(varName)) {
        expect(
          themeCss.includes(`${varName}:`),
          `${varName} (${role}) missing from theme.css`,
        ).toBe(true);
        continue;
      }
      expect(declared.get(varName), `${varName} (${role}) differs`).toBe(
        fallback.toLowerCase(),
      );
    }
  });
});

describe("paletteColor", () => {
  // No DOM in this suite, so resolveCssVar returns the fallback -- which is
  // exactly the path being checked.
  it("wraps any index into the palette", () => {
    const size = paletteSize("track");
    expect(paletteColor("track", 0)).toBe(PALETTES.track.fallbacks[0]);
    expect(paletteColor("track", size)).toBe(PALETTES.track.fallbacks[0]);
    expect(paletteColor("track", size * 3 + 2)).toBe(
      PALETTES.track.fallbacks[2],
    );
  });

  it("wraps negative indices too", () => {
    const size = paletteSize("light");
    expect(paletteColor("light", -1)).toBe(PALETTES.light.fallbacks[size - 1]);
    expect(paletteColor("light", -size)).toBe(PALETTES.light.fallbacks[0]);
  });

  it("truncates a fractional index rather than producing NaN", () => {
    expect(paletteColor("bus", 1.9)).toBe(PALETTES.bus.fallbacks[1]);
  });
});
