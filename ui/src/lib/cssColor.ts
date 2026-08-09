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

function toByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

function rgbStringToHex(rgb: string): string | null {
  const m = rgb.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!m) return null;
  return `#${toByte(Number(m[1]))}${toByte(Number(m[2]))}${toByte(Number(m[3]))}`;
}

/**
 * 1×1 scratch canvas used to convert exotic colour syntaxes to bytes.
 *
 * `getComputedStyle().color` does NOT always come back as `rgb(...)`: a value
 * authored in `oklch()` serializes as `oklch(...)`, which is what every colour
 * in styles/themes.css is. Matching only `rgb(` meant each themed palette slot
 * silently resolved to its default-theme fallback, so picking a theme
 * recoloured the CSS-driven chrome and left everything canvas-painted -- track
 * regions, meters, the light lanes -- on the old palette.
 *
 * Letting the browser rasterize one pixel handles oklch, lab, color() and
 * whatever comes next without this file having to know any colour maths.
 */
let scratch: CanvasRenderingContext2D | null | undefined;
function scratchContext(): CanvasRenderingContext2D | null {
  if (scratch !== undefined) return scratch;
  try {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    scratch = c.getContext("2d", { willReadFrequently: true });
  } catch {
    scratch = null;
  }
  return scratch;
}

/** Any CSS colour string the *canvas* can parse, as `#rrggbb`. */
function paintedHex(value: string): string | null {
  const ctx = scratchContext();
  if (!ctx) return null;
  // A sentinel that `value` is very unlikely to be: if the assignment is
  // rejected as unparseable, fillStyle keeps its old value and we can tell.
  const sentinel = "#010203";
  ctx.fillStyle = sentinel;
  ctx.fillStyle = value;
  if (ctx.fillStyle === sentinel && value.replace(/\s/g, "") !== sentinel) {
    return null;
  }
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  try {
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
  } catch {
    return null; // tainted canvas is impossible here, but never throw on paint
  }
}

/** Normalise a computed colour of any syntax; `fallback` if nothing parses. */
function computedToHex(computed: string, fallback: string): string {
  return rgbStringToHex(computed) ?? paintedHex(computed) ?? fallback;
}

/**
 * Turn any CSS color the browser understands into `#rrggbb`.
 * Prefer this over stuffing raw `var()` into canvas / hex-alpha suffixes.
 */
export function toHexColor(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (HEX_RE.test(trimmed)) return expandHex(trimmed);

  if (typeof document === "undefined") return fallback;

  // Already a computed colour (rgb / oklch / lab / color()) -- no var() or
  // color-mix() to expand, so skip the DOM probe.
  if (!trimmed.includes("var(") && !trimmed.includes("color-mix(")) {
    const direct = rgbStringToHex(trimmed) ?? paintedHex(trimmed);
    if (direct) return direct;
  }

  // Probe via a detached element so nested var()/color-mix/oklch resolve.
  // Canvas fillStyle alone does NOT resolve CSS variables.
  const el = document.createElement("span");
  el.style.color = trimmed;
  // Must be in the tree for custom properties from :root to apply.
  document.documentElement.appendChild(el);
  const computed = getComputedStyle(el).color;
  document.documentElement.removeChild(el);
  if (!computed || computed === "rgba(0, 0, 0, 0)") return fallback;
  return computedToHex(computed, fallback);
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
      ? computedToHex(computed, fallback)
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
