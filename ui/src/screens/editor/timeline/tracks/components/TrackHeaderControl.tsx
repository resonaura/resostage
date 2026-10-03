/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo, useEffect, useRef, useState } from "react";
import { mixer } from "@/lib/state/api";
import { getTrackLiveLevel } from "@/lib/audio/liveLevels";
import type { TrackRow } from "@/lib/state/types";
import {
  LevelMeterBar,
  TrackPanControl,
} from "@/components/daw";
import { TOGGLE_BLINK_ACCENT, ToggleButton } from "@/components/ui";
import { trackSelectionGesture, type TrackSelectionGesture } from "@/screens/editor/timeline/tracks/logic/trackSelection";
import { getTrackHeaderLayout } from "@/screens/editor/timeline/tracks/logic/trackHeaderLayout";
import { useTrackPanControl } from "@/screens/editor/timeline/tracks/hooks/useTrackPanControl";
import { useTrackGainControl } from "@/screens/editor/timeline/tracks/hooks/useTrackGainControl";
import { formatPan } from "@/components/daw/logic/panLaw";
import { TrackGainControl } from "@/screens/editor/timeline/tracks/components/TrackGainControl";
import { TrackIdentityLabel } from "@/screens/editor/timeline/tracks/components/TrackIdentityLabel";

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
    isFocused = false,
    onSelect,
    onGainDragStart,
    onGainDragMove,
    onGainDragEnd,
    onGainDragCancel,
    onPanDragStart,
    onPanDragMove,
    onPanDragEnd,
    onPanDragCancel,
  }: {
    track: TrackRow;
    index: number;
    color: string;
    verticalZoom: number;
    anySolo?: boolean;
    isRecording?: boolean;
    isSelected?: boolean;
    isFocused?: boolean;
    onSelect?: (gesture?: TrackSelectionGesture) => void;
    onGainDragStart?: (initialGain: number) => void;
    onGainDragMove?: (gain: number) => void;
    onGainDragEnd?: (finalGain: number) => void;
    onGainDragCancel?: (originalGain: number) => void;
    onPanDragStart?: (initialPan: number) => void;
    onPanDragMove?: (pan: number) => void;
    onPanDragEnd?: (finalPan: number) => void;
    onPanDragCancel?: (originalPan: number) => void;
  }) {
    const gain = useTrackGainControl(track, index, {
      onDragStart: onGainDragStart,
      onDragMove: onGainDragMove,
      onDragEnd: onGainDragEnd,
      onDragCancel: onGainDragCancel,
    });
    const pan = useTrackPanControl(track, index, {
      onDragStart: onPanDragStart,
      onDragMove: onPanDragMove,
      onDragEnd: onPanDragEnd,
      onDragCancel: onPanDragCancel,
    });

    const isDimmed = anySolo && !track.solo && !track.soloSafe;
    const isMidiInputTrack =
      track.kind === "instrument" ||
      track.kind === "midi" ||
      track.kind === "externalMidi";
    const hasAudioInput =
      (track.kind === "audio" || track.kind == null) &&
      track.inputSource !== "none";
    const canRecord = hasAudioInput || isMidiInputTrack;
    const canMonitorInput = hasAudioInput || isMidiInputTrack;
    const layout = getTrackHeaderLayout(verticalZoom);
    const {
      height: h,
      showVolume: showVol,
      showPan,
      showMeter,
      verticalPadding: padY,
      horizontalPadding: padX,
      nameSize,
      buttonSize: btn,
      buttonFontSize: btnFont,
      knobSize,
      meterHeight: meterH,
      faderHeight: faderH,
      swatchHeight: swatchH,
      swatchWidth: swatchW,
    } = layout;

    // Optimistic polarity: instant visual toggle, 1200ms lock against stale echo
    const [optimisticPolarity, setOptimisticPolarity] = useState<
      "left" | "right" | "none" | "both" | null
    >(null);
    const lastPolarityEdit = useRef(0);
    useEffect(() => {
      if (Date.now() - lastPolarityEdit.current > 1200) {
        setOptimisticPolarity(null);
      }
    }, [track.polarity, track.phaseInvert]);

    const effectivePolarity: "left" | "right" | "none" | "both" =
      optimisticPolarity ??
      track.polarity ??
      (track.phaseInvert ? "both" : "none");
    const isPolActive = effectivePolarity !== "none";

    const muteBtn = (
      <button
        type="button"
        onClick={() => void mixer.setTrackMute(index, !track.mute)}
        className={`flex items-center justify-center rounded border font-bold transition-all select-none ${
          track.mute
            ? "bg-(--rs-mute) text-white border-(--rs-mute) shadow-[0_0_6px_rgba(0,122,255,0.5)] font-black"
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
            ? "bg-(--rs-solo) text-black border-(--rs-solo) shadow-[0_0_6px_rgba(255,214,10,0.5)] font-black"
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
          const nextPol = isPolActive
            ? "none"
            : track.channels === 1
              ? "left"
              : "both";
          lastPolarityEdit.current = Date.now();
          setOptimisticPolarity(nextPol);
          void mixer.setTrackTrim(
            index,
            track.inputTrimDb ?? 0,
            nextPol !== "none",
            nextPol,
          );
        }}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        className={`flex items-center justify-center rounded border font-bold transition-all select-none ${
          isPolActive
            ? "border-(--rs-phase)/70 bg-(--rs-phase)/20 text-(--rs-phase) font-black shadow-[0_0_6px_rgba(48,209,88,0.4)]"
            : "border-default/30 bg-surface/60 text-foreground/50 hover:bg-surface hover:text-foreground"
        }`}
        style={{ height: btn, width: btn, fontSize: Math.max(7, btnFont - 1) }}
        title={
          isPolActive
            ? `Phase Inverted (${track.polarity?.toUpperCase() ?? "ON"})`
            : "Phase Normal (Ø)"
        }
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
        onChange={() => {
          onSelect?.("replace");
          void mixer.setTrackRecordArm(index, !track.recordArmed);
        }}
        className={
          track.recordArmed
            ? isRecording
              ? "bg-(--rs-record) text-white shadow-[0_0_8px_rgba(255,69,58,0.7)] font-black"
              : "rs-recording-blink font-black"
            : isFocused
              ? "font-black"
              : undefined
        }
        style={{
          height: btn,
          width: btn,
          fontSize: btnFont,
          color:
            isFocused && !track.recordArmed ? "var(--rs-record)" : undefined,
        }}
        aria-label={
          track.recordArmed
            ? "Record armed"
            : isFocused
              ? "Focused track — click to record-arm"
              : "Record arm"
        }
      >
        R
      </ToggleButton>
    );

    const monBtn = (
      <ToggleButton
        size="xs"
        tone="warning-soft"
        isSelected={track.inputMonitoring ?? false}
        onChange={() => {
          onSelect?.("replace");
          void mixer.setTrackInputMonitor(index, !track.inputMonitoring);
        }}
        className={
          track.inputMonitoring
            ? "bg-(--rs-monitor) text-black font-black shadow-[0_0_8px_rgba(255,159,10,0.5)]"
            : isFocused
              ? "font-black"
              : undefined
        }
        style={{
          height: btn,
          width: btn,
          fontSize: btnFont,
          color:
            isFocused && !track.inputMonitoring
              ? "var(--rs-monitor)"
              : undefined,
        }}
        aria-label={
          track.inputMonitoring
            ? "Input monitoring enabled"
            : isFocused && isMidiInputTrack
              ? "Focused MIDI input is auditioned automatically; click I to monitor it alongside other tracks"
              : isFocused && hasAudioInput
                ? "Focused audio input is monitored automatically; click I to keep monitoring it after focus changes"
                : isFocused
                  ? "Focused track — click to monitor input"
                  : "Input monitoring"
        }
      >
        I
      </ToggleButton>
    );

    const panControl = showPan && (
      <TrackPanControl
        value={pan.value}
        automationValue={pan.value === (track.pan ?? 0) ? track.automatedPan : null}
        valueLabel={pan.value !== (track.pan ?? 0)
          ? formatPan(pan.value)
          : track.automatedPan != null
            ? formatPan(track.automatedPan)
            : pan.valueLabel}
        trackName={track.name || track.id}
        activePanLaw={pan.activePanLaw}
        panLaws={pan.panLaws}
        menuPosition={pan.menuPosition}
        color={color}
        knobSize={knobSize}
        showPanValue={h >= 52}
        midiTarget={pan.midiTarget}
        onCommit={pan.setValue}
        onDragStart={pan.onDragStart}
        onDragEnd={pan.onDragEnd}
        onDragCancel={pan.onDragCancel}
        onContextMenu={pan.onContextMenu}
        onCloseMenu={pan.onCloseMenu}
        onSelectPanLaw={pan.onSelectPanLaw}
      />
    );

    return (
      <div
        onClick={(e) => {
          if (
            (e.target as HTMLElement).closest(
              "button, input, [role='slider'], [role='button']",
            )
          )
            return;
          onSelect?.(trackSelectionGesture(e));
        }}
        // Keep height changes synchronous with the corresponding timeline lane;
        // transitioning `all` made the left rail visibly trail vertical zoom.
        className={`flex flex-col justify-center border-b border-default/15 select-none overflow-hidden transition-colors duration-200 cursor-pointer ${
          isSelected
            ? "bg-surface/90 border-l-[3px] shadow-[inset_0_0_12px_rgba(255,255,255,0.04)]"
            : "bg-surface/40 hover:bg-surface/70 border-l-[3px] border-l-transparent"
        } ${isDimmed ? "opacity-35" : "opacity-100"}`}
        style={{
          height: h,
          padding: `${padY}px ${padX}px`,
          gap: showVol ? 3 : 0,
          ...(isSelected ? { borderLeftColor: color } : {}),
        }}
      >
        {showVol ? (
          <>
            {/* Top row: swatch, icon, full track name, M/S on the right */}
            <div className="flex min-h-0 min-w-0 flex-1 items-center gap-1.5">
              <TrackIdentityLabel
                track={track}
                color={color}
                nameSize={nameSize}
                swatchHeight={swatchH}
                swatchWidth={swatchW}
              />
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {muteBtn}
                {soloBtn}
              </div>
            </div>

            {/* Bottom row: Ø, R, I, Pan, Volume Fader & dB */}
            <div className="flex shrink-0 items-center gap-1">
              {phaseBtn}
              {canRecord && recBtn}
              {canMonitorInput && monBtn}
              {panControl}
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <TrackGainControl
                  track={track}
                  gain={gain.gain}
                  color={color}
                  nameSize={nameSize}
                  faderHeight={faderH}
                  onGainChange={gain.setGain}
                  onDragStart={gain.onDragStart}
                  onDragEnd={gain.onDragEnd}
                  onDragCancel={gain.onDragCancel}
                  onReadoutPointerDown={gain.onReadoutPointerDown}
                  onReadoutDoubleClick={gain.onReadoutDoubleClick}
                />
              </div>
            </div>
          </>
        ) : (
          /* Compact single-row layout for zoomed out views */
          <div className="flex min-h-0 min-w-0 flex-1 items-center gap-1.5">
            <TrackIdentityLabel
              track={track}
              color={color}
              nameSize={nameSize}
              swatchHeight={swatchH}
              swatchWidth={swatchW}
            />
            {showMeter && (
              <div className="w-3 shrink-0" style={{ height: meterH }}>
                <LevelMeterBar
                  db={track.peakDb ?? -100}
                  dbL={track.peakDbL ?? track.peakDb ?? -100}
                  dbR={track.peakDbR ?? track.peakDb ?? -100}
                  getLiveDbL={() =>
                    getTrackLiveLevel(track.id)?.peakDbL ?? -144
                  }
                  getLiveDbR={() =>
                    getTrackLiveLevel(track.id)?.peakDbR ?? -144
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
              {canRecord && recBtn}
              {h >= 36 && canMonitorInput && monBtn}
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
    prev.isFocused === next.isFocused &&
    prev.onSelect === next.onSelect &&
    prev.track.id === next.track.id &&
    prev.track.name === next.track.name &&
    prev.track.recordArmed === next.track.recordArmed &&
    prev.track.inputMonitoring === next.track.inputMonitoring &&
    prev.track.mute === next.track.mute &&
    prev.track.solo === next.track.solo &&
    prev.track.soloSafe === next.track.soloSafe &&
    prev.track.gainDb === next.track.gainDb &&
    prev.track.automatedGainDb === next.track.automatedGainDb &&
    prev.track.pan === next.track.pan &&
    prev.track.automatedPan === next.track.automatedPan &&
    prev.track.panLaw === next.track.panLaw &&
    prev.track.polarity === next.track.polarity &&
    prev.track.phaseInvert === next.track.phaseInvert &&
    prev.isRecording === next.isRecording,
);
