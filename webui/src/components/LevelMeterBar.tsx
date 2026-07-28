import { useEffect, useRef, useState } from "react";

// Ballistic peak meter -- same physics as app/ui/LevelMeter.h (native
// build): instant attack, ~20dB/s release, 1.5s peak-hold then exponential
// decay, extended range to +6dBFS, persistent clip latch. Runs its own
// rAF loop so it keeps decaying smoothly between ~30Hz WebSocket frames
// (and falls to silence if the socket drops) instead of just snapping to
// whatever peakDb was last received.
const FLOOR_DB = -100;
const RANGE_LOW_DB = -60;
const RANGE_HIGH_DB = 6;
const BAR_DECAY_DB_PER_SEC = 80;
const PEAK_HOLD_SECONDS = 0.8;
const PEAK_DECAY_DB_PER_SEC = 50;

function normFor(db: number): number {
  return Math.max(
    0,
    Math.min(1, (db - RANGE_LOW_DB) / (RANGE_HIGH_DB - RANGE_LOW_DB)),
  );
}

function gradientColor(db: number): string {
  if (db > 0) return "#ff383c"; // solid vivid red, clip zone
  if (db >= -12) {
    const t = Math.max(0, Math.min(1, (db + 12) / 12));
    return mix("#ffcc00", "#ff8d28", t); // yellow -> orange
  }
  if (db >= -60) {
    const t = Math.max(0, Math.min(1, (db + 60) / 48));
    return mix("#0f5a26", "#34c759", t); // dark green -> green
  }
  return "#0f5a26";
}

function mix(a: string, b: string, t: number): string {
  const pa = hex(a);
  const pb = hex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}
function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

interface LevelMeterBarProps {
  db: number;
  label?: string;
  vertical?: boolean;
  className?: string;
  showValue?: boolean;
  barClassName?: string;
}

export function LevelMeterBar({
  db,
  label,
  vertical = true,
  className = "",
  showValue = true,
  barClassName,
}: LevelMeterBarProps) {
  const [display, setDisplay] = useState(FLOOR_DB);
  const [peak, setPeak] = useState(FLOOR_DB);
  const [clipLatched, setClipLatched] = useState(false);
  const dbRef = useRef(db);
  dbRef.current = db;
  const anim = useRef({
    display: FLOOR_DB,
    peak: FLOOR_DB,
    holdRemaining: 0,
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

      if (target > 0) setClipLatched(true);
      setDisplay(s.display);
      setPeak(s.peak);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const fillPct = normFor(display) * 100;
  const peakPct = normFor(peak) * 100;
  const color = gradientColor(display);

  return (
    <div
      className={`flex items-center gap-2 ${vertical ? "h-full" : ""} ${className}`}
    >
      {label && (
        <div className="w-16 shrink-0 truncate text-xs text-foreground/60">
          {label}
        </div>
      )}
      <button
        type="button"
        onClick={() => setClipLatched(false)}
        title={clipLatched ? "Clipped -- click to reset" : undefined}
        className={`relative overflow-hidden rounded-md bg-background ${
          barClassName ?? (vertical ? "h-24 w-4" : "h-3 w-full")
        }`}
      >
        <div
          className="absolute top-0 h-1.5 w-full"
          style={{ background: clipLatched ? "#ff383c" : "transparent" }}
        />
        {vertical ? (
          <div
            className="absolute bottom-0 left-0 w-full"
            style={{ height: `${fillPct}%`, background: color }}
          />
        ) : (
          <div
            className="absolute left-0 top-0 h-full"
            style={{ width: `${fillPct}%`, background: color }}
          />
        )}
        {vertical ? (
          <div
            className="absolute left-0 h-0.5 w-full bg-foreground/80"
            style={{ bottom: `${peakPct}%` }}
          />
        ) : (
          <div
            className="absolute top-0 h-full w-0.5 bg-foreground/80"
            style={{ left: `${peakPct}%` }}
          />
        )}
      </button>
      {showValue && (
        <div className="w-12 shrink-0 text-right text-xs tabular-nums text-foreground/60">
          {display <= FLOOR_DB + 1 ? "-inf" : display.toFixed(1)}
        </div>
      )}
    </div>
  );
}
