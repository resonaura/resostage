import React, { memo, useCallback, useMemo, useRef } from "react";
import { useLiveValue } from "../../lib/optimistic";
import { useEscRevert } from "../../lib/useEscRevert";
import { GAIN_MAX, GAIN_MIN } from "./constants";

interface GainFaderProps {
  gainDb: number;
  onChange: (v: number) => void;
  defaultValue?: number;
  step?: number;
  accent?: string;
}

const SCALE_MARKERS = [GAIN_MAX, 6, 0, -6, -12, -24, -36, GAIN_MIN];
const GAIN_RANGE = GAIN_MAX - GAIN_MIN;

// Мемоизированная шкала - рендерится один раз
const FaderScale = memo(() => {
  const getNormalized = (db: number) =>
    Math.max(0, Math.min(1, (db - GAIN_MIN) / GAIN_RANGE));

  return (
    <div className="absolute left-0 top-4 bottom-4 w-7 pointer-events-none">
      {SCALE_MARKERS.map((markerDb) => {
        const topPercent = (1 - getNormalized(markerDb)) * 100;
        const isZero = markerDb === 0;

        return (
          <div
            key={markerDb}
            className="absolute right-0 flex items-center -translate-y-1/2 gap-1.5"
            style={{ top: `${topPercent}%` }}
          >
            <span
              className={`text-[9px] font-mono leading-none tracking-tight transition-colors ${
                isZero
                  ? "font-semibold text-[var(--foreground)] opacity-90"
                  : "text-[var(--muted)] opacity-70"
              }`}
            >
              {markerDb === GAIN_MIN
                ? "-INF"
                : markerDb > 0
                  ? `+${markerDb}`
                  : markerDb}
            </span>
            <div
              className="h-[1px] transition-colors"
              style={{
                width: isZero ? "7px" : "3px",
                backgroundColor: isZero
                  ? "var(--foreground)"
                  : "var(--separator)",
                opacity: isZero ? 0.8 : 0.5,
              }}
            />
          </div>
        );
      })}
    </div>
  );
});

FaderScale.displayName = "FaderScale";

// Мемоизированная визуальная часть - перерисовывается только при изменении normalized
const FaderVisuals = memo<{
  normalized: number;
  accent?: string;
}>(({ normalized, accent: _accent }) => {
  const accentColor = "var(--muted)";

  return (
    <>
      {/* Прорезь трека */}
      <div
        className="absolute top-0 bottom-0 w-[3px] rounded-full"
        style={{
          backgroundColor: "var(--field-background, var(--default))",
          boxShadow: "inset 0 1px 2px rgba(0,0,0,0.12)",
          border: "1px solid var(--border)",
        }}
      />

      {/* Заливка уровня */}
      <div
        className="absolute bottom-0 w-[2px] rounded-b-full pointer-events-none opacity-80"
        style={{
          height: `${normalized * 100}%`,
          backgroundColor: accentColor,
        }}
      />

      {/* Кноб */}
      <div
        className="absolute w-5 h-7 pointer-events-none rounded-[2px] -translate-x-1/2 -translate-y-1/2 left-1/2"
        style={{
          top: `${(1 - normalized) * 100}%`,
          background:
            "linear-gradient(180deg, var(--surface) 0%, var(--default) 100%)",
          border: "1px solid var(--border)",
          boxShadow: `
            0 3px 8px -1px rgba(0, 0, 0, 0.18),
            0 1px 3px -1px rgba(0, 0, 0, 0.12),
            inset 0 1px 0 0 rgba(255, 255, 255, 0.1)
          `,
        }}
      >
        {/* Боковые скосы */}
        <div
          className="absolute inset-y-0 left-0 w-[1px] opacity-40 pointer-events-none"
          style={{ backgroundColor: "var(--border)" }}
        />
        <div
          className="absolute inset-y-0 right-0 w-[1px] opacity-40 pointer-events-none"
          style={{ backgroundColor: "var(--border)" }}
        />

        {/* Индикаторная засечка */}
        <div
          className="absolute top-1/2 left-1 right-1 h-[1px] -translate-y-1/2 rounded-full"
          style={{
            backgroundColor: accentColor,
            opacity: 0.9,
          }}
        />
      </div>
    </>
  );
});

FaderVisuals.displayName = "FaderVisuals";

export const GainFader = memo<GainFaderProps>(function GainFader({
  gainDb,
  onChange,
  defaultValue = 0,
  step = 0.1,
  accent,
}) {
  const [value, handleChange] = useLiveValue(gainDb, onChange);
  const escRevert = useEscRevert(() => value, handleChange);
  const trackRef = useRef<HTMLDivElement>(null);

  const getNormalized = useCallback(
    (db: number) => Math.max(0, Math.min(1, (db - GAIN_MIN) / GAIN_RANGE)),
    [],
  );

  const normalized = useMemo(
    () => getNormalized(value),
    [value, getNormalized],
  );

  const calculateValueFromPointer = useCallback(
    (clientY: number) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      if (rect.height === 0) return;

      const relativeY = clientY - rect.top;
      const rawPct = 1 - relativeY / rect.height;
      const clampedPct = Math.max(0, Math.min(1, rawPct));

      const rawVal = GAIN_MIN + clampedPct * GAIN_RANGE;
      const steppedVal = Math.round(rawVal / step) * step;
      const finalVal = Math.max(GAIN_MIN, Math.min(GAIN_MAX, steppedVal));

      handleChange(finalVal);
    },
    [handleChange, step],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    calculateValueFromPointer(e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      calculateValueFromPointer(e.clientY);
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
      handleChange(defaultValue);
    },
    [handleChange, defaultValue],
  );

  return (
    <div
      className="relative flex h-full min-h-[180px] w-16 select-none items-center justify-center py-4 touch-none"
      title="Double-click to reset"
      {...escRevert}
      onDoubleClick={handleDoubleClick}
    >
      <FaderScale />

      {/* Интерактивная область */}
      <div
        ref={trackRef}
        className="relative h-full w-full cursor-pointer flex justify-center ml-6"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <FaderVisuals normalized={normalized} accent={accent} />
      </div>
    </div>
  );
});
