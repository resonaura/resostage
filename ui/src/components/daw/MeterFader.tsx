import { memo, useCallback, useEffect, useRef } from "react";
import { addRafTask } from "../../lib/rafLoop";
import { useEscRevert } from "../../lib/useEscRevert";
import {
  clipColor,
  CLIP_GLOW_BLUR_PX,
  clipGlowColor,
  peakNeedleColor,
  createBallistics,
  meterFill,
  normFor,
  stepBallistics,
} from "./meterBallistics";

/**
 * Volume fader and level meter as one control, the way Logic draws a track
 * header: the rounded bar IS the meter, and the grey ball riding on it is the
 * fader handle.
 *
 * The timeline used to show these as two separate widgets -- a thin vertical
 * meter beside the track name and a slider on its own row underneath -- which
 * cost two rows of a 56px lane to say one thing about one track. Combining
 * them also puts the number you are setting on top of the number you are
 * reacting to, which is the whole reason a console puts a meter next to a
 * fader in the first place.
 *
 * The handle is deliberately the neutral `--default` grey at partial opacity
 * rather than the track colour: it sits ON the meter, so anything saturated
 * competes with the fill it is covering, and a translucent handle lets you see
 * the level underneath it.
 *
 * L and R are drawn as two rows that TOUCH: no gap, no hairline between them.
 * At the ~15px a track header can spare, a divider costs a real share of the
 * meter and reads as chrome rather than as information -- the two channels are
 * already told apart by their own lengths, which is the only thing the split
 * is there to show.
 */

/** Clip latch band as a share of the bar's width (right end only). */
const CLIP_BAND_PCT = 4;
/** How far the handle stands proud of the bar, in CSS px (total, both sides). */
const HANDLE_OVERSIZE_PX = 4;

export interface MeterFaderProps {
  /** Gain in dB -- already optimistic; see useLiveValue. */
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Where a double-click puts the fader. */
  defaultValue?: number;
  onChange: (v: number) => void;
  /** Last known peaks from the state frame; the live getters win when given. */
  dbL: number;
  dbR: number;
  /** Sampled every paint, straight off the binary telemetry -- no re-render. */
  getLiveDbL?: () => number;
  getLiveDbR?: () => number;
  /** Track colour for the meter fill. */
  accent?: string;
  /** Height of the bar in CSS px. The handle is sized from it. */
  height?: number;
  className?: string;
  title?: string;
  "aria-label"?: string;
}

export const MeterFader = memo(function MeterFader({
  value,
  min,
  max,
  step = 0.5,
  defaultValue = 0,
  onChange,
  dbL,
  dbR,
  getLiveDbL,
  getLiveDbR,
  accent,
  height = 12,
  className = "",
  title,
  "aria-label": ariaLabel = "Volume",
}: MeterFaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const escRevert = useEscRevert(() => value, onChange);

  // Everything the paint loop reads lives behind a ref: the loop is installed
  // once and must never be a reason for this component to re-render.
  const dbRef = useRef({ l: dbL, r: dbR });
  dbRef.current = { l: dbL, r: dbR };
  const getLiveRef = useRef({ l: getLiveDbL, r: getLiveDbR });
  getLiveRef.current = { l: getLiveDbL, r: getLiveDbR };
  const fillRef = useRef(meterFill(accent));
  fillRef.current = meterFill(accent);

  const percent = Math.max(0, Math.min(1, (value - min) / (max - min)));
  // The handle stands a little proud of the bar, so the row is as tall as the
  // handle and the bar is centred inside it. Clipping the meter to a rounded
  // pill and letting the handle overhang cannot be the same element.
  const handleSize = height + HANDLE_OVERSIZE_PX;

  const commitFromPointer = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      // Map the pointer onto the HANDLE's travel, not the row's width: the
      // handle is inset by its own radius at both ends, and without matching
      // that here the ball lags the cursor near either end.
      const radius = handleSize / 2;
      const usable = Math.max(1, rect.width - radius * 2);
      const pct = Math.max(
        0,
        Math.min(1, (clientX - rect.left - radius) / usable),
      );
      const raw = min + pct * (max - min);
      const stepped = Math.round(raw / step) * step;
      onChange(Math.max(min, Math.min(max, stepped)));
    },
    [min, max, step, onChange, handleSize],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const left = createBallistics();
    const right = createBallistics();

    // Last painted frame, quantised to the bar's own pixel grid: a header full
    // of stopped tracks then costs one comparison per lane per frame instead
    // of a clear plus four fills.
    let paintedL = Number.NaN;
    let paintedR = Number.NaN;
    let paintedPeakL = Number.NaN;
    let paintedPeakR = Number.NaN;
    let paintedLatched = false;
    let paintedFill = "";
    let paintedW = 0;
    let paintedH = 0;
    const invalidate = () => {
      paintedL = Number.NaN;
    };

    let cssW = 0;
    let cssH = 0;
    let lastBw = 0;
    let lastBh = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cssW = Math.max(1, Math.round(rect.width));
      cssH = Math.max(1, Math.round(rect.height));
      const bw = Math.max(1, Math.round(cssW * dpr));
      const bh = Math.max(1, Math.round(cssH * dpr));
      // Assigning width/height clears the bitmap, so only do it when the
      // integer size actually changed -- vertical zoom fires the observer on
      // every subpixel step and the meters would flicker.
      if (bw === lastBw && bh === lastBh) return;
      lastBw = bw;
      lastBh = bh;
      canvas.width = bw;
      canvas.height = bh;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      invalidate();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const sample = (live: (() => number) | undefined, fallback: number) => {
      const v = live?.();
      return v !== undefined && Number.isFinite(v) ? v : fallback;
    };

    /** Above this, the peak needle turns red -- 0 dBFS on the drawn range. */
    const overNorm = normFor(0);

    const tick = (_nowMs: number, dt: number) => {
      stepBallistics(left, sample(getLiveRef.current.l, dbRef.current.l), dt);
      stepBallistics(right, sample(getLiveRef.current.r, dbRef.current.r), dt);

      const fillL = normFor(left.display);
      const fillR = normFor(right.display);
      const peakL = normFor(left.peak);
      const peakR = normFor(right.peak);
      const latched = left.clipLatched || right.clipLatched;
      const fill = fillRef.current;

      const qL = Math.round(fillL * cssW);
      const qR = Math.round(fillR * cssW);
      const qPL = Math.round(peakL * cssW);
      const qPR = Math.round(peakR * cssW);
      if (
        qL === paintedL &&
        qR === paintedR &&
        qPL === paintedPeakL &&
        qPR === paintedPeakR &&
        latched === paintedLatched &&
        fill === paintedFill &&
        cssW === paintedW &&
        cssH === paintedH
      ) {
        return;
      }
      paintedL = qL;
      paintedR = qR;
      paintedPeakL = qPL;
      paintedPeakR = qPR;
      paintedLatched = latched;
      paintedFill = fill;
      paintedW = cssW;
      paintedH = cssH;

      ctx.clearRect(0, 0, cssW, cssH);

      // L on top, R below, meeting in the middle -- the row boundary is where
      // the two fills stop, not a drawn line.
      const rowH = cssH / 2;
      const rows: [number, number, number][] = [
        [0, fillL, peakL],
        [rowH, fillR, peakR],
      ];

      for (const [y, levelPct, peakPct] of rows) {
        if (levelPct > 0.0005) {
          ctx.fillStyle = fill;
          ctx.fillRect(0, y, cssW * levelPct, rowH);
        }
        // Peak hold needle (1 CSS px line, not a fill trail).
        if (peakPct > 0.002) {
          ctx.fillStyle =
            peakPct >= overNorm
              ? peakNeedleColor(true)
              : peakNeedleColor(false);
          const x = Math.min(cssW - 1, Math.max(0, cssW * peakPct - 0.5));
          ctx.fillRect(x, y, 1, rowH);
        }
      }

      // Clip latch: the right-hand band only, never the whole bar.
      if (latched) {
        ctx.save();
        ctx.shadowColor = clipGlowColor();
        ctx.shadowBlur = CLIP_GLOW_BLUR_PX;
        ctx.fillStyle = clipColor();
        const bandW = Math.max(3, cssW * (CLIP_BAND_PCT / 100));
        ctx.fillRect(cssW - bandW, 0, bandW, cssH);
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
    <div
      ref={trackRef}
      role="slider"
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title={title ?? "Drag to set level · double-click to reset"}
      // No overflow clipping here: the row is as tall as the handle, and the
      // handle is what overhangs. Clipping lives on the bar inside.
      className={`relative flex-1 cursor-pointer touch-none select-none ${className}`}
      style={{ height: handleSize }}
      {...escRevert}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        escRevert.onPointerDown(e);
        commitFromPointer(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          commitFromPointer(e.clientX);
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        escRevert.onPointerUp();
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(defaultValue);
      }}
    >
      <div
        className="absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-black/50 ring-1 ring-inset ring-white/5"
        style={{ height }}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>

      {/* The handle. Translucent so the level under it stays readable, and
          inset by its own radius so it never hangs off either end. */}
      <div
        className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground/25 shadow-[0_1px_3px_rgba(0,0,0,0.5)]"
        style={{
          height: handleSize,
          width: handleSize,
          left: `calc(${handleSize / 2}px + (100% - ${handleSize}px) * ${percent})`,
          backgroundColor:
            "color-mix(in oklab, var(--default) 78%, transparent)",
        }}
      />
    </div>
  );
});
