/**
 * Pulling a colour toward the theme without throwing it away.
 *
 * Used by the timeline's light lanes and by the audio-mode hint strip, where
 * cue colours are the rig's real stage output -- fully saturated red, cyan,
 * white -- and would otherwise shout louder than the audio regions beside
 * them, in a palette that has nothing to do with the theme.
 *
 * ## What this is not
 *
 * It is not a duotone. Replacing every hue with the theme's makes a lane of
 * distinct cues read as one flat block, and the whole point of a cue's colour
 * is telling it apart from the next one. So the source hue is rotated PART of
 * the way toward the theme -- far enough that the lane reads as one family,
 * not so far that red and blue become the same swatch.
 *
 * It is also not a filter chain. `grayscale() sepia() hue-rotate()` was tried:
 * sepia flattens every luminance onto one brown ramp, so light cues come out
 * grey and dark ones drown in colour. A `mix-blend-mode` overlay was tried
 * too: it works on pixels but covers whole elements, so it paints the gaps
 * between cues and squares off their rounded corners.
 *
 * Doing it in colour space avoids both, costs no filter pass and no extra
 * DOM, and hands back a plain colour the existing style helpers accept.
 *
 * ## Contrast
 *
 * Lightness is compressed into a band rather than passed through. A pure
 * white cue at full lightness glares on a dark timeline -- it is the
 * brightest thing on screen by a wide margin, for a strip that is meant to be
 * reference material. The band keeps the ordering (bright cues still read as
 * brighter) while taking the top off.
 */

interface Hsl {
  h: number; // degrees
  s: number; // 0..1
  l: number; // 0..1
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

/** Shortest way round the wheel from `a` to `b`, by `t`. */
function mixHue(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

export interface ThemeAdaptOptions {
  /** How far to rotate the source hue toward the theme's. 0 keeps it, 1 replaces it. */
  hueBlend?: number;
  /** How far to pull saturation toward the theme's. */
  satBlend?: number;
  /** Lightness band. The top is what stops a white cue from glaring. */
  lightMin?: number;
  lightMax?: number;
}

const DEFAULTS: Required<ThemeAdaptOptions> = {
  // Deliberately small. Half way sounded reasonable and was not: against a
  // warm theme it dragged red, orange and amber into the same few degrees,
  // and telling a red cue from its neighbours is most of what a cue colour is
  // for. A quarter takes the edge off a raw stage colour while leaving the
  // wheel recognisably spread out.
  hueBlend: 0.25,
  // Most of the "belongs to this theme" feeling comes from here and from the
  // lightness band, not from moving hues around.
  satBlend: 0.4,
  lightMin: 0.12,
  lightMax: 0.68,
};

/** Whether a colour has a hue worth blending toward -- a grey theme has none. */
export function hasTintableHue(hex: string): boolean {
  const c = parseHex(hex);
  if (!c) return false;
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 12;
}

/**
 * `source`, still recognisably itself, but leaning toward `theme` and with
 * its brightness pulled into a band that will not glare.
 *
 * A themeless theme colour (Mono) skips the hue and saturation work and only
 * gets the contrast treatment -- there is nothing to lean toward, and the
 * glare problem is the theme's own or not.
 */
export function themeAdaptedColor(
  source: string,
  theme: string,
  opts: ThemeAdaptOptions = {},
): string {
  const src = parseHex(source);
  if (!src) return source;
  const o = { ...DEFAULTS, ...opts };

  const a = rgbToHsl(src.r, src.g, src.b);
  const light = o.lightMin + (o.lightMax - o.lightMin) * a.l;

  const t = parseHex(theme);
  if (!t || !hasTintableHue(theme)) return hslToHex({ ...a, l: light });

  const b = rgbToHsl(t.r, t.g, t.b);
  // A colourless source has no hue to keep, so it simply takes the theme's --
  // which is what makes a white cue read as a light tint of the theme rather
  // than as a hole punched in the strip.
  const hue = a.s < 0.05 ? b.h : mixHue(a.h, b.h, o.hueBlend);
  const sat = a.s + (b.s - a.s) * o.satBlend;

  return hslToHex({ h: hue, s: Math.max(0, Math.min(1, sat)), l: light });
}
