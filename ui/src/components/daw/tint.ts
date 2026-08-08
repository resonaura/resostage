/**
 * The tint system: one emphasis scale, applied to any colour.
 *
 * The CSS lives in styles/theme.css (`.tint--*`); this is the TypeScript half
 * — the level names, and the two things CSS cannot work out for itself:
 * plumbing an authored colour in as `--tint`, and choosing a foreground that
 * stays readable on top of it.
 */

/**
 * The fixed hierarchy. Hover is always the next level up, so choosing a
 * resting weight also chooses the interaction — see theme.css for the mix
 * percentages.
 */
export type TintEmphasis =
  | "quiet" // no fill at rest; a wash appears on hover
  | "subtle" // present but recessive
  | "soft" // the default tinted fill
  | "strong" // asserted, still not solid
  | "solid"; // unambiguously ON, contrasting foreground

export function tintClass(emphasis: TintEmphasis): string {
  return `tint--${emphasis}`;
}

/**
 * Relative luminance, sRGB, per WCAG. Used only to pick between a light and a
 * dark foreground, so the gamma expansion matters more than the exactness of
 * the coefficients.
 */
function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** #rgb / #rrggbb / rgb() / rgba(). Returns null for anything else. */
export function parseTintColor(input: string): [number, number, number] | null {
  const s = input.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/**
 * A foreground that stays readable on a solid fill of `color`.
 *
 * Near-black rather than pure black, and near-white rather than pure white:
 * on a dark stage UI, pure black text on a mid-tone track colour reads as a
 * hole punched through the surface.
 *
 * The 0.42 threshold is above the naive 0.5 on purpose. Track colours cluster
 * in the saturated mid-tones, where a straight midpoint flips foregrounds on
 * two colours that look equally bright to the eye; biasing toward the dark
 * foreground keeps the greens and cyans — which read brighter than their
 * luminance suggests — on dark text.
 */
export function readableOn(color: string): string {
  const rgb = parseTintColor(color);
  if (!rgb) return "oklch(0.18 0.006 286)"; // unparseable: assume a light tint
  return luminance(rgb[0], rgb[1], rgb[2]) > 0.42
    ? "oklch(0.18 0.006 286)"
    : "oklch(0.97 0.006 286)";
}

/**
 * Inline style that points the emphasis scale at a specific colour.
 *
 * Spread onto the element that carries a `.tint--*` class:
 *
 *   <button className={tintClass("soft")} style={tintVars(track.color)}>
 *
 * Passing nothing returns an empty object, so the scale falls back to the
 * accent through the CSS `var(--tint, var(--accent))` defaults — a caller
 * never has to special-case "no colour here".
 */
export function tintVars(color?: string | null): React.CSSProperties {
  if (!color) return {};
  return {
    "--tint": color,
    // Only consumed by tint--solid, but set unconditionally: emphasis is a
    // prop, and a component that switches to solid must not need a second
    // style object to go with it.
    "--tint-foreground": readableOn(color),
  } as React.CSSProperties;
}
