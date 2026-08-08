import { toHexColor } from "../../lib/cssColor";

/**
 * Compact-lane fill: lower lightness of a hex color, optionally push
 * saturation. Done in HSL (no CSS filter) so hue is preserved.
 * `lightness` / `saturation` are multipliers on the source L / S channels.
 *
 * Accepts any CSS color (hex, rgb, theme-resolved hex). Non-hex input is
 * normalised first so track palette CSS vars keep working after resolve.
 */
export function dimHexColor(
  color: string,
  lightness: number,
  saturation = 1,
): string {
  const resolved = toHexColor(color, color);
  const m = resolved.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3)
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  const n = parseInt(hex, 16);
  let r = ((n >> 16) & 255) / 255;
  let g = ((n >> 8) & 255) / 255;
  let b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  s = Math.max(0, Math.min(1, s * saturation));
  l = Math.max(0, Math.min(1, l * lightness));
  // HSL → RGB
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const ri = Math.round(r * 255);
  const gi = Math.round(g * 255);
  const bi = Math.round(b * 255);
  return `#${((1 << 24) | (ri << 16) | (gi << 8) | bi).toString(16).slice(1)}`;
}
