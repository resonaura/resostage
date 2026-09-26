import React, { memo, useCallback, useMemo, useRef } from "react";
import { useEscRevert } from "../../lib/useEscRevert";
import { FaderLaw } from "../../lib/audioCurves";
import { GAIN_MAX, GAIN_MIN } from "./constants";

interface GainFaderProps {
  /**
   * The dB the fader should draw RIGHT NOW -- already optimistic.
   */
  value: number;
  onChange: (v: number) => void;
  defaultValue?: number;
  step?: number;
  density?: "narrow" | "standard" | "wide";
}


/** Where a dB value sits on the throw: 0 at the bottom, 1 at the top using smooth acoustic taper (0dB at 0.80). */
function normalizedFor(db: number): number {
  if (!Number.isFinite(db) || db <= GAIN_MIN) return 0.0;
  if (db >= GAIN_MAX) return 1.0;
  if (db <= 0.0) {
    const norm = (db - GAIN_MIN) / (0 - GAIN_MIN); // 0 at GAIN_MIN, 1 at 0dB
    return Math.pow(norm, 1.4) * 0.80;
  }
  return 0.80 + (db / GAIN_MAX) * 0.20;
}

// ── How loud a scale mark is drawn ───────────────────────────────────────
const MARK_OPACITY_AT_UNITY = 0.85;
const MARK_OPACITY_AT_EXTREME = 0.18;
/** Furthest any mark sits from unity, in dB -- the fade's full scale. */
const MARK_FADE_RANGE_DB = Math.max(GAIN_MAX, -GAIN_MIN);

function markOpacity(db: number): number {
  const t = Math.min(1, Math.abs(db) / MARK_FADE_RANGE_DB);
  return (
    MARK_OPACITY_AT_EXTREME +
    (MARK_OPACITY_AT_UNITY - MARK_OPACITY_AT_EXTREME) * (1 - t) ** 1.5
  );
}

/**
 * The dB scale down the left of the throw.
 */
const FaderScale = memo(function FaderScale({
  density = "standard",
}: {
  density?: "narrow" | "standard" | "wide";
}) {
  const isNarrow = density === "narrow";
  const markers = isNarrow
    ? [GAIN_MAX, 0, -12, GAIN_MIN]
    : [GAIN_MAX, 6, 0, -6, -18, -36, GAIN_MIN];

  return (
    <div className="pointer-events-none relative h-full w-5 sm:w-6 shrink-0 overflow-hidden">
      {markers.map((markerDb) => {
        const isZero = markerDb === 0;
        const isSix = Math.abs(markerDb) === 6;
        return (
          <div
            key={markerDb}
            className="absolute right-0 flex -translate-y-1/2 items-center gap-0.5 text-foreground"
            style={{
              top: `${(1 - normalizedFor(markerDb)) * 100}%`,
              opacity: isZero ? 1.0 : markOpacity(markerDb),
            }}
          >
            <span
              className={`font-mono text-[8px] leading-none tracking-tight tabular-nums ${
                isZero ? "font-bold text-foreground" : "text-foreground/60"
              }`}
            >
              {markerDb === GAIN_MIN
                ? "-∞"
                : markerDb > 0
                  ? `+${markerDb}`
                  : markerDb}
            </span>
            <div
              className={`h-px rounded-full ${
                isZero
                  ? "bg-foreground w-1.5"
                  : isSix
                    ? "bg-foreground/80 w-1"
                    : "bg-foreground/50 w-0.5"
              }`}
            />
          </div>
        );
      })}
    </div>
  );
});

/**
 * Track, fill, 0 dB unity detent tick, and cap.
 */
const FaderVisuals = memo(function FaderVisuals({
  normalized,
}: {
  normalized: number;
}) {
  const zeroPos = FaderLaw.unityPosition; // 0.80
  return (
    <>
      {/* Slot: cut INTO the strip */}
      <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-black/60 shadow-inner" />

      {/* 0 dB unity detent mark on rail */}
      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 h-[1px] w-3 bg-foreground/45 rounded-full"
        style={{ top: `${(1 - zeroPos) * 100}%` }}
        title="0 dB Unity Detent"
      />

      {/* Travelled part of the throw */}
      <div
        className="pointer-events-none absolute bottom-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-foreground/25"
        style={{ height: `${normalized * 100}%` }}
      />

      {/* Cap */}
      <div
        className="pointer-events-none absolute left-1/2 flex h-5 w-3.5 sm:h-6 sm:w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[3px] bg-gradient-to-b from-[#3a3f4b] to-[#1c1e24] shadow-[0_1px_4px_rgba(0,0,0,0.6)] border border-white/20"
        style={{ top: `${(1 - normalized) * 100}%` }}
      >
        <div className="h-0.5 w-2 rounded-full bg-white/70" />
      </div>
    </>
  );
});

export const GainFader = memo<GainFaderProps>(function GainFader({
  value,
  onChange,
  defaultValue = 0,
  step = 0.1,
  density = "standard",
}) {
  const escRevert = useEscRevert(() => value, onChange);
  const trackRef = useRef<HTMLDivElement>(null);

  const normalized = useMemo(() => normalizedFor(value), [value]);

  const calculateValueFromPointer = useCallback(
    (clientY: number, isFine = false) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      if (rect.height === 0) return;

      const relativeY = clientY - rect.top;
      const rawPct = 1 - relativeY / rect.height;
      const clampedPct = Math.max(0, Math.min(1, rawPct));

      let db = GAIN_MIN;
      if (clampedPct <= 0.015) {
        db = GAIN_MIN;
      } else if (clampedPct <= 0.80) {
        const norm = Math.pow(clampedPct / 0.80, 1 / 1.4);
        db = GAIN_MIN + norm * (0 - GAIN_MIN);
      } else {
        const t = (clampedPct - 0.80) / 0.20;
        db = t * GAIN_MAX;
      }

      const effectiveStep = isFine ? 0.05 : step;
      const steppedVal = Math.round(db / effectiveStep) * effectiveStep;
      const finalVal = Math.max(GAIN_MIN, Math.min(GAIN_MAX, steppedVal));

      onChange(finalVal);
    },
    [onChange, step],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.altKey) {
      e.preventDefault();
      onChange(defaultValue);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    calculateValueFromPointer(e.clientY, e.metaKey || e.shiftKey || e.ctrlKey);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      calculateValueFromPointer(e.clientY, e.metaKey || e.shiftKey || e.ctrlKey);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onChange(defaultValue);
    },
    [onChange, defaultValue],
  );

  return (
    // The scale and the throw are siblings in one flex row, both spanning the
    // same padded box -- so a tick at 0 dB is at the same height as the cap
    // when the fader reads 0 dB, without either side restating the padding.
    <div
      className="flex h-full min-h-[110px] w-full max-w-[4.5rem] touch-none select-none items-stretch py-1.5"
      title="Double-click to reset"
      {...escRevert}
      onDoubleClick={handleDoubleClick}
    >
      <div className="relative h-full w-5 sm:w-6 shrink-0 my-3 pointer-events-none">
        <FaderScale density={density} />
      </div>

      <div
        ref={trackRef}
        // A vertical fader drags up and down; `pointer` said "click me".
        className="relative flex-1 cursor-ns-resize my-3"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <FaderVisuals normalized={normalized} />
      </div>
    </div>
  );
});
