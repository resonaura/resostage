import { useState } from "react";

import { formatBarBeat, formatClock } from "./timeFormat";

/**
 * Fixed-width transport clock chip; click toggles time ↔ bar|beat.
 *
 * The width is fixed rather than fit-to-content so the buttons to its right
 * never shift as the digits change — a control that moves under the cursor
 * while you are reaching for it is the kind of thing that costs a cue on
 * stage.
 */
export function TimeDisplay({
  seconds,
  bpm,
  tsNum,
  playing = false,
  hasSong = true,
  className = "",
}: {
  seconds: number;
  bpm: number;
  tsNum: number;
  /** Tints the readout while the transport is rolling. */
  playing?: boolean;
  /** No song loaded — bar|beat has nothing to count against. */
  hasSong?: boolean;
  className?: string;
}) {
  const [mode, setMode] = useState<"time" | "bars">("time");

  return (
    <button
      type="button"
      onClick={() => setMode((m) => (m === "time" ? "bars" : "time"))}
      className={`flex h-7 w-[5.5rem] shrink-0 items-center justify-center rounded-md px-1 font-mono text-xs tabular-nums transition-colors hover:bg-default/20 ${
        playing ? "text-success" : "text-foreground/70"
      } ${className}`}
      title={
        mode === "time"
          ? "Time — click for bar|beat"
          : "Bar|beat — click for time"
      }
    >
      {mode === "time"
        ? formatClock(seconds)
        : hasSong
          ? formatBarBeat(seconds, bpm || 120, tsNum)
          : "—"}
    </button>
  );
}
