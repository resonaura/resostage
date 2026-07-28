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

function useMeterBallistics(db: number): {
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

      const target = Math.max(dbRef.current, FLOOR_DB);
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

function ChannelBar({
  db,
  vertical,
  className,
  accent,
}: {
  db: number;
  vertical: boolean;
  className?: string;
  accent: string;
}) {
  const { display, peak, clipLatched, clearClip } = useMeterBallistics(db);
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
              background: "#ff3b30",
              boxShadow: "0 0 4px rgba(255,59,48,0.7)",
            }}
          />
        ) : (
          <div
            className="absolute top-0 bottom-0 right-0 z-10 pointer-events-none"
            style={{
              width: `${CLIP_BAND_PCT}%`,
              minWidth: 3,
              background: "#ff3b30",
              boxShadow: "0 0 4px rgba(255,59,48,0.7)",
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
}

export function LevelMeterBar({
  db,
  dbL,
  dbR,
  accent = DEFAULT_ACCENT,
  label,
  vertical = true,
  className = "",
  showValue = true,
  barClassName,
  mono = false,
}: LevelMeterBarProps) {
  const left = dbL ?? db;
  const right = dbR ?? db;
  const maxDb = Math.max(left, right);

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
          vertical={vertical}
          className={barClassName}
          accent={accent}
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
            vertical={vertical}
            accent={accent}
            className={
              barClassName ?? (vertical ? "h-full w-1.5" : "h-1.5 w-full")
            }
          />
          <ChannelBar
            db={right}
            vertical={vertical}
            accent={accent}
            className={
              barClassName ?? (vertical ? "h-full w-1.5" : "h-1.5 w-full")
            }
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
