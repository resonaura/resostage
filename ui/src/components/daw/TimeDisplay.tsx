import { useState } from "react";

import { LiveReadout } from "./LiveReadout";
import { formatBarBeat, formatClock } from "./timeFormat";

/**
 * Fixed-width transport clock chip; click toggles time ↔ bar|beat.
 *
 * The width is fixed rather than fit-to-content so the buttons to its right
 * never shift as the digits change — a control that moves under the cursor
 * while you are reaching for it is the kind of thing that costs a cue on
 * stage.
 *
 * Prefer `getSeconds` over `seconds`. A bar number read from React state is
 * only as fresh as the last telemetry frame, and the transport publishes at
 * whatever rate the performance tier allows -- so the bar flipped visibly
 * after the beat it belongs to, which is exactly the moment anyone looking at
 * this is looking at it. Sampling a live clock on the shared frame driver
 * puts the flip back on the beat.
 */
export function TimeDisplay({
  seconds,
  getSeconds,
  bpm,
  tsNum,
  playing = false,
  hasSong = true,
  className = "",
}: {
  /** Static fallback; used only when `getSeconds` is absent. */
  seconds: number;
  /** Live clock read, sampled per frame. */
  getSeconds?: () => number;
  bpm: number;
  tsNum: number;
  /** Tints the readout while the transport is rolling. */
  playing?: boolean;
  /** No song loaded — bar|beat has nothing to count against. */
  hasSong?: boolean;
  className?: string;
}) {
  const [mode, setMode] = useState<"time" | "bars">("time");

  const format = (v: number) =>
    mode === "time"
      ? formatClock(v)
      : hasSong
        ? formatBarBeat(v, bpm || 120, tsNum)
        : "—";

  return (
    <button
      type="button"
      onClick={() => setMode((m) => (m === "time" ? "bars" : "time"))}
      className={`flex h-7 w-[5.5rem] shrink-0 items-center justify-center rounded-md px-1 font-mono text-xs tabular-nums transition-colors hover:bg-default/20 ${
        playing ? "text-accent" : "text-foreground/70"
      } ${className}`}
      title={
        mode === "time"
          ? "Time — click for bar|beat"
          : "Bar|beat — click for time"
      }
    >
      {getSeconds ? (
        // Per frame, not the usual 12/s: the string only changes on a beat
        // boundary, and LiveReadout compares before it writes, so the cost is
        // one format call and the benefit is landing on the right frame.
        <LiveReadout
          intervalMs={0}
          sample={() => format(getSeconds())}
          className="tabular-nums"
        />
      ) : (
        format(seconds)
      )}
    </button>
  );
}
