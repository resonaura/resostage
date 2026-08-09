import { useEffect, useMemo, useRef, useState } from "react";
import { addRafTask } from "../../lib/rafLoop";
import {
  clipColor,
  CLIP_GLOW_BLUR_PX,
  clipGlowColor,
  peakNeedleColor,
  createBallistics,
  FLOOR_DB,
  meterFill,
  normFor,
  RANGE_LOW_DB,
  stepBallistics,
} from "./meterBallistics";

// Ballistic peak meter: instant attack, release, peak-hold, clip latch at
// the TOP only (never paints the whole bar red). Stereo L/R; solid track
// colour fill via height clip (no CSS mask residue). The ballistics
// themselves are shared with the timeline's MeterFader -- see
// ./meterBallistics.
/** Clip latch band as % of bar height (top only). */
const CLIP_BAND_PCT = 6;

const DEFAULT_ACCENT = "#34c759";

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

  const anim = useRef(createBallistics());

  // Draw loop: fully imperative canvas painting, no React state/re-render
  // per frame -- this is the whole point of moving off DOM/CSS divs (each
  // of which used to cost a React reconciliation + style/layout pass at
  // 60fps, multiplied by every track/bus strip on screen at once).
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    // Everything the last painted frame depended on. A meter at rest -- the
    // overwhelmingly common state on a stopped transport, and true of most
    // strips even mid-song -- then costs one comparison per frame instead of
    // a clear plus two or three fills, multiplied by every bar on screen.
    let paintedFill = Number.NaN;
    let paintedPeak = Number.NaN;
    let paintedShowPeak = false;
    let paintedLatched = false;
    let paintedFillStyle = "";
    let paintedW = 0;
    let paintedH = 0;
    let paintedVertical = verticalRef.current;
    /** Forget the last-painted snapshot -- next frame must redraw. */
    const invalidate = () => {
      paintedFill = Number.NaN;
    };

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
      // Reallocating the backing store clears it. Without this the skip check
      // below would happily conclude "nothing moved" and leave a blank bar
      // after any resize or DPI change.
      invalidate();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const tick = (_nowMs: number, dt: number) => {
      const s = anim.current;

      // Prefer live sampler (may consume interval-max). Fall back to prop.
      const live = getLiveRef.current?.();
      const raw =
        live !== undefined && Number.isFinite(live) ? live : dbRef.current;
      // Clip latch is synced into React state on the frame it flips (a rare
      // event, not per-frame) so the "click to clear" affordance/title can
      // react to it.
      if (stepBallistics(s, raw, dt)) setInternalClipLatched(true);

      const v = verticalRef.current;
      const fillPct = normFor(s.display);
      const peakPct = normFor(s.peak);
      const showPeak = s.peak > RANGE_LOW_DB + 0.5 && peakPct > 0.002;
      const latched = clipOverrideRef.current ?? s.clipLatched;
      const fillStyle = fillRef.current;

      // Sub-pixel movement is not worth a repaint; quantize to the bar's own
      // pixel grid so "unchanged" means "identical pixels", not "close".
      const span = Math.max(1, v ? cssH : cssW);
      const qFill = Math.round(fillPct * span);
      const qPeak = Math.round(peakPct * span);
      if (
        qFill === paintedFill &&
        qPeak === paintedPeak &&
        showPeak === paintedShowPeak &&
        latched === paintedLatched &&
        fillStyle === paintedFillStyle &&
        cssW === paintedW &&
        cssH === paintedH &&
        v === paintedVertical
      ) {
        return;
      }
      paintedFill = qFill;
      paintedPeak = qPeak;
      paintedShowPeak = showPeak;
      paintedLatched = latched;
      paintedFillStyle = fillStyle;
      paintedW = cssW;
      paintedH = cssH;
      paintedVertical = v;

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
          peakNeedleColor(s.peak > 0);
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
        ctx.shadowColor = clipGlowColor();
        ctx.shadowBlur = CLIP_GLOW_BLUR_PX;
        ctx.fillStyle = clipColor();
        if (v) {
          const bandH = Math.max(3, cssH * (CLIP_BAND_PCT / 100));
          ctx.fillRect(0, 0, cssW, bandH);
        } else {
          const bandW = Math.max(3, cssW * (CLIP_BAND_PCT / 100));
          ctx.fillRect(cssW - bandW, 0, bandW, cssH);
        }
        ctx.restore();
      }
    };
    const stop = addRafTask(tick);
    return () => {
      stop();
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
