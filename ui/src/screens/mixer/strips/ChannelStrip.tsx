import { useMemo } from "react";
import { LevelMeterBar } from "../../../components/daw";
import { Select } from "../../../components/ui";
import { useChannelClipHold } from "../../../hooks/useChannelClipHold";
import type { PluginCatalogEntry } from "../../../lib/state/api";
import { useLiveValue } from "../../../lib/state/optimistic";
import type {
  BusRow,
  ClickSendRow,
  PluginSlotRow,
  SettingsState,
} from "../../../lib/state/types";
import { ROUTING_SELECT_SIZE } from "../logic/constants";
import { GainFader } from "./GainFader";
import { GainPeakReadout } from "./GainPeakReadout";
import { PanControl } from "./PanControl";
import {
  StripInputControls,
  type StripFormatToggle,
  type StripInputRouting,
} from "./StripInputControls";
import { StripButton } from "./StripButton";
import { PluginInsertSlots } from "../plugins/PluginInsertSlots";
import { SendKnobs } from "./SendKnobs";
import { TrackOutputRouting } from "../routing/components/TrackOutputRouting";
import { RoutingSlotPlaceholder } from "../routing/components/RoutingSlotPlaceholder";

/** Stable identity so useLiveValue's commit ref doesn't churn. */
const noop = () => {};

export function ChannelStrip({
  stripId,
  name,
  subtitle,
  color,
  busses,
  busId,
  onBusSelect,
  directOutput,
  sends,
  busDestination,
  gainDb,
  pan,
  peakDb,
  peakDbL,
  peakDbR,
  getLiveDb,
  getLiveDbL,
  getLiveDbR,
  mute,
  solo,
  soloSafe = false,
  anySoloInGroup,
  recordArmed,
  inputMonitoring,
  isRecording = false,
  isMaster: _isMaster = false,
  shortTermLufs: _shortTermLufs,
  onRecordArm,
  onInputMonitor,
  formatToggle,
  inputRouting,
  pluginSlots = [],
  pluginCatalog = [],
  onPlugins,
  onGain,
  onPan,
  onMute,
  onSolo,
  onSoloSafe,
  density = "standard",
  targetPluginSlots,
}: {
  stripId: string;
  name: string;
  subtitle?: string;
  color: string;
  busses?: BusRow[];
  busId?: string;
  onBusSelect?: (id: string) => void;
  directOutput?: {
    settings: SettingsState;
    allBusses: BusRow[];
    mono?: boolean;
    onMonoChange?: (mono: boolean) => void;
    onDirectOutput: (
      mono: boolean,
      startChannel: number,
      pair: boolean,
    ) => void;
  };
  sends?: {
    auxBusses: BusRow[];
    values: ClickSendRow[];
    trackIndex: number;
    /** Overrides the default per-track write. `level` is 0-100 percent. */
    onSendChange?: (busId: string, level: number, enabled?: boolean) => void;
    onSendEnabledChange?: (busId: string, enabled: boolean) => void;
  };
  busDestination?: React.ReactNode;
  gainDb: number;
  pan: number | null;
  peakDb: number | undefined;
  peakDbL?: number;
  peakDbR?: number;
  getLiveDb?: () => number;
  getLiveDbL?: () => number;
  getLiveDbR?: () => number;
  mute: boolean;
  solo: boolean;
  soloSafe?: boolean;
  anySoloInGroup?: boolean;
  recordArmed?: boolean;
  inputMonitoring?: boolean;
  isRecording?: boolean;
  isMaster?: boolean;
  shortTermLufs?: number;
  onRecordArm?: () => void;
  onInputMonitor?: () => void;
  formatToggle?: StripFormatToggle;
  inputRouting?: StripInputRouting;
  pluginSlots?: PluginSlotRow[];
  pluginCatalog?: PluginCatalogEntry[];
  onPlugins?: () => void;
  onGain: (v: number) => void;
  onPan: ((v: number) => void) | null;
  onMute: () => void;
  onSolo: () => void;
  onSoloSafe?: (safe: boolean) => void;
  density?: "narrow" | "standard" | "wide";
  targetPluginSlots?: number;
}) {
  // ── What this strip currently SHOWS, as opposed to what the engine has
  // last confirmed ────────────────────────────────────────────────────────
  const [displayGainDb, commitGain] = useLiveValue(gainDb, onGain);
  const [displayPan, commitPan] = useLiveValue(pan ?? 0, onPan ?? noop);
  // If this strip is solo-safed, it is isolated and never dimmed by others' solos!
  const isDimmed = !!anySoloInGroup && !solo && !soloSafe;

  const stripLeftDb = peakDbL ?? peakDb ?? -100;
  const stripRightDb = peakDbR ?? peakDb ?? -100;
  const liveLeft = () => getLiveDbL?.() ?? getLiveDb?.() ?? stripLeftDb;
  const liveRight = () => getLiveDbR?.() ?? getLiveDb?.() ?? stripRightDb;
  const stripClip = useChannelClipHold(
    () => Math.max(liveLeft(), liveRight()),
    stripId,
  );

  const isNarrow = density === "narrow";
  const isWide = density === "wide";
  const widthClass = isNarrow
    ? "w-16 p-1 sm:p-1.5"
    : isWide
      ? "w-32 p-2.5"
      : "w-24 p-2";

  const audioFxSlots = useMemo(
    () => pluginSlots.filter((p) => !p.instrument),
    [pluginSlots],
  );
  const knobSize = isNarrow ? 20 : isWide ? 28 : 24;
  const meterBarClass = isNarrow
    ? "h-full w-1"
    : isWide
      ? "h-full w-2"
      : "h-full w-1.5";

  return (
    <div
      className={`flex h-full min-h-0 ${widthClass} shrink-0 select-none flex-col items-center justify-between rounded-xl border border-default/25 bg-background-secondary pb-1.5 transition-opacity duration-300 overflow-hidden ${
        isDimmed ? "opacity-35" : "opacity-100"
      }`}
    >
      {/* 1. Header / Identity with subtle 12% color tinting */}
      <div
        className="flex w-full min-w-0 flex-col items-center gap-1 rounded-t-lg px-1 py-1 text-center transition-colors"
        style={{
          backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        }}
      >
        <div
          className="h-0.75 w-full shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <div
          style={{
            color: `color-mix(in srgb, ${color} 100%, transparent)`,
          }}
          className="w-full min-w-0 truncate text-xs font-semibold"
          title={name}
        >
          {name}
        </div>
        {subtitle && !isNarrow && (
          <div
            style={{
              color: `color-mix(in srgb, ${color} 50%, transparent)`,
            }}
            className={`w-full min-w-0 truncate font-mono text-[9px] uppercase tracking-wide`}
            title={subtitle}
          >
            {subtitle}
          </div>
        )}
      </div>

      {/* 2. Top Format & Input Section */}
      <StripInputControls
        color={color}
        isNarrow={isNarrow}
        formatToggle={formatToggle}
        inputRouting={inputRouting}
      />

      {/* 3. Audio FX Section */}
      {onPlugins && (
        <PluginInsertSlots
          stripId={stripId}
          stripName={name}
          slots={audioFxSlots}
          slotIndexOffset={pluginSlots.some((slot) => slot.instrument) ? 1 : 0}
          catalog={pluginCatalog}
          density={density}
          targetSlotCount={targetPluginSlots}
          onOpenChain={onPlugins}
        />
      )}

      {/* 4. Sends Section with divider */}
      {sends && sends.auxBusses.length > 0 && (
        <div className="w-full my-0.5 border-t border-default/20 pt-1">
          <SendKnobs
            auxBusses={sends.auxBusses}
            sends={sends.values}
            trackIndex={sends.trackIndex}
            density={density}
            onSendChange={sends.onSendChange}
            onSendEnabledChange={sends.onSendEnabledChange}
          />
        </div>
      )}

      {/* 5. Output Routing Section (after sends) */}
      {((busses && onBusSelect) || busDestination) && (
        <div className="w-full my-0.5 border-t border-default/20 pt-1">
          {busses && onBusSelect && directOutput ? (
            <TrackOutputRouting
              busId={busId || ""}
              busses={busses}
              allBusses={directOutput.allBusses}
              settings={directOutput.settings}
              mono={directOutput.mono}
              onMonoChange={directOutput.onMonoChange}
              onBusSelect={onBusSelect}
              onDirectOutput={directOutput.onDirectOutput}
            />
          ) : busses && onBusSelect ? (
            <div className="my-0.5 flex w-full flex-col items-center gap-1">
              <Select
                aria-label="Output bus"
                size={ROUTING_SELECT_SIZE}
                options={busses.map((b) => ({
                  id: b.id,
                  label: b.name || b.id,
                }))}
                value={busId || ""}
                onChange={onBusSelect}
              />
              <RoutingSlotPlaceholder />
            </div>
          ) : null}

          {busDestination}
        </div>
      )}

      {/* 6. Pan / Balance Section */}
      {onPan && pan !== null ? (
        <PanControl
          value={displayPan}
          onChange={commitPan}
          size={knobSize}
        />
      ) : (
        <div className="h-0.5" />
      )}

      {/* 6. Gain Peak Readout & Master Broadcast Metering */}
      <div className="w-full px-0.5">
        <GainPeakReadout
          gainDb={displayGainDb}
          getLiveDb={() => (liveLeft() + liveRight()) / 2}
          clipped={stripClip.clipped}
          heldPeakDb={stripClip.heldPeakDb}
          onClear={stripClip.clear}
          onGainChange={commitGain}
          density={density}
        />
      </div>

      {/* Fader and Level Meter Bar */}
      <div className="flex min-h-0 flex-1 w-full items-stretch justify-center gap-1.5 py-0.5 overflow-hidden">
        <GainFader
          value={displayGainDb}
          onChange={commitGain}
          density={density}
        />
        <LevelMeterBar
          db={peakDb ?? -100}
          dbL={stripLeftDb}
          dbR={stripRightDb}
          getLiveDb={getLiveDb}
          getLiveDbL={getLiveDbL}
          getLiveDbR={getLiveDbR}
          accent={color}
          vertical={true}
          showValue={false}
          barClassName={meterBarClass}
          clipLatched={stripClip.clipped}
          onClearClip={stripClip.clear}
        />
      </div>

      {/* 7. Bottom controls: R/I row + M/S row */}
      <div className="mt-auto flex w-full shrink-0 flex-col gap-1 pt-1 px-1 border-t border-default/15">
        {(onRecordArm || onInputMonitor) && (
          <div className="flex w-full gap-1">
            <div className="flex-1" aria-hidden="true" />
            <div
              className={`flex flex-1 items-center ${isNarrow ? "gap-0.5" : "gap-1"}`}
            >
              {onRecordArm && (
                <button
                  type="button"
                  onClick={onRecordArm}
                  title={
                    recordArmed
                      ? isRecording
                        ? "Recording active"
                        : "Record Armed (Click to disarm)"
                      : "Record Arm (Click to arm)"
                  }
                  aria-label="Record Arm"
                  className={`relative flex h-4.5 flex-1 items-center justify-center rounded border text-[9px] font-bold transition-all select-none ${
                    recordArmed
                      ? isRecording
                        ? "border-(--rs-record) bg-(--rs-record) text-white shadow-[0_0_8px_rgba(255,59,48,0.7)]"
                        : "border-(--rs-record) bg-(--rs-record)/20 text-(--rs-record) rs-recording-blink font-bold"
                      : "border-default/30 bg-surface/60 text-foreground/75 hover:border-(--rs-record)/60 hover:text-(--rs-record)"
                  }`}
                >
                  {isRecording ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-white shadow-sm" />
                  ) : (
                    "R"
                  )}
                </button>
              )}
              {onInputMonitor && (
                <button
                  type="button"
                  onClick={onInputMonitor}
                  title={
                    inputMonitoring
                      ? "Input Monitoring Active"
                      : "Input Monitoring"
                  }
                  aria-label="Input Monitoring"
                  className={`relative flex h-4.5 flex-1 items-center justify-center rounded border text-[9px] font-bold transition-all select-none ${
                    inputMonitoring
                      ? "border-(--rs-monitor) bg-(--rs-monitor) text-black font-bold shadow-[0_0_8px_rgba(255,149,0,0.5)]"
                      : "border-default/30 bg-surface/60 text-foreground/75 hover:bg-surface hover:text-foreground"
                  }`}
                >
                  I
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex w-full gap-1">
          <StripButton
            active={mute}
            variant="mute"
            blink={isDimmed && !mute}
            title={mute ? "Mute (Active)" : "Mute"}
            onPress={() => onMute()}
          >
            M
          </StripButton>
          <StripButton
            active={solo}
            variant="solo"
            soloSafe={soloSafe}
            title={
              soloSafe
                ? "Solo-Safe Isolate Active (Ctrl+Click or Right-Click to toggle)"
                : "Solo (Ctrl+Click or Right-Click to toggle Solo-Safe)"
            }
            onPress={(e) => {
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                onSoloSafe?.(!soloSafe);
              } else {
                onSolo();
              }
            }}
            onContextMenu={(e) => {
              if (onSoloSafe) {
                e.preventDefault();
                onSoloSafe(!soloSafe);
              }
            }}
          >
            S
          </StripButton>
        </div>
      </div>
    </div>
  );
}
