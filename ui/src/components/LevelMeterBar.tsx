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

// Glow around the clip band, drawn via ctx.shadow* to match the DOM
// version's box-shadow (CLIP_GLOW: "0 0 4px rgba(255,59,48,0.7)").
const CLIP_GLOW_BLUR_PX = 4;
const CLIP_GLOW_COLOR = "rgba(255,59,48,0.7)";

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dbRef = useRef(db);
  dbRef.current = db;
  const getLiveRef = useRef(getLiveDb);
  getLiveRef.current = getLiveDb;
  const verticalRef = useRef(vertical);
  verticalRef.current = vertical;
  const clipOverrideRef = useRef(clipLatchedOverride);
  clipOverrideRef.current = clipLatchedOverride;

  const [internalClipLatched, setInternalClipLatched] = useState(false);
  const clipLatched = clipLatchedOverride ?? internalClipLatched;
  const clearClip =
    onClear ??
    (() => {
      anim.current.clipLatched = false;
      setInternalClipLatched(false);
    });

  const fill = useMemo(() => meterFill(accent), [accent]);
  const fillRef = useRef(fill);
  fillRef.current = fill;

  const anim = useRef<ChannelBallistics & { lastT: number }>({
    display: FLOOR_DB,
    peak: FLOOR_DB,
    holdRemaining: 0,
    clipLatched: false,
    lastT: 0,
  });

  // Draw loop: fully imperative canvas painting, no React state/re-render
  // per frame -- this is the whole point of moving off DOM/CSS divs (each
  // of which used to cost a React reconciliation + style/layout pass at
  // 60fps, multiplied by every track/bus strip on screen at once).
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let cssW = 0;
    let cssH = 0;
    // Only reallocate the backing store when the integer CSS size changes.
    // Vertical timeline zoom used to ResizeObserver-fire every subpixel step,
    // and assigning canvas.width/height clears the bitmap → visible flicker.
    let lastBw = 0;
    let lastBh = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const nextW = Math.max(1, Math.round(rect.width));
      const nextH = Math.max(1, Math.round(rect.height));
      cssW = nextW;
      cssH = nextH;
      const bw = Math.max(1, Math.round(nextW * dpr));
      const bh = Math.max(1, Math.round(nextH * dpr));
      if (bw === lastBw && bh === lastBh) return;
      lastBw = bw;
      lastBh = bh;
      canvas.width = bw;
      canvas.height = bh;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    const tick = (t: number) => {
      const s = anim.current;
      const dt = s.lastT > 0 ? Math.min(0.25, (t - s.lastT) / 1000) : 1 / 30;
      s.lastT = t;

      // Prefer live sampler (may consume interval-max). Fall back to prop.
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

      // Clip latch: only when over 0 dBFS; stays until user clicks. Synced
      // into React state (rare event, not per-frame) so the "click to
      // clear" affordance/title can react to it.
      if (target > 0 && !s.clipLatched) {
        s.clipLatched = true;
        setInternalClipLatched(true);
      }

      const v = verticalRef.current;
      const fillPct = normFor(s.display);
      const peakPct = normFor(s.peak);
      const showPeak = s.peak > RANGE_LOW_DB + 0.5 && peakPct > 0.002;
      const latched = clipOverrideRef.current ?? s.clipLatched;

      ctx.clearRect(0, 0, cssW, cssH);

      // Level fill from bottom/left, same as the old height/width-clipped div.
      if (fillPct > 0.0005) {
        ctx.fillStyle = fillRef.current;
        if (v) ctx.fillRect(0, cssH * (1 - fillPct), cssW, cssH * fillPct);
        else ctx.fillRect(0, 0, cssW * fillPct, cssH);
      }

      // Peak hold needle (1 CSS px line, not a fill trail).
      if (showPeak) {
        ctx.fillStyle =
          s.peak > 0 ? "rgba(255,59,48,0.95)" : "rgba(255,255,255,0.85)";
        if (v) {
          const y = cssH * (1 - peakPct);
          ctx.fillRect(0, Math.min(cssH - 1, Math.max(0, y - 0.5)), cssW, 1);
        } else {
          const x = cssW * peakPct;
          ctx.fillRect(Math.min(cssW - 1, Math.max(0, x - 0.5)), 0, 1, cssH);
        }
      }

      // Clip / peak-high latch: ONLY the top/right band, never the whole bar.
      if (latched) {
        ctx.save();
        ctx.shadowColor = CLIP_GLOW_COLOR;
        ctx.shadowBlur = CLIP_GLOW_BLUR_PX;
        ctx.fillStyle = CLIP_COLOR;
        if (v) {
          const bandH = Math.max(3, cssH * (CLIP_BAND_PCT / 100));
          ctx.fillRect(0, 0, cssW, bandH);
        } else {
          const bandW = Math.max(3, cssW * (CLIP_BAND_PCT / 100));
          ctx.fillRect(cssW - bandW, 0, bandW, cssH);
        }
        ctx.restore();
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <button
      type="button"
      onClick={clearClip}
      title={clipLatched ? "Peak / clip — click to clear" : undefined}
      className={`relative block overflow-hidden rounded-[3px] bg-black/50 ${
        className ?? (vertical ? "h-24 w-1.5" : "h-3 w-full")
      }`}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
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
