/**
 * Duotone: keep a colour's brightness, take its hue from somewhere else.
 *
 * Used for reference strips that must read as "this is context, not the thing
 * you are editing" -- the timeline's light preview in audio mode, where the
 * cues' own saturated stage colours would otherwise shout louder than the
 * audio regions they sit under.
 *
 * ## Two approaches that did not survive contact
 *
 * `filter: grayscale(1)` alone leaves a neutral grey that only looks
 * deliberate on a neutral theme; against Sunset or Forest it reads as a
 * rendering fault.
 *
 * `grayscale(1) sepia(1) hue-rotate()` is wrong at both ends of the range:
 * sepia maps every luminance onto one fixed brown ramp, so a white cue comes
 * out a beige that still reads as grey, while a dark one -- pushed by the
 * saturate() needed to make the mid-tones show -- drowns in colour.
 *
 * A `mix-blend-mode: color` overlay does the right thing to pixels but the
 * wrong thing to layout: it covers the whole strip, and over the transparent
 * gaps between cues there is no luminance to blend with, so the empty strip
 * turns into a solid band of the tint.
 *
 * So it is computed here instead. There are only a handful of distinct cue
 * colours on screen, the result is a plain hex the existing style helpers
 * already accept, and it costs no filter pass, no blend layer and no extra
 * DOM -- which matters when the strip can hold hundreds of cues.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Rec. 709 luma -- perceptual, so a yellow cue does not read as darker than a blue one. */
function luma({ r, g, b }: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Whether a tint would do anything -- a grey theme has no hue to lend. */
export function hasTintableHue(hex: string): boolean {
  const c = parseHex(hex);
  if (!c) return false;
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 12;
}

/**
 * `source` re-rendered in shades of `tint`.
 *
 * The tint is scaled by the source's own brightness, so the luminance ramp
 * survives: a white cue comes out a light version of the tint, a dark one a
 * dark version, and the two stay as far apart as they started. `strength`
 * mixes between plain greyscale (0) and the full duotone (1).
 */
export function duotoneColor(
  source: string,
  tint: string,
  strength = 1,
): string {
  const src = parseHex(source);
  if (!src) return source;
  const grey = luma(src) * 255;
  const t = parseHex(tint);
  if (!t || !hasTintableHue(tint)) return toHex({ r: grey, g: grey, b: grey });

  // A ramp black -> tint -> white, positioned by the source's brightness.
  //
  // Scaling the tint linearly by luma looks right until the source is
  // brighter than the tint: the channels clip at 255 one at a time, which
  // slews the hue toward white unevenly and makes light cues a different
  // colour from dark ones. Splitting the ramp at the tint's own luma keeps
  // one hue the whole way and desaturates toward white at the top, which is
  // what a duotone does and what the eye expects.
  const tintLuma = Math.max(0.05, Math.min(0.95, luma(t)));
  const l = luma(src);
  const tinted: Rgb =
    l <= tintLuma
      ? { r: (t.r * l) / tintLuma, g: (t.g * l) / tintLuma, b: (t.b * l) / tintLuma }
      : (() => {
          const u = (l - tintLuma) / (1 - tintLuma);
          return {
            r: t.r + (255 - t.r) * u,
            g: t.g + (255 - t.g) * u,
            b: t.b + (255 - t.b) * u,
          };
        })();

  const s = Math.max(0, Math.min(1, strength));
  return toHex({
    r: grey + (tinted.r - grey) * s,
    g: grey + (tinted.g - grey) * s,
    b: grey + (tinted.b - grey) * s,
  });
}
