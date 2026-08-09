/**
 * The shared behaviour of every level meter in the app: how fast a bar falls,
 * how long a peak is held, when a clip latches, and how a dB value maps onto
 * the length of a bar.
 *
 * It lives apart from LevelMeterBar because it is no longer the only meter.
 * The timeline's track headers draw a meter that is also the volume fader (see
 * MeterFader), and two meters side by side that decay at even slightly
 * different rates read as one of them being broken -- so the ballistics are
 * one implementation both call, rather than two copies that agree today.
 *
 * Everything here is deliberately free of React and of the DOM: it is stepped
 * from a rAF task and painted to canvas.
 */

/** Anything quieter than this is silence as far as a meter is concerned. */
export const FLOOR_DB = -100;
/** Bottom of the drawn range -- a bar at this level is empty. */
export const RANGE_LOW_DB = -60;
/** Top of the drawn range -- a bar at this level is full. */
export const RANGE_HIGH_DB = 6;
const BAR_DECAY_DB_PER_SEC = 80;
const PEAK_HOLD_SECONDS = 0.8;
const PEAK_DECAY_DB_PER_SEC = 50;

/** Single source of truth for "clipping" red -- anything else showing a clip
 * indicator (e.g. the mixer's GainPeakReadout box) should import this instead
 * of hardcoding its own shade, so the two always match exactly. */
export const CLIP_COLOR = "#ff3b30";
export const CLIP_GLOW = "0 0 4px rgba(255,59,48,0.7)";
/** The same glow, split for ctx.shadow* (canvas has no box-shadow). */
export const CLIP_GLOW_BLUR_PX = 4;
export const CLIP_GLOW_COLOR = "rgba(255,59,48,0.7)";

const DEFAULT_ACCENT = "#34c759";

/** Where `db` sits on the drawn range, 0 (empty) to 1 (full). */
export function normFor(db: number): number {
  return Math.max(
    0,
    Math.min(1, (db - RANGE_LOW_DB) / (RANGE_HIGH_DB - RANGE_LOW_DB)),
  );
}

function parseColor(input: string): [number, number, number] {
  const s = input.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length >= 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return parseColor(DEFAULT_ACCENT);
}

/** A track/bus colour as an opaque `rgb()` canvas can fill with. */
export function meterFill(accent: string = DEFAULT_ACCENT): string {
  const [r, g, b] = parseColor(accent);
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

export interface MeterBallistics {
  /** Level the bar is currently drawn at, in dB. */
  display: number;
  /** Peak-hold needle position, in dB. */
  peak: number;
  /** Seconds left before the held peak starts falling. */
  holdRemaining: number;
  /** Latched at the first sample over 0 dBFS; only a user click clears it. */
  clipLatched: boolean;
}

export function createBallistics(): MeterBallistics {
  return {
    display: FLOOR_DB,
    peak: FLOOR_DB,
    holdRemaining: 0,
    clipLatched: false,
  };
}

/**
 * Advance one frame. Attack is instant (a transient must never be missed),
 * release is a fixed dB/second slope, and the peak needle holds before it
 * falls at its own slower rate.
 *
 * Returns true when the clip latch flipped on this step, so the caller can
 * sync that rare event into React state without touching state per frame.
 */
export function stepBallistics(
  s: MeterBallistics,
  rawDb: number,
  dt: number,
): boolean {
  const target = Math.max(rawDb, FLOOR_DB);

  s.display =
    target >= s.display
      ? target
      : Math.max(target, s.display - BAR_DECAY_DB_PER_SEC * dt);

  if (target >= s.peak) {
    s.peak = target;
    s.holdRemaining = PEAK_HOLD_SECONDS;
  } else if (s.holdRemaining > 0) {
    s.holdRemaining -= dt;
  } else {
    s.peak = Math.max(target, s.peak - PEAK_DECAY_DB_PER_SEC * dt);
  }

  if (target > 0 && !s.clipLatched) {
    s.clipLatched = true;
    return true;
  }
  return false;
}
