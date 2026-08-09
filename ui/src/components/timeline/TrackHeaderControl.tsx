import { memo } from "react";
import { mixer } from "../../lib/api";
import { getLiveLevels } from "../../lib/liveLevels";
import { useLiveValue } from "../../lib/optimistic";
import type { TrackRow } from "../../lib/types";
import { Knob, LevelMeterBar, MeterFader } from "../daw";
import { TOGGLE_BLINK_ACCENT, ToggleButton } from "../ui";
import { laneHeightPx } from "./laneDimensions";

// Density follows verticalZoom so the left rail stays pixel-aligned with
// waveform lanes: compact (name + M/S), normal (+ pan), roomy (+ the combined
// meter/fader row).

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
    // The fader row IS the meter, so the standalone bar is only for lanes too
    // short to fit that row -- two meters on one track would just be the same
    // number twice.
    const showMeter = h >= 28 && !showVol;
    const padY = h < 32 ? 2 : h < 48 ? 4 : h < 80 ? 6 : 8;
    const padX = h < 36 ? 8 : 12;
    const nameSize = h < 32 ? 10 : h < 64 ? 12 : 13;
    const btn = h < 36 ? 16 : h < 72 ? 20 : 22;
    const btnFont = h < 36 ? 8 : 10;
    const knobSize = h < 48 ? 16 : h < 80 ? 20 : 24;
    // Quantize meter height so vertical zoom doesn't thrash ResizeObserver
    // (and flash the canvas meters) on every sub-step.
    const meterH = Math.round(Math.max(12, h - padY * 2 - 4) / 4) * 4;
    // Bar height; the handle is drawn a few px proud of it (see MeterFader).
    const faderH = h < 64 ? 13 : h < 96 ? 15 : 17;
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

            {/* Same soft tones as the console's M/S -- see ChannelStrip. The
                lane sizes these itself, and an inline height/width outranks
                the `xs` density class. */}
            <ToggleButton
              size="xs"
              tone="danger-soft"
              isSelected={track.mute}
              onChange={() => mixer.setTrackMute(index, !track.mute)}
              className={
                isDimmed && !track.mute ? TOGGLE_BLINK_ACCENT : undefined
              }
              style={{ height: btn, width: btn, fontSize: btnFont }}
              aria-label="Mute"
            >
              M
            </ToggleButton>

            <ToggleButton
              size="xs"
              tone="warning-soft"
              isSelected={track.solo}
              onChange={() => mixer.setTrackSolo(index, !track.solo)}
              style={{ height: btn, width: btn, fontSize: btnFont }}
              aria-label="Solo"
            >
              S
            </ToggleButton>
          </div>
        </div>

        {showVol && (
          <div className="flex shrink-0 items-center gap-1.5">
            <MeterFader
              value={gain}
              min={-60}
              max={12}
              step={0.5}
              onChange={(v) => setGain(v)}
              dbL={track.peakDbL ?? track.peakDb ?? -100}
              dbR={track.peakDbR ?? track.peakDb ?? -100}
              getLiveDbL={() => getLiveLevels().tracks[index]?.peakDbL ?? -144}
              getLiveDbR={() => getLiveLevels().tracks[index]?.peakDbR ?? -144}
              accent={color}
              height={faderH}
              aria-label={`${track.name || track.id} volume`}
            />
            <span
              className="w-8 shrink-0 text-right font-mono font-medium tabular-nums text-foreground/60"
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
