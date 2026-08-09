/**
 * The colour vocabulary shared by every local control wrapper.
 *
 * HeroUI hands each control a different slice of the palette: Button has
 * `danger-soft` but no `accent-soft`, ToggleButton is hard-wired to
 * `accent-soft` when selected, and Slider and Switch have no colour prop at
 * all. This is the one list all four wrappers accept, so "make it soft
 * success" is the same word everywhere.
 *
 * A tone is applied purely by adding a class -- see styles/tones.css for what
 * each one resolves to and why the soft variants colour a handle differently
 * from a track.
 */
export const TONES = [
  "accent",
  "accent-soft",
  "success",
  "success-soft",
  "warning",
  "warning-soft",
  "danger",
  "danger-soft",
  "default",
  "default-soft",
] as const;

export type Tone = (typeof TONES)[number];

const TONE_SET: ReadonlySet<string> = new Set(TONES);

export function isTone(value: unknown): value is Tone {
  return typeof value === "string" && TONE_SET.has(value);
}

/** Class pair for a tone: the bridge marker plus the tone's own variables. */
export function toneClass(tone: Tone | undefined): string | undefined {
  return tone ? `rs-tone rs-tone--${tone}` : undefined;
}

/**
 * Pulse an UNSELECTED toggle between neutral and accent.
 *
 * For state a control is IN but did not CHOOSE: a track silenced by another
 * track's solo shows this on its Mute button. A selected toggle ignores it --
 * see the rule in styles/tones.css for why, and for why this is accent rather
 * than danger.
 */
export const TOGGLE_BLINK_ACCENT = "rs-toggle-blink-accent";

/**
 * HeroUI's `className` follows React Aria's convention: either a string or a
 * function of the control's render state (`isHovered`, `isSelected`, …). A
 * wrapper that only handled the string form would silently drop conditional
 * styling at any call site using the function form, so both are threaded
 * through here rather than at four separate call sites.
 */
export type ClassNameProp<RenderProps> =
  | string
  | ((renderProps: RenderProps) => string)
  | undefined;

function join(a: string | undefined, b: string | undefined): string {
  return a && b ? `${a} ${b}` : (a ?? b ?? "");
}

/**
 * Prepend the tone classes so anything the caller passes still wins on
 * source order within the class attribute (relevant for Tailwind utilities
 * that collide, e.g. an explicit `bg-*`).
 */
export function withTone<RenderProps>(
  className: ClassNameProp<RenderProps>,
  tone: Tone | undefined,
): ClassNameProp<RenderProps> {
  const tc = toneClass(tone);
  if (!tc) return className;
  if (typeof className === "function")
    return (renderProps: RenderProps) => join(tc, className(renderProps));
  return join(tc, className);
}

/** `style` follows the same value-or-render-function shape as `className`. */
export type StyleProp<RenderProps> =
  | React.CSSProperties
  | ((renderProps: RenderProps) => React.CSSProperties | undefined)
  | undefined;

/** Merge extra CSS variables into a style prop of either shape. */
export function withStyleVars<RenderProps>(
  style: StyleProp<RenderProps>,
  vars: React.CSSProperties | undefined,
): StyleProp<RenderProps> {
  if (!vars) return style;
  if (typeof style === "function")
    return (renderProps: RenderProps) => ({ ...vars, ...style(renderProps) });
  return { ...vars, ...style };
}

// ── Flattening a tone against the page ───────────────────────────────────
//
// The soft tones are translucent by construction -- `--accent-soft` is
// `color-mix(in oklab, var(--accent) 12%, transparent)`. Painted directly, a
// soft fill therefore takes its final colour from whatever it happens to be
// sitting on, and two translucent parts of the same control that overlap (a
// slider's fill and the pill behind its grip) stack into a darker band.
//
// `toneSolidColor` flattens a tone into one opaque colour, composited against
// `--background` rather than against the control's own surface. The alpha is
// measured from the live variable rather than hardcoded, so retuning a soft
// token in the theme needs no change here.
//
// Everything is read through the DOM: `getComputedStyle().getPropertyValue()`
// on a custom property returns the SPECIFIED token stream, so `color-mix(...)`
// and `oklch(...)` come back unevaluated. Assigning to a real `color` property
// on a probe element is what forces the browser to resolve them.

/** Resolved once per tone for the document's lifetime; see clearToneColorCache. */
const solidCache = new Map<Tone, string | null>();

function computedColorOf(
  className: string | null,
  value: string,
): string | null {
  const el = document.createElement("span");
  if (className) el.className = className;
  el.style.color = value;
  // Must be in the tree, or :root custom properties don't apply.
  document.documentElement.appendChild(el);
  const resolved = getComputedStyle(el).color;
  document.documentElement.removeChild(el);
  return resolved || null;
}

/** Paint `color` over an opaque backdrop and read back the 8-bit result. */
function paintOver(
  ctx: CanvasRenderingContext2D,
  backdrop: string,
  color: string,
): [number, number, number] {
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function flattenTone(tone: Tone): string | null {
  // Read `--tone` itself with the tone class applied, rather than mapping tone
  // names back to palette tokens here -- that mapping already exists, in
  // tones.css, and duplicating it is how the two drift apart.
  const toneColor = computedColorOf(toneClass(tone) ?? null, "var(--tone)");
  const pageColor = computedColorOf(null, "var(--color-background-secondary)");
  if (!toneColor || !pageColor) return null;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  // Alpha by measurement: the same colour over black and over white differs by
  // exactly (1 - alpha) of the backdrop. Compositing on an OPAQUE canvas and
  // solving for alpha avoids getImageData's un-premultiply, which loses real
  // precision down at the ~12% these tones live at.
  const onBlack = paintOver(ctx, "#000", toneColor);
  const onWhite = paintOver(ctx, "#fff", toneColor);
  const alpha =
    1 -
    (onWhite[0] -
      onBlack[0] +
      (onWhite[1] - onBlack[1]) +
      (onWhite[2] - onBlack[2])) /
      (3 * 255);

  // Fully opaque already (every solid tone): nothing to flatten.
  if (alpha >= 0.999) return toneColor;

  const page = paintOver(ctx, "#000", pageColor);
  const mix = (i: number) =>
    Math.max(0, Math.min(255, Math.round(onBlack[i] + (1 - alpha) * page[i])));
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/**
 * The tone as one opaque colour over `--background`, or undefined when it
 * cannot be resolved (no DOM: tests, SSR) -- callers should fall back to the
 * raw `--tone` in CSS.
 */
export function toneSolidColor(tone: Tone | undefined): string | undefined {
  if (!tone || typeof document === "undefined") return undefined;
  if (!solidCache.has(tone)) solidCache.set(tone, flattenTone(tone));
  return solidCache.get(tone) ?? undefined;
}

/** Drop resolved tones (call after a live theme swap). */
export function clearToneColorCache(): void {
  solidCache.clear();
}
