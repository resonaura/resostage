import { useEffect, useMemo, useRef, useState } from "react";

// Ballistic peak meter: instant attack, release, peak-hold, clip latch at
// the TOP only (never paints the whole bar red). Stereo L/R; solid track
// colour fill via height clip (no CSS mask residue).
const FLOOR_DB = -100;
const RANGE_LOW_DB = -60;
const RANGE_HIGH_DB = 6;
const BAR_DECAY_DB_PER_SEC = 80;
const PEAK_HOLD_SECONDS = 0.8;
const PEAK_DECAY_DB_PER_SEC = 50;
/** Clip latch band as % of bar height (top only). */
const CLIP_BAND_PCT = 6;

const DEFAULT_ACCENT = "#34c759";
/** Single source of truth for "clipping" red -- anything else showing a clip
 * indicator (e.g. MixerScreen's GainPeakReadout box) should import this
 * instead of hardcoding its own shade, so the two always match exactly. */
export const CLIP_COLOR = "#ff3b30";
export const CLIP_GLOW = "0 0 4px rgba(255,59,48,0.7)";

function normFor(db: number): number {
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

function rgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function meterFill(accent: string): string {
  const [r, g, b] = parseColor(accent);
  return rgb(r, g, b);
}

interface ChannelBallistics {
  display: number;
  peak: number;
  holdRemaining: number;
  clipLatched: boolean;
}

function useMeterBallistics(
  db: number,
  /** Optional live getter — read every paint so brief peaks (metronome)
   * are never lost when React state is rAF-coalesced. */
  getLiveDb?: () => number,
): {
  display: number;
  peak: number;
  clipLatched: boolean;
  clearClip: () => void;
} {
  const [display, setDisplay] = useState(FLOOR_DB);
  const [peak, setPeak] = useState(FLOOR_DB);
  const [clipLatched, setClipLatched] = useState(false);
  const dbRef = useRef(db);
  dbRef.current = db;
  const getLiveRef = useRef(getLiveDb);
  getLiveRef.current = getLiveDb;
  const anim = useRef<ChannelBallistics & { lastT: number }>({
    display: FLOOR_DB,
    peak: FLOOR_DB,
    holdRemaining: 0,
    clipLatched: false,
    lastT: 0,
  });

  useEffect(() => {
    let raf = 0;
    const tick = (t: number) => {
      const s = anim.current;
      const dt = s.lastT > 0 ? Math.min(0.25, (t - s.lastT) / 1000) : 1 / 30;
      s.lastT = t;

      const live = getLiveRef.current?.();
      const raw =
        live !== undefined && Number.isFinite(live) ? live : dbRef.current;
      const target = Math.max(raw, FLOOR_DB);
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

      // Clip latch: only when over 0 dBFS; stays until user clicks.
      if (target > 0 && !s.clipLatched) {
        s.clipLatched = true;
        setClipLatched(true);
      }

      setDisplay(s.display);
      setPeak(s.peak);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return {
    display,
    peak,
    clipLatched,
    clearClip: () => {
      anim.current.clipLatched = false;
      setClipLatched(false);
    },
  };
}

// Shared, "held forever" clip state -- distinct from useMeterBallistics'
// own per-channel clip latch (which is fine for a standalone meter, but
// callers wiring a meter together with something else that should clip/clear
// in lockstep -- e.g. MixerScreen's GainPeakReadout box next to the L/R
// bars -- need one clip flag both sides agree on). `maxDb` should be
// max(dbL, dbR): either channel clipping counts.
/** Anything above this is treated as a metering glitch, not a real clip. */
const SANE_PEAK_DB = 24;

export function useChannelClipHold(maxDb: number): {
  clipped: boolean;
  heldPeakDb: number;
  clear: () => void;
} {
  const [clipped, setClipped] = useState(false);
  const [heldPeakDb, setHeldPeakDb] = useState(FLOOR_DB);
  const clippedRef = useRef(false);
  const heldRef = useRef(FLOOR_DB);
  clippedRef.current = clipped;
  heldRef.current = heldPeakDb;

  useEffect(() => {
    // Ignore non-finite / absurd peaks (+400 dB etc.) so a single bad
    // sample after a stem EOF cannot latch the clip hold forever.
    if (!Number.isFinite(maxDb) || maxDb > SANE_PEAK_DB) return;
    if (maxDb > 0) {
      if (!clippedRef.current) {
        setClipped(true);
        setHeldPeakDb(maxDb);
      } else if (maxDb > heldRef.current) {
        setHeldPeakDb(maxDb);
      }
    }
  }, [maxDb]);

  return { clipped, heldPeakDb, clear: () => setClipped(false) };
}

function ChannelBar({
  db,
  getLiveDb,
  vertical,
  className,
  accent,
  clipLatched: clipLatchedOverride,
  onClear,
}: {
  db: number;
  getLiveDb?: () => number;
  vertical: boolean;
  className?: string;
  accent: string;
  /** Externally controlled clip state -- see useChannelClipHold. When
   * provided, overrides this bar's own internal latch for display so it
   * stays in lockstep with whatever else shares the same clip state. */
  clipLatched?: boolean;
  /** Called on click instead of the internal clearClip -- lets a shared
   * clip state clear everywhere at once. */
  onClear?: () => void;
}) {
  const {
    display,
    peak,
    clipLatched: internalClipLatched,
    clearClip: internalClearClip,
  } = useMeterBallistics(db, getLiveDb);
  const clipLatched = clipLatchedOverride ?? internalClipLatched;
  const clearClip = onClear ?? internalClearClip;
  const fillPct = normFor(display) * 100;
  const peakPct = normFor(peak) * 100;
  const fill = useMemo(() => meterFill(accent), [accent]);
  // Hide peak needle once it has fully decayed into the floor.
  const showPeak = peak > RANGE_LOW_DB + 0.5 && peakPct > 0.2;

  return (
    <button
      type="button"
      onClick={clearClip}
      title={clipLatched ? "Peak / clip — click to clear" : undefined}
      className={`relative overflow-hidden rounded-[3px] bg-black/50 ${
        className ?? (vertical ? "h-24 w-1.5" : "h-3 w-full")
      }`}
    >
      {/* Level fill from bottom/left — height/width clip, no mask residue */}
      {fillPct > 0.05 &&
        (vertical ? (
          <div
            className="absolute bottom-0 left-0 right-0"
            style={{ height: `${fillPct}%`, background: fill }}
          />
        ) : (
          <div
            className="absolute top-0 bottom-0 left-0"
            style={{ width: `${fillPct}%`, background: fill }}
          />
        ))}

      {/* Peak hold needle (not a fill trail) */}
      {showPeak &&
        (vertical ? (
          <div
            className="absolute left-0 right-0 h-px z-[5] pointer-events-none"
            style={{
              bottom: `calc(${peakPct}% - 0.5px)`,
              background:
                peak > 0 ? "rgba(255,59,48,0.95)" : "rgba(255,255,255,0.85)",
            }}
          />
        ) : (
          <div
            className="absolute top-0 bottom-0 w-px z-[5] pointer-events-none"
            style={{
              left: `calc(${peakPct}% - 0.5px)`,
              background:
                peak > 0 ? "rgba(255,59,48,0.95)" : "rgba(255,255,255,0.85)",
            }}
          />
        ))}

      {/* Clip / peak-high latch: ONLY the top band, never the whole bar */}
      {clipLatched &&
        (vertical ? (
          <div
            className="absolute top-0 left-0 right-0 z-10 pointer-events-none"
            style={{
              height: `${CLIP_BAND_PCT}%`,
              minHeight: 3,
              background: CLIP_COLOR,
              boxShadow: CLIP_GLOW,
            }}
          />
        ) : (
          <div
            className="absolute top-0 bottom-0 right-0 z-10 pointer-events-none"
            style={{
              width: `${CLIP_BAND_PCT}%`,
              minWidth: 3,
              background: CLIP_COLOR,
              boxShadow: CLIP_GLOW,
            }}
          />
        ))}
    </button>
  );
}

interface LevelMeterBarProps {
  /** Mono peak (legacy). Used for both channels when L/R omitted. */
  db: number;
  dbL?: number;
  dbR?: number;
  /** Live getters — ballistics poll these every paint (no frame drop). */
  getLiveDb?: () => number;
  getLiveDbL?: () => number;
  getLiveDbR?: () => number;
  /** Track/bus colour for the level fill. */
  accent?: string;
  label?: string;
  vertical?: boolean;
  className?: string;
  showValue?: boolean;
  /** Applied to each channel bar (stereo pair sits side-by-side). */
  barClassName?: string;
  /** Force mono single bar (default: stereo). */
  mono?: boolean;
  /** See useChannelClipHold -- when provided, both L and R bars (and mono's
   * single bar) share this clip state instead of latching independently, so
   * they clear together with each other and with anything else wired to the
   * same shared state (e.g. MixerScreen's GainPeakReadout). */
  clipLatched?: boolean;
  onClearClip?: () => void;
}

export function LevelMeterBar({
  db,
  dbL,
  dbR,
  getLiveDb,
  getLiveDbL,
  getLiveDbR,
  accent = DEFAULT_ACCENT,
  label,
  vertical = true,
  className = "",
  showValue = true,
  barClassName,
  mono = false,
  clipLatched,
  onClearClip,
}: LevelMeterBarProps) {
  const left = dbL ?? db;
  const right = dbR ?? db;
  const maxDb = Math.max(left, right);
  const getLeft = getLiveDbL ?? getLiveDb;
  const getRight = getLiveDbR ?? getLiveDb;

  return (
    <div
      className={`flex items-center gap-2 ${vertical ? "h-full" : ""} ${className}`}
    >
      {label && (
        <div className="w-16 shrink-0 truncate text-xs text-foreground/60">
          {label}
        </div>
      )}
      {mono ? (
        <ChannelBar
          db={db}
          getLiveDb={getLiveDb ?? getLeft}
          vertical={vertical}
          className={barClassName}
          accent={accent}
          clipLatched={clipLatched}
          onClear={onClearClip}
        />
      ) : (
        <div
          className={`flex ${
            vertical
              ? "h-full flex-row items-stretch gap-px"
              : "w-full flex-col gap-px"
          }`}
        >
          <ChannelBar
            db={left}
            getLiveDb={getLeft}
            vertical={vertical}
            accent={accent}
            className={
              barClassName ?? (vertical ? "h-full w-1.5" : "h-1.5 w-full")
            }
            clipLatched={clipLatched}
            onClear={onClearClip}
          />
          <ChannelBar
            db={right}
            getLiveDb={getRight}
            vertical={vertical}
            accent={accent}
            className={
              barClassName ?? (vertical ? "h-full w-1.5" : "h-1.5 w-full")
            }
            clipLatched={clipLatched}
            onClear={onClearClip}
          />
        </div>
      )}
      {showValue && (
        <div className="w-12 shrink-0 text-right text-xs tabular-nums text-foreground/60">
          {maxDb <= FLOOR_DB + 1 ? "-inf" : maxDb.toFixed(1)}
        </div>
      )}
    </div>
  );
}
