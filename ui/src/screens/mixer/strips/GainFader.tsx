// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEscRevert } from "@/hooks/useEscRevert";
import { FaderLaw } from "@/screens/mixer/logic/audioCurves";
import { GAIN_MAX, GAIN_MIN } from "@/screens/mixer/logic/constants";

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

/**
 * Where a dB value sits on the throw: 0 at the bottom (-60 dB / -inf), 1 at the top (+12 dB).
 * Calibrated quadratic taper matching DAW console engineering:
 * - +12 dB = 1.00
 * - +6 dB  = 0.90
 * - 0 dB   = 0.80 (unity position)
 * - -6 dB  = ~0.65
 * - -12 dB = ~0.51 (physical midpoint of fader throw)
 * - -18 dB = ~0.39
 * - -24 dB = ~0.29
 * - -36 dB = ~0.13
 * - -60 dB = 0.00 (-inf / silence)
 */
function normalizedFor(db: number): number {
  if (!Number.isFinite(db) || db <= GAIN_MIN) return 0.0;
  if (db >= GAIN_MAX) return 1.0;
  if (db <= 0.0) {
    const norm = (db - GAIN_MIN) / (0 - GAIN_MIN); // 0 at GAIN_MIN (-60), 1 at 0 dB
    return norm * norm * FaderLaw.unityPosition;
  }
  return (
    FaderLaw.unityPosition + (db / GAIN_MAX) * (1.0 - FaderLaw.unityPosition)
  );
}

const ALL_MARKERS = [GAIN_MAX, 6, 0, -6, -12, -18, -24, -36, GAIN_MIN] as const;

/**
 * The dB scale down the left of the throw.
 * Automatically adapts label density based on available vertical height and mixer strip density
 * to prevent overlapping or cramped text.
 */
const FaderScale = memo(function FaderScale({
  density = "standard",
  trackHeight = 200,
}: {
  density?: "narrow" | "standard" | "wide";
  trackHeight?: number;
}) {
  const isNarrow = density === "narrow";
  const isCramped = isNarrow || trackHeight < 145;
  const isMedium = !isCramped && trackHeight < 195;

  const showLabel = (db: number) => {
    if (isCramped) {
      return db === GAIN_MAX || db === 0 || db === -12 || db === GAIN_MIN;
    }
    if (isMedium) {
      return (
        db === GAIN_MAX ||
        db === 6 ||
        db === 0 ||
        db === -6 ||
        db === -12 ||
        db === -24 ||
        db === GAIN_MIN
      );
    }
    return true;
  };

  return (
    <div
      className={`pointer-events-none relative h-full shrink-0 select-none ${
        isNarrow ? "w-3.5" : "w-5 sm:w-5.5"
      }`}
    >
      {ALL_MARKERS.map((markerDb) => {
        const isZero = markerDb === 0;
        const isMajor =
          isZero ||
          Math.abs(markerDb) === 6 ||
          markerDb === 12 ||
          markerDb === -12;
        const isBottom = markerDb === GAIN_MIN;
        const hasLabel = showLabel(markerDb);

        return (
          <div
            key={markerDb}
            className="absolute right-0 flex -translate-y-1/2 items-center gap-0.5"
            style={{
              top: `${(1 - normalizedFor(markerDb)) * 100}%`,
              opacity: isZero ? 1.0 : isMajor ? 0.9 : 0.6,
            }}
          >
            {hasLabel && (
              <span
                className={`font-mono leading-none tracking-tight tabular-nums ${
                  isNarrow ? "text-[7.5px]" : "text-[8px]"
                } ${isZero ? "font-bold text-foreground" : "text-muted"}`}
              >
                {isBottom ? "-∞" : markerDb > 0 ? `+${markerDb}` : markerDb}
              </span>
            )}
            <div
              className={`rounded-full ${
                isZero
                  ? "bg-foreground w-2 h-[1.5px]"
                  : isMajor
                    ? "bg-default-foreground/60 w-1.5 h-px"
                    : "bg-default-foreground/35 w-1 h-px"
              }`}
            />
          </div>
        );
      })}
    </div>
  );
});

/**
 * Track rail slot, fill, and styled fader cap.
 * Uses HeroUI theme design tokens (surface, default, border, foreground, accent).
 */
const FaderVisuals = memo(function FaderVisuals({
  normalized,
  density = "standard",
}: {
  normalized: number;
  density?: "narrow" | "standard" | "wide";
}) {
  const isNarrow = density === "narrow";
  const isWide = density === "wide";

  return (
    <>
      {/* Slot: cut INTO the strip */}
      <div className="absolute inset-y-0 left-1/2 w-0.75 -translate-x-1/2 rounded-md bg-black/50" />

      {/* Travelled part of the throw */}
      <div
        className="pointer-events-none absolute bottom-0 left-1/2 w-0.75 -translate-x-1/2 rounded-full bg-default-foreground/25"
        style={{ height: `${normalized * 100}%` }}
      />

      {/* Cap - styled with HeroUI surface-secondary and surface tones */}
      <div
        className={`pointer-events-none absolute left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md bg-linear-to-b from-surface-secondary to-surface shadow-[0_2px_6px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.08)] border border-default/50 transition-colors ${
          isNarrow
            ? "h-5 w-3.5"
            : isWide
              ? "h-6 w-5"
              : "h-5.5 w-4 sm:h-6 sm:w-4.5"
        }`}
        style={{ top: `${(1 - normalized) * 100}%` }}
      >
        {/* Tactile DAW cap grip lines */}
        <div className="flex flex-col items-center gap-0.5">
          <div className="h-px w-2 rounded-full bg-default-foreground/20" />
          <div className="h-0.5 w-2 sm:w-2.5 rounded-full bg-foreground/90 shadow-[0_0_2px_rgba(255,255,255,0.4)]" />
          <div className="h-px w-2 rounded-full bg-default-foreground/20" />
        </div>
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
  const [trackHeight, setTrackHeight] = useState<number>(200);

  // Monitor physical track height for adaptive scale decimation
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.height > 0) {
          setTrackHeight(entry.contentRect.height);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
      if (clampedPct <= 0.008) {
        db = GAIN_MIN;
      } else if (clampedPct <= FaderLaw.unityPosition) {
        const norm = Math.sqrt(clampedPct / FaderLaw.unityPosition);
        db = GAIN_MIN + norm * (0 - GAIN_MIN);
      } else {
        const t =
          (clampedPct - FaderLaw.unityPosition) /
          (1.0 - FaderLaw.unityPosition);
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
      calculateValueFromPointer(
        e.clientY,
        e.metaKey || e.shiftKey || e.ctrlKey,
      );
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
      className="flex h-full min-h-0 w-full max-w-18 touch-none select-none items-stretch py-2"
      title="Double-click or Alt+click to reset (0 dB)"
      {...escRevert}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className={`relative h-full shrink-0 pointer-events-none ${
          density === "narrow" ? "w-3.5" : "w-5 sm:w-5.5"
        }`}
      >
        <FaderScale density={density} trackHeight={trackHeight} />
      </div>

      <div
        ref={trackRef}
        // A vertical fader drags up and down; `pointer` said "click me".
        className="relative flex-1 cursor-ns-resize h-full"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <FaderVisuals normalized={normalized} density={density} />
      </div>
    </div>
  );
});
