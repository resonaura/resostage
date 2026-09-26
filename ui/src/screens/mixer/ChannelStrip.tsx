import { useMemo } from "react";
import { Knob, LevelMeterBar } from "../../components/daw";
import { Button, Select, TOGGLE_BLINK_ACCENT, type SelectOption } from "../../components/ui";
import { useChannelClipHold } from "../../hooks/useChannelClipHold";
import type { PluginCatalogEntry } from "../../lib/api";
import { useLiveValue } from "../../lib/optimistic";
import type {
  BusRow,
  ClickSendRow,
  PluginSlotRow,
  SettingsState,
} from "../../lib/types";
import { ROUTING_SELECT_SIZE } from "./constants";
import { GainFader } from "./GainFader";
import { GainPeakReadout } from "./GainPeakReadout";
import { MonoStereoIcon } from "./MonoStereoIcon";
import { PluginInsertSlots } from "./PluginInsertSlots";
import { SendKnobs } from "./SendKnobs";
import { TrackOutputRouting } from "./TrackOutputRouting";
import { RoutingSlotPlaceholder } from "./RoutingSlotPlaceholder";

/** Stable identity so useLiveValue's commit ref doesn't churn. */
const noop = () => {};

/**
 * Mute / Solo.
 *
 * Soft tones rather than a saturated fill: a console is a wall of these, and
 * twelve solid red blocks read as an error state rather than as twelve
 * controls. The soft tones still carry full-strength foreground colour (see
 * styles/tones.css), so an engaged mute is unmistakable from across a stage
 * without shouting when it is off.
 */
function StripButton({
  active,
  variant,
  soloSafe = false,
  blink,
  children,
  onPress,
  onContextMenu,
  title,
}: {
  active: boolean;
  variant: "mute" | "solo";
  soloSafe?: boolean;
  blink?: boolean;
  children: React.ReactNode;
  onPress: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
}) {
  const isMute = variant === "mute";

  // Apple Logic Pro X semantic tokens
  const activeClass = isMute
    ? "bg-[var(--rs-mute)] text-white border-[var(--rs-mute)] shadow-[0_0_8px_rgba(0,122,255,0.6)] font-black"
    : "bg-[var(--rs-solo)] text-black border-[var(--rs-solo)] shadow-[0_0_8px_rgba(255,214,10,0.6)] font-black";

  const inactiveClass =
    "bg-surface/60 text-foreground/75 border-default/30 hover:bg-surface hover:text-foreground";

  return (
    <button
      type="button"
      onClick={onPress}
      onContextMenu={onContextMenu}
      title={title}
      className={`relative flex h-6 flex-1 items-center justify-center rounded border text-[11px] font-bold transition-all select-none ${
        active ? activeClass : inactiveClass
      } ${blink ? TOGGLE_BLINK_ACCENT : ""} ${
        soloSafe ? "ring-1 ring-danger ring-inset" : ""
      }`}
    >
      <span className="relative z-10 flex items-center justify-center">
        {children}
      </span>
      {soloSafe && (
        <span
          className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none select-none text-danger font-black text-sm"
          style={{ transform: "rotate(-25deg)" }}
        >
          /
        </span>
      )}
    </button>
  );
}

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
  formatToggle?: {
    stereo: boolean;
    onToggle: () => void;
  };
  inputRouting?: {
    isInstrument: boolean;
    instrumentName?: string | null;
    instrumentSlotId?: string;
    onOpenInstrument?: () => void;
    onInstrumentMenu?: (pos: { x: number; y: number }) => void;
    inputOptions?: SelectOption[];
    currentInput?: string;
    onInputChange?: (source: string) => void;
    polarity?: "none" | "left" | "right" | "both";
    onTogglePolarity?: () => void;
    onPolarityMenu?: (pos: { x: number; y: number }) => void;
    trimDb?: number;
    onTrimChange?: (trim: number) => void;
  };
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
  const formatPan = (p: number) => {
    if (Math.abs(p) < 0.05) return "C";
    if (p < 0) return `L${Math.round(-p * 100)}`;
    return `R${Math.round(p * 100)}`;
  };

  // ── What this strip currently SHOWS, as opposed to what the engine has
  // last confirmed ────────────────────────────────────────────────────────
  const [displayGainDb, commitGain] = useLiveValue(gainDb, onGain);
  const [displayPan, commitPan] = useLiveValue(pan ?? 0, onPan ?? noop);
  const [displayTrimDb, commitTrimDb] = useLiveValue(
    inputRouting?.trimDb ?? 0,
    inputRouting?.onTrimChange ?? noop,
  );

  const handleTrimPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!inputRouting?.onTrimChange) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    const startY = e.clientY;
    const startVal = displayTrimDb;

    const onPointerMove = (ev: PointerEvent) => {
      const dy = startY - ev.clientY;
      const sensitivity = ev.shiftKey ? 0.02 : 0.15;
      const step = ev.shiftKey ? 0.05 : 0.1;
      const raw = startVal + dy * sensitivity;
      const next = Math.max(-24, Math.min(24, Math.round(raw / step) * step));
      commitTrimDb(Math.round(next * 100) / 100);
    };

    const onPointerUp = (ev: PointerEvent) => {
      try {
        if (e.currentTarget.hasPointerCapture(ev.pointerId)) {
          e.currentTarget.releasePointerCapture(ev.pointerId);
        }
      } catch {}
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const isPolarityActive =
    inputRouting?.polarity && inputRouting.polarity !== "none";

  // If this strip is solo-safed, it is isolated and never dimmed by others' solos!
  const isDimmed = !!anySoloInGroup && !solo && !soloSafe;

  const stripLeftDb = peakDbL ?? peakDb ?? -100;
  const stripRightDb = peakDbR ?? peakDb ?? -100;
  const liveLeft = () => getLiveDbL?.() ?? getLiveDb?.() ?? stripLeftDb;
  const liveRight = () => getLiveDbR?.() ?? getLiveDb?.() ?? stripRightDb;
  const stripClip = useChannelClipHold(() => Math.max(liveLeft(), liveRight()));

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
      {(formatToggle || inputRouting) && (
        <div className="my-1 flex w-full flex-col gap-1">
          {formatToggle && (
            <div className="my-0.5 flex w-full items-center justify-center">
              <Button
                size="sm"
                variant="ghost"
                isIconOnly
                className="size-6 min-w-0 text-foreground/60 hover:text-foreground hover:bg-surface/80"
                aria-label={
                  formatToggle.stereo
                    ? "Stereo (click for mono)"
                    : "Mono (click for stereo)"
                }
                onPress={formatToggle.onToggle}
              >
                <MonoStereoIcon stereo={formatToggle.stereo} />
              </Button>
            </div>
          )}

          {inputRouting?.isInstrument ? (
            <div
              className={`flex h-[22px] w-full min-w-0 items-center justify-between rounded border text-xs font-semibold transition-all ${
                inputRouting.instrumentName
                  ? "border-emerald-500/70 bg-emerald-600/25 text-emerald-300 hover:bg-emerald-600/35 shadow-[0_1px_4px_rgba(16,185,129,0.2)]"
                  : "border-dashed border-emerald-500/40 text-emerald-400/60 hover:border-emerald-500/70 hover:bg-emerald-500/10 hover:text-emerald-300"
              }`}
            >
              <button
                type="button"
                onClick={(e) => {
                  if (inputRouting.instrumentSlotId) {
                    inputRouting.onOpenInstrument?.();
                  } else {
                    inputRouting.onInstrumentMenu?.({ x: e.clientX, y: e.clientY });
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  inputRouting.onInstrumentMenu?.({ x: e.clientX, y: e.clientY });
                }}
                title={
                  inputRouting.instrumentName
                    ? `Software Instrument: ${inputRouting.instrumentName} (Click to open UI, right-click to change)`
                    : "Add Software Instrument (Click to choose)"
                }
                className="flex h-full flex-1 min-w-0 items-center px-1.5 truncate text-left"
              >
                <span className="truncate">
                  {inputRouting.instrumentName || (isNarrow ? "+ Inst" : "+ Instrument")}
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  inputRouting.onInstrumentMenu?.({ x: e.clientX, y: e.clientY });
                }}
                title="Choose Software Instrument"
                className="flex h-full px-1 items-center justify-center opacity-60 hover:opacity-100 text-[10px] select-none"
              >
                ⇅
              </button>
            </div>
          ) : inputRouting?.inputOptions && inputRouting.onInputChange ? (
            <div className="w-full min-w-0">
              <Select
                aria-label="Input routing"
                size={ROUTING_SELECT_SIZE}
                options={inputRouting.inputOptions}
                value={inputRouting.currentInput ?? ""}
                onChange={inputRouting.onInputChange}
              />
            </div>
          ) : null}

          {inputRouting?.onTogglePolarity && (
            <div className="flex w-full items-center justify-between px-0.5 text-[9px]">
              <button
                type="button"
                onClick={inputRouting.onTogglePolarity}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  inputRouting.onPolarityMenu?.({ x: e.clientX, y: e.clientY });
                }}
                title={
                  isPolarityActive
                    ? `Polarity Inverted (${inputRouting.polarity?.toUpperCase()}) — right-click for L/R options`
                    : "Polarity Normal (0°) — click to invert, right-click for L/R options"
                }
                className={`flex h-4 px-1 items-center justify-center rounded border transition-colors ${
                  isPolarityActive
                    ? "border-[var(--rs-phase)]/60 bg-[var(--rs-phase)]/20 text-[var(--rs-phase)] font-black shadow-[0_0_6px_rgba(48,209,88,0.4)]"
                    : "border-default/20 text-foreground/45 hover:text-foreground/80 hover:bg-surface/50"
                }`}
                aria-label="Phase Invert"
              >
                {inputRouting.polarity === "left"
                  ? "Ø L"
                  : inputRouting.polarity === "right"
                    ? "Ø R"
                    : "Ø"}
              </button>

              <span
                className="font-mono text-foreground/50 hover:text-foreground cursor-ns-resize transition-colors select-none px-1 rounded hover:bg-surface/60"
                title="Input Trim dB (Drag up/down like a knob, Shift for fine, double-click for 0.0dB)"
                onPointerDown={handleTrimPointerDown}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  commitTrimDb(0.0);
                }}
              >
                {displayTrimDb === 0
                  ? "±0.0dB"
                  : `${displayTrimDb > 0 ? "+" : ""}${displayTrimDb.toFixed(1)}dB`}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 3. Audio FX Section */}
      {onPlugins && (
        <PluginInsertSlots
          stripId={stripId}
          stripName={name}
          slots={audioFxSlots}
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
        <div className="my-0.5 flex flex-col items-center gap-0.5">
          <Knob
            value={displayPan}
            min={-1}
            max={1}
            defaultValue={0}
            accent="color-mix(in oklab, var(--foreground) 90%, transparent)"
            onCommit={commitPan}
            size={knobSize}
            title="Pan"
          />
          <div
            className="font-mono text-[8.5px] text-foreground/50 hover:text-foreground cursor-ns-resize select-none transition-colors"
            title="Pan (Drag up/down to adjust, double-click for Center)"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              const startY = e.clientY;
              const startVal = displayPan;

              const onPointerMove = (ev: PointerEvent) => {
                const dy = startY - ev.clientY;
                const step = ev.shiftKey ? 0.01 : 0.05;
                const next = Math.max(
                  -1,
                  Math.min(1, Math.round((startVal + dy * 0.01) / step) * step),
                );
                commitPan(next);
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
              commitPan(0);
            }}
          >
            {formatPan(displayPan)}
          </div>
        </div>
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
            <div className={`flex flex-1 items-center ${isNarrow ? "gap-0.5" : "gap-1"}`}>
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
                  className={`relative flex h-[18px] flex-1 items-center justify-center rounded border text-[9px] font-bold transition-all select-none ${
                    recordArmed
                      ? isRecording
                        ? "border-[var(--rs-record)] bg-[var(--rs-record)] text-white shadow-[0_0_8px_rgba(255,59,48,0.7)]"
                        : "border-[var(--rs-record)] bg-[var(--rs-record)]/20 text-[var(--rs-record)] rs-recording-blink font-bold"
                      : "border-default/30 bg-surface/60 text-foreground/75 hover:border-[var(--rs-record)]/60 hover:text-[var(--rs-record)]"
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
                  className={`relative flex h-[18px] flex-1 items-center justify-center rounded border text-[9px] font-bold transition-all select-none ${
                    inputMonitoring
                      ? "border-[var(--rs-monitor)] bg-[var(--rs-monitor)] text-black font-bold shadow-[0_0_8px_rgba(255,149,0,0.5)]"
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
