import { CLIP_COLOR, CLIP_GLOW } from "../../components/LevelMeterBar";

function formatDbReadout(v: number): string {
  if (!Number.isFinite(v) || v <= -100) return "-inf";
  const c = Math.max(-100, Math.min(24, v));
  return c > 0 ? `+${c.toFixed(1)}` : c.toFixed(1);
}

/** Logic-style pair: fader value left, live/held peak right. */
export function GainPeakReadout({
  gainDb,
  liveAvgDb,
  clipped,
  heldPeakDb,
  onClear,
}: {
  gainDb: number;
  liveAvgDb: number;
  clipped: boolean;
  heldPeakDb: number;
  onClear: () => void;
}) {
  const shownDb = clipped ? heldPeakDb : liveAvgDb;

  return (
    <div className="flex w-full gap-1 text-[10px] font-mono font-semibold tabular-nums">
      <div
        className="flex-1 rounded bg-black/40 px-1 py-0.5 text-center text-foreground/80"
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
        className={`flex-1 rounded px-1 py-0.5 text-center transition-colors ${
          clipped
            ? "text-white"
            : "bg-black/40 text-foreground/80 hover:bg-black/55"
        }`}
        style={
          clipped ? { background: CLIP_COLOR, boxShadow: CLIP_GLOW } : undefined
        }
      >
        {formatDbReadout(shownDb)}
      </button>
    </div>
  );
}
