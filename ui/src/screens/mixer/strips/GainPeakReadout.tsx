/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useRef } from "react";
import { clipColor, clipGlow, LiveReadout } from "@/components/daw";

function formatDbReadout(v: number): string {
  if (!Number.isFinite(v) || v <= -59.5) return "-inf";
  const c = Math.max(-60, Math.min(24, v));
  return c > 0 ? `+${c.toFixed(1)}` : c.toFixed(1);
}

/**
 * Logic-style pair: fader value left, live/held peak right.
 *
 * The right-hand number is written straight into the DOM from the shared rAF
 * rather than rendered. It used to arrive as a prop, which meant the whole
 * channel strip -- and so every routing select and send knob on it -- had to
 * re-render on each telemetry frame just to move four digits. React owns no
 * text inside that span, so there is nothing for the two writers to fight
 * over; see lib/levelFields for the memoisation this is what unblocks.
 */
export function GainPeakReadout({
  gainDb,
  getLiveDb,
  clipped,
  getHeldPeakDb,
  onClear,
  onGainChange,
  density = "standard",
}: {
  gainDb: number;
  /** max/avg of the strip's live channels, sampled off the shared rAF. */
  getLiveDb: () => number;
  clipped: boolean;
  getHeldPeakDb: () => number;
  onClear: () => void;
  onGainChange?: (v: number) => void;
  density?: "narrow" | "standard" | "wide";
}) {
  const getLiveDbRef = useRef(getLiveDb);
  getLiveDbRef.current = getLiveDb;
  const getHeldPeakRef = useRef(getHeldPeakDb);
  getHeldPeakRef.current = getHeldPeakDb;

  const handleGainPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onGainChange || e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startVal = Number.isFinite(gainDb) ? gainDb : -60;

    const onPointerMove = (ev: PointerEvent) => {
      const dy = startY - ev.clientY;
      const step = ev.shiftKey ? 0.1 : 0.5;
      const next = Math.max(
        -60,
        Math.min(12, Math.round((startVal + dy * 0.15) / step) * step),
      );
      onGainChange(next);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const isNarrow = density === "narrow";

  return (
    <div
      className={`flex w-full min-w-0 gap-1 font-mono font-semibold tabular-nums leading-none tracking-tight whitespace-nowrap ${
        isNarrow ? "text-[8px]" : "text-[8.5px] sm:text-[9px]"
      }`}
    >
      <div
        className={`flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-black/45 px-0.5 py-1 text-center text-foreground/85 select-none ${
          onGainChange
            ? "cursor-ns-resize hover:text-foreground hover:bg-black/60 transition-colors"
            : ""
        }`}
        title={
          onGainChange
            ? "Fader value (Drag up/down to adjust, double-click for 0 dB)"
            : "Fader value"
        }
        onPointerDown={handleGainPointerDown}
        onDoubleClick={(e) => {
          if (onGainChange) {
            e.preventDefault();
            onGainChange(0.0);
          }
        }}
      >
        <span className="block truncate whitespace-nowrap">
          {formatDbReadout(gainDb)}
        </span>
      </div>
      <button
        type="button"
        onClick={onClear}
        title={
          clipped
            ? "Peak / clip hold — click to clear across Timeline, Inspector, and Mixer"
            : "Peak hold (dB) — click to clear across Timeline, Inspector, and Mixer"
        }
        className={`flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-0.5 py-1 text-center transition-colors ${
          clipped
            ? "text-white"
            : "bg-black/45 text-foreground/85 hover:bg-black/60 hover:text-foreground"
        }`}
        style={
          clipped
            ? { background: clipColor(), boxShadow: clipGlow() }
            : undefined
        }
      >
        <LiveReadout
          className="block truncate whitespace-nowrap"
          sample={() => {
            const held = getHeldPeakRef.current();
            return formatDbReadout(
              held > -99.5 ? held : getLiveDbRef.current(),
            );
          }}
        />
      </button>
    </div>
  );
}
