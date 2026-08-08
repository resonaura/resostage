import { memo } from "react";
import { mixer } from "../../lib/api";
import { getLiveLevels } from "../../lib/liveLevels";
import { useLiveValue } from "../../lib/optimistic";
import type { TrackRow } from "../../lib/types";
import { Knob, LevelMeterBar } from "../daw";
import { laneHeightPx } from "./laneDimensions";
import { MiniSlider } from "./MiniSlider";

// Density follows verticalZoom so the left rail stays pixel-aligned with
// waveform lanes: compact (name + M/S), normal (+ pan), roomy (+ vol + taller meter).

export const TrackHeaderControl = memo(
  function TrackHeaderControl({
    track,
    index,
    color,
    verticalZoom,
    anySolo = false,
  }: {
    track: TrackRow;
    index: number;
    color: string;
    verticalZoom: number;
    anySolo?: boolean;
  }) {
    const [gain, setGain] = useLiveValue(track.gainDb ?? 0, (v) =>
      mixer.setTrackGain(index, v),
    );
    const [pan, setPan] = useLiveValue(track.pan ?? 0, (v) =>
      mixer.setTrackPan(index, v),
    );

    const formatPan = (p: number) => {
      if (Math.abs(p) < 0.05) return "C";
      if (p < 0) return `L${Math.round(-p * 100)}`;
      return `R${Math.round(p * 100)}`;
    };

    const isDimmed = anySolo && !track.solo;
    const h = laneHeightPx(verticalZoom);
    // Density tiers keyed to lane height (LANE_HEIGHT=56 at zoom 1).
    const showVol = h >= 48;
    const showPan = h >= 36;
    const showMeter = h >= 28;
    const padY = h < 32 ? 2 : h < 48 ? 4 : h < 80 ? 6 : 8;
    const padX = h < 36 ? 8 : 12;
    const nameSize = h < 32 ? 10 : h < 64 ? 12 : 13;
    const btn = h < 36 ? 16 : h < 72 ? 20 : 22;
    const btnFont = h < 36 ? 8 : 10;
    const knobSize = h < 48 ? 16 : h < 80 ? 20 : 24;
    // Quantize meter height so vertical zoom doesn't thrash ResizeObserver
    // (and flash the canvas meters) on every sub-step.
    const meterHRaw = showVol
      ? Math.max(14, Math.round(h * 0.38))
      : Math.max(12, h - padY * 2 - 4);
    const meterH = Math.round(meterHRaw / 4) * 4;
    const swatchH = h < 32 ? 10 : 14;
    const swatchW = h < 32 ? 6 : 8;

    return (
      <div
        className={`flex flex-col justify-center border-b border-default/15 select-none overflow-hidden transition-opacity duration-300 bg-surface/40 hover:bg-surface/70 ${
          isDimmed ? "opacity-35" : "opacity-100"
        }`}
        style={{
          height: h,
          padding: `${padY}px ${padX}px`,
          gap: showVol ? 4 : 0,
        }}
      >
        {/* Top row: color, name, meter, pan, M/S */}
        <div className="flex min-h-0 min-w-0 flex-1 items-center gap-1.5">
          <span
            className="shrink-0 rounded-sm"
            style={{
              height: swatchH,
              width: swatchW,
              background: color,
              opacity: track.mute ? 0.35 : 1,
            }}
          />
          <span
            className={`min-w-0 flex-1 truncate font-semibold text-foreground/90 ${
              track.mute ? "line-through opacity-40" : ""
            }`}
            style={{ fontSize: nameSize }}
            title={track.name || track.id}
          >
            {track.name || track.id}
          </span>
          {showMeter && (
            <div className="w-3 shrink-0" style={{ height: meterH }}>
              <LevelMeterBar
                db={track.peakDb ?? -100}
                dbL={track.peakDbL ?? track.peakDb ?? -100}
                dbR={track.peakDbR ?? track.peakDb ?? -100}
                getLiveDbL={() =>
                  getLiveLevels().tracks[index]?.peakDbL ?? -144
                }
                getLiveDbR={() =>
                  getLiveLevels().tracks[index]?.peakDbR ?? -144
                }
                accent={color}
                vertical
                showValue={false}
                barClassName="h-full w-1"
              />
            </div>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {showPan && (
              <div
                className="flex items-center gap-0.5"
                title={`Pan: ${formatPan(pan)}`}
              >
                <Knob
                  value={pan}
                  min={-1}
                  max={1}
                  defaultValue={0}
                  size={knobSize}
                  accent={color}
                  onCommit={(v) => setPan(v)}
                />
                {h >= 44 && (
                  <span
                    className="w-5 text-center font-mono font-medium text-foreground/50"
                    style={{ fontSize: Math.max(7, nameSize - 3) }}
                  >
                    {formatPan(pan)}
                  </span>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => mixer.setTrackMute(index, !track.mute)}
              className={`rounded font-bold transition-all shadow-sm ${
                track.mute
                  ? "bg-danger text-white scale-105"
                  : isDimmed
                    ? "bg-danger/80 text-white animate-pulse"
                    : "bg-default/20 text-foreground/50 hover:bg-default/35 hover:text-foreground"
              }`}
              style={{ height: btn, width: btn, fontSize: btnFont }}
              title="Mute"
            >
              M
            </button>

            <button
              type="button"
              onClick={() => mixer.setTrackSolo(index, !track.solo)}
              className={`rounded font-bold transition-all shadow-sm ${
                track.solo
                  ? "bg-warning text-black scale-105"
                  : "bg-default/20 text-foreground/50 hover:bg-default/35 hover:text-foreground"
              }`}
              style={{ height: btn, width: btn, fontSize: btnFont }}
              title="Solo"
            >
              S
            </button>
          </div>
        </div>

        {showVol && (
          <div
            className="flex shrink-0 items-center gap-1.5 font-mono text-foreground/60"
            style={{ fontSize: Math.max(8, nameSize - 3) }}
          >
            <span className="shrink-0 uppercase tracking-wider font-semibold text-foreground/40">
              Vol
            </span>
            <MiniSlider
              value={gain}
              min={-60}
              max={12}
              step={0.5}
              accent={color}
              onChange={(v) => setGain(v)}
            />
            <span
              className="w-8 shrink-0 text-right font-medium tabular-nums"
              style={{ fontSize: Math.max(8, nameSize - 2) }}
            >
              {gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)}
            </span>
          </div>
        )}
      </div>
    );
  },
  // Peak levels now animate off the live binary telemetry (getLiveDb* above),
  // not this prop -- so a `track` update that only bumps peakDb/peakDbL/peakDbR
  // (i.e. every WS frame during playback) shouldn't force a re-render of the
  // whole header row. Compare only the fields that actually affect output.
  (prev, next) =>
    prev.index === next.index &&
    prev.color === next.color &&
    prev.verticalZoom === next.verticalZoom &&
    prev.anySolo === next.anySolo &&
    prev.track.id === next.track.id &&
    prev.track.name === next.track.name &&
    prev.track.mute === next.track.mute &&
    prev.track.solo === next.track.solo &&
    prev.track.gainDb === next.track.gainDb &&
    prev.track.pan === next.track.pan,
);
