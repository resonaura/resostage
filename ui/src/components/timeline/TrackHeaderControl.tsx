import { memo, useEffect, useRef, useState } from "react";
import { Mic, Music } from "lucide-react";
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
    isRecording = false,
    isSelected = false,
    onSelect,
  }: {
    track: TrackRow;
    index: number;
    color: string;
    verticalZoom: number;
    anySolo?: boolean;
    isRecording?: boolean;
    isSelected?: boolean;
    onSelect?: () => void;
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

    const isDimmed = anySolo && !track.solo && !track.soloSafe;
    const h = laneHeightPx(verticalZoom);
    // Density tiers keyed to lane height (LANE_HEIGHT=56 at zoom 1).
    const showVol = h >= 48;
    const showPan = h >= 36;
    // The fader row IS the meter, so the standalone bar is only for lanes too
    // short to fit that row -- two meters on one track would just be the same
    // number twice.
    const showMeter = h >= 28 && !showVol;
    const padY = h < 32 ? 2 : h < 48 ? 3 : h < 80 ? 4 : 6;
    const padX = h < 36 ? 6 : 8;
    const nameSize = h < 32 ? 10 : h < 64 ? 12 : 13;
    const btn = showVol ? (h < 64 ? 18 : 20) : (h < 36 ? 16 : 18);
    const btnFont = showVol ? (h < 64 ? 8.5 : 9.5) : (h < 36 ? 7.5 : 8.5);
    const knobSize = showVol ? (h < 64 ? 18 : 20) : (h < 48 ? 15 : 18);
    // Quantize meter height so vertical zoom doesn't thrash ResizeObserver
    // (and flash the canvas meters) on every sub-step.
    const meterH = Math.round(Math.max(12, h - padY * 2 - 4) / 4) * 4;
    // Bar height; the handle is drawn a few px proud of it (see MeterFader).
    const faderH = h < 64 ? 12 : h < 96 ? 14 : 16;
    const swatchH = h < 32 ? 10 : h < 64 ? 12 : 14;
    const swatchW = h < 32 ? 5 : 6;

    // Optimistic polarity: instant visual toggle, 1200ms lock against stale echo
    const [optimisticPolarity, setOptimisticPolarity] = useState<"left" | "right" | "none" | "both" | null>(null);
    const lastPolarityEdit = useRef(0);
    useEffect(() => {
      if (Date.now() - lastPolarityEdit.current > 1200) {
        setOptimisticPolarity(null);
      }
    }, [track.polarity, track.phaseInvert]);

    const effectivePolarity: "left" | "right" | "none" | "both" =
      optimisticPolarity ?? (track.polarity ?? (track.phaseInvert ? "both" : "none"));
    const isPolActive = effectivePolarity !== "none";

    const muteBtn = (
      <button
        type="button"
        onClick={() => void mixer.setTrackMute(index, !track.mute)}
        className={`flex items-center justify-center rounded border font-bold transition-all select-none ${
          track.mute
            ? "bg-[var(--rs-mute)] text-white border-[var(--rs-mute)] shadow-[0_0_6px_rgba(0,122,255,0.5)] font-black"
            : "bg-surface/60 text-foreground/75 border-default/30 hover:bg-surface hover:text-foreground"
        } ${isDimmed && !track.mute ? TOGGLE_BLINK_ACCENT : ""}`}
        style={{ height: btn, width: btn, fontSize: btnFont }}
        title={track.mute ? "Mute (Active)" : "Mute"}
        aria-label="Mute"
      >
        M
      </button>
    );

    const soloBtn = (
      <button
        type="button"
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            void mixer.setTrackSoloSafe(index, !track.soloSafe);
          } else {
            void mixer.setTrackSolo(index, !track.solo);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          void mixer.setTrackSoloSafe(index, !track.soloSafe);
        }}
        className={`relative flex items-center justify-center rounded border font-bold transition-all select-none ${
          track.solo
            ? "bg-[var(--rs-solo)] text-black border-[var(--rs-solo)] shadow-[0_0_6px_rgba(255,214,10,0.5)] font-black"
            : "bg-surface/60 text-foreground/75 border-default/30 hover:bg-surface hover:text-foreground"
        } ${track.soloSafe ? "ring-1 ring-danger ring-inset" : ""}`}
        style={{ height: btn, width: btn, fontSize: btnFont }}
        title={
          track.soloSafe
            ? "Solo-Safe Active (Ctrl+Click to toggle)"
            : "Solo (Ctrl+Click to toggle Solo-Safe)"
        }
        aria-label="Solo"
      >
        <span className="relative z-10">S</span>
        {track.soloSafe && (
          <span
            className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none select-none text-danger font-black text-xs"
            style={{ transform: "rotate(-25deg)" }}
          >
            /
          </span>
        )}
      </button>
    );

    const phaseBtn = (
      <button
        type="button"
        onClick={() => {
          const nextPol = isPolActive ? "none" : track.channels === 1 ? "left" : "both";
          lastPolarityEdit.current = Date.now();
          setOptimisticPolarity(nextPol);
          void mixer.setTrackTrim(index, track.inputTrimDb ?? 0, nextPol !== "none", nextPol);
        }}
        className={`flex items-center justify-center rounded border font-bold transition-all select-none ${
          isPolActive
            ? "border-[var(--rs-phase)]/70 bg-[var(--rs-phase)]/20 text-[var(--rs-phase)] font-black shadow-[0_0_6px_rgba(48,209,88,0.4)]"
            : "border-default/30 bg-surface/60 text-foreground/50 hover:bg-surface hover:text-foreground"
        }`}
        style={{ height: btn, width: btn, fontSize: Math.max(7, btnFont - 1) }}
        title={isPolActive ? `Phase Inverted (${track.polarity?.toUpperCase() ?? "ON"})` : "Phase Normal (Ø)"}
        aria-label="Phase Invert"
      >
        Ø
      </button>
    );

    const recBtn = (
      <ToggleButton
        size="xs"
        tone="danger-soft"
        isSelected={track.recordArmed ?? false}
        onChange={() => void mixer.setTrackRecordArm(index, !track.recordArmed)}
        className={
          track.recordArmed
            ? isRecording
              ? "bg-[var(--rs-record)] text-white shadow-[0_0_8px_rgba(255,69,58,0.7)] font-black"
              : "rs-recording-blink font-black"
            : undefined
        }
        style={{ height: btn, width: btn, fontSize: btnFont }}
        aria-label="Record Arm"
      >
        R
      </ToggleButton>
    );

    const monBtn = (
      <ToggleButton
        size="xs"
        tone="warning-soft"
        isSelected={track.inputMonitoring ?? false}
        onChange={() =>
          void mixer.setTrackInputMonitor(index, !track.inputMonitoring)
        }
        className={
          track.inputMonitoring
            ? "bg-[var(--rs-monitor)] text-black font-black shadow-[0_0_8px_rgba(255,159,10,0.5)]"
            : undefined
        }
        style={{ height: btn, width: btn, fontSize: btnFont }}
        aria-label="Input Monitoring"
      >
        I
      </ToggleButton>
    );

    const panControl = showPan && (
      <div
        className="flex shrink-0 items-center gap-0.5"
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
        {h >= 52 && (
          <span
            className="w-4 text-center font-mono font-medium text-foreground/50 text-[8px]"
          >
            {formatPan(pan)}
          </span>
        )}
      </div>
    );

    return (
      <div
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, [role='slider'], [role='button']")) return;
          onSelect?.();
        }}
        className={`flex flex-col justify-center border-b border-default/15 select-none overflow-hidden transition-all duration-200 cursor-pointer ${
          isSelected
            ? "bg-surface/90 border-l-[3px] border-l-accent shadow-[inset_0_0_12px_rgba(255,255,255,0.04)]"
            : "bg-surface/40 hover:bg-surface/70 border-l-[3px] border-l-transparent"
        } ${isDimmed ? "opacity-35" : "opacity-100"}`}
        style={{
          height: h,
          padding: `${padY}px ${padX}px`,
          gap: showVol ? 3 : 0,
        }}
      >
        {showVol ? (
          <>
            {/* Top row: swatch, icon, full track name, M/S on the right */}
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
              {track.kind === "instrument" ? (
                <Music size={11} className="shrink-0 text-purple-400" />
              ) : (
                <Mic size={11} className="shrink-0 text-foreground/40" />
              )}
              <span
                className={`min-w-0 flex-1 truncate font-semibold text-foreground/90 ${
                  track.mute ? "line-through opacity-40" : ""
                }`}
                style={{ fontSize: nameSize }}
                title={track.name || track.id}
              >
                {track.name || track.id}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {muteBtn}
                {soloBtn}
              </div>
            </div>

            {/* Bottom row: Ø, R, I, Pan, Volume Fader & dB */}
            <div className="flex shrink-0 items-center gap-1">
              {phaseBtn}
              {recBtn}
              {monBtn}
              {panControl}
              <div className="flex min-w-0 flex-1 items-center gap-1">
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
                  className="w-7 shrink-0 text-right font-mono font-medium tabular-nums text-foreground/60 hover:text-foreground cursor-ns-resize select-none transition-colors"
                  style={{ fontSize: Math.max(8, nameSize - 2) }}
                  title="Track volume (Drag up/down to adjust, double-click for 0 dB)"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    const startY = e.clientY;
                    const startVal = Number.isFinite(gain) ? gain : -60;

                    const onPointerMove = (ev: PointerEvent) => {
                      const dy = startY - ev.clientY;
                      const step = ev.shiftKey ? 0.1 : 0.5;
                      const next = Math.max(-60, Math.min(12, Math.round((startVal + dy * 0.15) / step) * step));
                      setGain(next);
                    };

                    const onPointerUp = () => {
                      window.removeEventListener("pointermove", onPointerMove);
                      window.removeEventListener("pointerup", onPointerUp);
                    };

                    window.addEventListener("pointermove", onPointerMove);
                    window.addEventListener("pointerup", onPointerUp);
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    setGain(0.0);
                  }}
                >
                  {gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)}
                </span>
              </div>
            </div>
          </>
        ) : (
          /* Compact single-row layout for zoomed out views */
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
            {track.kind === "instrument" ? (
              <Music size={11} className="shrink-0 text-purple-400" />
            ) : (
              <Mic size={11} className="shrink-0 text-foreground/40" />
            )}
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
              {panControl}
              {h >= 36 && phaseBtn}
              {recBtn}
              {h >= 36 && monBtn}
              {muteBtn}
              {soloBtn}
            </div>
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
    prev.isSelected === next.isSelected &&
    prev.onSelect === next.onSelect &&
    prev.track.id === next.track.id &&
    prev.track.name === next.track.name &&
    prev.track.recordArmed === next.track.recordArmed &&
    prev.track.inputMonitoring === next.track.inputMonitoring &&
    prev.track.mute === next.track.mute &&
    prev.track.solo === next.track.solo &&
    prev.track.soloSafe === next.track.soloSafe &&
    prev.track.gainDb === next.track.gainDb &&
    prev.track.pan === next.track.pan &&
    prev.track.polarity === next.track.polarity &&
    prev.track.phaseInvert === next.track.phaseInvert &&
    prev.isRecording === next.isRecording,
);
