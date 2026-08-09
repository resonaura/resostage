import { useRef } from "react";
import { CLIP_COLOR, CLIP_GLOW, LiveReadout } from "../../components/daw";

function formatDbReadout(v: number): string {
  if (!Number.isFinite(v) || v <= -100) return "-inf";
  const c = Math.max(-100, Math.min(24, v));
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
  heldPeakDb,
  onClear,
}: {
  gainDb: number;
  /** max/avg of the strip's live channels, sampled off the shared rAF. */
  getLiveDb: () => number;
  clipped: boolean;
  heldPeakDb: number;
  onClear: () => void;
}) {
  const getLiveDbRef = useRef(getLiveDb);
  getLiveDbRef.current = getLiveDb;
  // While the clip latch is up the box shows the held peak and stops
  // following the signal -- that is the point of a hold.
  const heldRef = useRef<number | null>(null);
  heldRef.current = clipped ? heldPeakDb : null;

  return (
    <div className="flex w-full gap-1 text-[10px] font-mono font-semibold tabular-nums">
      <div
        className="flex-1 rounded-md bg-black/40 px-1 py-0.5 text-center text-foreground/80"
        title="Fader value"
      >
        {formatDbReadout(gainDb)}
      </div>
      <button
        type="button"
        onClick={onClear}
        title={
          clipped
            ? "Peak hold (dB) — click to clear and show the current level"
            : "Current level (dB, avg L/R)"
        }
        className={`flex-1 rounded-md px-1 py-0.5 text-center transition-colors ${
          clipped
            ? "text-white"
            : "bg-black/40 text-foreground/80 hover:bg-black/55"
        }`}
        style={
          clipped ? { background: CLIP_COLOR, boxShadow: CLIP_GLOW } : undefined
        }
      >
        <LiveReadout
          sample={() =>
            formatDbReadout(heldRef.current ?? getLiveDbRef.current())
          }
        />
      </button>
    </div>
  );
}
