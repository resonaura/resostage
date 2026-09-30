import type { MixerDensity } from "@/screens/mixer/logic/constants";

export type { MixerDensity } from "@/screens/mixer/logic/constants";

export function MixerToolbar({
  trackCount,
  busCount,
  density,
  onDensityChange,
}: {
  trackCount: number;
  busCount: number;
  density: MixerDensity;
  onDensityChange: (density: MixerDensity) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between text-xs text-foreground/40">
      <div className="flex items-center gap-2">
        <span className="font-semibold uppercase tracking-wide">Console</span>
        <span>&middot;</span>
        <span>{trackCount} tracks</span>
        <span>&middot;</span>
        <span>{busCount} busses</span>
      </div>
      <div className="flex items-center gap-0.5 rounded-lg border border-default/20 bg-surface/40 p-0.5">
        <button
          type="button"
          onClick={() => onDensityChange("narrow")}
          className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
            density === "narrow"
              ? "bg-accent/20 font-bold text-accent shadow-sm"
              : "text-foreground/50 hover:text-foreground"
          }`}
        >
          Narrow (64px)
        </button>
        <button
          type="button"
          onClick={() => onDensityChange("standard")}
          className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
            density === "standard"
              ? "bg-accent/20 font-bold text-accent shadow-sm"
              : "text-foreground/50 hover:text-foreground"
          }`}
        >
          Standard (96px)
        </button>
        <button
          type="button"
          onClick={() => onDensityChange("wide")}
          className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
            density === "wide"
              ? "bg-accent/20 font-bold text-accent shadow-sm"
              : "text-foreground/50 hover:text-foreground"
          }`}
        >
          Wide (128px)
        </button>
      </div>
    </div>
  );
}
