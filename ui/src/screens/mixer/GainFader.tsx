import React, { memo, useCallback, useMemo, useRef } from "react";
import { useEscRevert } from "../../lib/useEscRevert";
import { GAIN_MAX, GAIN_MIN } from "./constants";

interface GainFaderProps {
  /**
   * The dB the fader should draw RIGHT NOW -- already optimistic.
   *
   * This used to be the raw server value, with the fader holding its own
   * optimistic copy privately. That made the knob follow the pointer instantly
   * while everything else on the strip -- above all the dB readout directly
   * above it -- kept showing whatever the engine had last echoed back, so a
   * drag read as the number lagging the handle by a couple of frames. The
   * optimistic value now belongs to the strip, which hands the same one to
   * both. See ChannelStrip.
   */
  value: number;
  onChange: (v: number) => void;
  defaultValue?: number;
  step?: number;
}

const SCALE_MARKERS = [GAIN_MAX, 6, 0, -6, -12, -24, -36, GAIN_MIN];
const GAIN_RANGE = GAIN_MAX - GAIN_MIN;

/** Where a dB value sits on the throw: 0 at the bottom, 1 at the top. */
function normalizedFor(db: number): number {
  return Math.max(0, Math.min(1, (db - GAIN_MIN) / GAIN_RANGE));
}

// ── How loud a scale mark is drawn ───────────────────────────────────────
//
// Unity is the mark that gets looked for -- "is this fader where I left it"
// is a question about 0 dB, and the marks either side of it are what you read
// a small trim against. -36 and -∞ are context: you need to know the scale
// runs that far, not to read a value there.
//
// So a mark fades with its DISTANCE FROM UNITY, symmetrically (+12 is as
// present as -12), rather than every non-zero mark sharing one flat grey. The
// fade is eased rather than linear so the useful band around unity separates
// from the tail instead of the whole column drifting evenly to nothing.
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
 *
 * Static -- it never depends on the value -- so it is memoised away from the
 * handle, which moves every frame of a drag.
 */
const FaderScale = memo(function FaderScale() {
  return (
    <div className="pointer-events-none relative w-7 shrink-0">
      {SCALE_MARKERS.map((markerDb) => {
        const isZero = markerDb === 0;
        return (
          <div
            key={markerDb}
            className="absolute right-0 flex -translate-y-1/2 items-center gap-1 text-foreground"
            style={{
              top: `${(1 - normalizedFor(markerDb)) * 100}%`,
              // One opacity for the pair: a label and its tick are one mark,
              // and fading them apart makes the column look misprinted.
              opacity: markOpacity(markerDb),
            }}
          >
            <span
              className={`font-mono text-[9px] leading-none tracking-tight tabular-nums ${
                isZero ? "font-semibold" : ""
              }`}
            >
              {markerDb === GAIN_MIN
                ? "-∞"
                : markerDb > 0
                  ? `+${markerDb}`
                  : markerDb}
            </span>
            {/* Held under the label so the ticks read as a scale rather than
                as a second column of content. */}
            <div
              className="h-px rounded-full bg-foreground/60"
              style={{ width: isZero ? 6 : 3 }}
            />
          </div>
        );
      })}
    </div>
  );
});

/**
 * Track, fill and cap.
 *
 * Deliberately monochrome: the strip already says which channel this is twice
 * over (the colour bar in its header and the meter beside the fader), and a
 * third coloured element made a console of twelve strips read as decoration
 * rather than as twelve identical controls at different positions.
 */
const FaderVisuals = memo(function FaderVisuals({
  normalized,
}: {
  normalized: number;
}) {
  return (
    <>
      {/* Slot: cut INTO the strip, so it has to be darker than the panel --
          a slot the same weight as the fill below it reads as one flat line
          and the fader stops showing where it is set from across a stage. */}
      <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-black/55" />

      {/* Travelled part of the throw */}
      <div
        className="pointer-events-none absolute bottom-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-foreground/35"
        style={{ height: `${normalized * 100}%` }}
      />

      {/* Cap. Upright, the way a console fader cap is: the grip is taller than
          it is wide so the pointer has something to aim at over a 180px throw,
          and the hairline across it is what you actually read the position
          from. */}
      <div
        className="pointer-events-none absolute left-1/2 flex h-6 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[4px] bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.35)] ring-1 ring-inset ring-default"
        style={{ top: `${(1 - normalized) * 100}%` }}
      >
        <div className="h-px w-2 rounded-full bg-foreground/45" />
      </div>
    </>
  );
});

export const GainFader = memo<GainFaderProps>(function GainFader({
  value,
  onChange,
  defaultValue = 0,
  step = 0.1,
}) {
  const escRevert = useEscRevert(() => value, onChange);
  const trackRef = useRef<HTMLDivElement>(null);

  const normalized = useMemo(() => normalizedFor(value), [value]);

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

      onChange(finalVal);
    },
    [onChange, step],
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
      onChange(defaultValue);
    },
    [onChange, defaultValue],
  );

  return (
    // The scale and the throw are siblings in one flex row, both spanning the
    // same padded box -- so a tick at 0 dB is at the same height as the cap
    // when the fader reads 0 dB, without either side restating the padding.
    <div
      className="flex h-full min-h-[180px] w-16 touch-none select-none items-stretch py-3"
      title="Double-click to reset"
      {...escRevert}
      onDoubleClick={handleDoubleClick}
    >
      <FaderScale />

      <div
        ref={trackRef}
        className="relative flex-1 cursor-pointer"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <FaderVisuals normalized={normalized} />
      </div>
    </div>
  );
});
