/**
 * Theme color helpers.
 *
 * Track / light / event palettes live in theme.css as CSS variables so themes
 * can recolour them. Canvas and hex math (alpha suffix, dimHexColor) cannot
 * consume `var(...)` directly, so callers that paint or tint must resolve
 * through here into a concrete `#rrggbb` first.
 */

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function expandHex(hex: string): string {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return `#${h.slice(0, 6).toLowerCase()}`;
}

function rgbStringToHex(rgb: string, fallback: string): string {
  const m = rgb.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!m) return fallback;
  const toByte = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${toByte(Number(m[1]))}${toByte(Number(m[2]))}${toByte(Number(m[3]))}`;
}

/**
 * Turn any CSS color the browser understands into `#rrggbb`.
 * Prefer this over stuffing raw `var()` into canvas / hex-alpha suffixes.
 */
export function toHexColor(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (HEX_RE.test(trimmed)) return expandHex(trimmed);

  // Already computed rgb() from getComputedStyle.
  if (trimmed.startsWith("rgb")) return rgbStringToHex(trimmed, fallback);

  if (typeof document === "undefined") return fallback;

  // Probe via a detached element so nested var()/color-mix/oklch resolve.
  // Canvas fillStyle alone does NOT resolve CSS variables.
  const el = document.createElement("span");
  el.style.color = trimmed;
  // Must be in the tree for custom properties from :root to apply.
  document.documentElement.appendChild(el);
  const computed = getComputedStyle(el).color;
  document.documentElement.removeChild(el);
  if (!computed || computed === "rgba(0, 0, 0, 0)") return fallback;
  return rgbStringToHex(computed, fallback);
}

const cssVarCache = new Map<string, string>();

/**
 * Read a CSS custom property from `:root` and normalise to `#rrggbb`.
 * Safe on the server / in tests (returns `fallback`).
 *
 * Uses a live DOM probe so nested `var(...)` and `color-mix(...)` tokens
 * fully resolve — `getPropertyValue` alone only returns the specified value.
 */
export function resolveCssVar(varName: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const name = varName.startsWith("--") ? varName : `--${varName}`;

  const cached = cssVarCache.get(name);
  if (cached) return cached;

  const el = document.createElement("span");
  el.style.color = `var(${name})`;
  document.documentElement.appendChild(el);
  const computed = getComputedStyle(el).color;
  document.documentElement.removeChild(el);

  const hex =
    computed && computed !== "rgba(0, 0, 0, 0)"
      ? rgbStringToHex(computed, fallback)
      : fallback;

  cssVarCache.set(name, hex);
  return hex;
}

/** Drop cached resolutions (call after a live theme swap). */
export function clearCssColorCache(): void {
  cssVarCache.clear();
}

/**
 * Append an 8-bit alpha channel to a hex colour.
 * `alphaHex` is `"00"`..`"ff"` (e.g. `"55"` ≈ 33% opacity).
 */
export function withHexAlpha(color: string, alphaHex: string): string {
  const hex = HEX_RE.test(color.trim())
    ? expandHex(color.trim())
    : toHexColor(color, color);
  if (!HEX_RE.test(hex)) return color;
  const base = expandHex(hex).slice(0, 7);
  const a = alphaHex.replace("#", "").padStart(2, "0").slice(0, 2);
  return `${base}${a}`;
}
