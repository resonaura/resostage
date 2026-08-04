import { ScrollShadow, Slider } from "@heroui/react";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../components/ContextMenu";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FontIcon } from "../components/FontIcon";
import {
  CLIP_COLOR,
  CLIP_GLOW,
  LevelMeterBar,
  useChannelClipHold,
} from "../components/LevelMeterBar";
import { Knob } from "../components/Knob";
import { SEND_FLOOR_DB, SendArcKnob } from "../components/SendArcKnob";
import { builder, mixer } from "../lib/api";
import { getClickPeaks, getLiveLevels } from "../lib/liveLevels";
import { useLiveValue } from "../lib/optimistic";
import type { BusRow, SettingsState, TrackRow, WebUiState } from "../lib/types";

// Sentinel value for the track/bus output <select>: picking it reveals a
// secondary channel-list dropdown instead of immediately committing a
// change (mirrors the two-step "pick a category, then pick specifics" UX
// used for everything else in this screen -- no huge flat list of every
// channel dumped into the primary select).
const EXT_OUTPUT_VALUE = "__ext_output__";

function MonoStereoIcon({
  stereo,
  size = 13,
}: {
  stereo: boolean;
  size?: number;
}) {
  if (!stereo) {
    return (
      <span
        className="inline-block shrink-0 rounded-full border-[1.5px] border-current"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size * 1.6, height: size }}
    >
      <span
        className="absolute left-0 top-0 rounded-full border-[1.5px] border-current"
        style={{ width: size, height: size }}
      />
      <span
        className="absolute right-0 top-0 rounded-full border-[1.5px] border-current opacity-60"
        style={{ width: size, height: size }}
      />
    </span>
  );
}

// Enumerates the physical-output picks available for "direct to output"
// routing: single channels when mono, adjacent pairs ("1/2", "3/4", ...)
// when stereo, skipping any channel the user has deactivated in Settings.
function directOutputOptions(
  settings: SettingsState,
  stereo: boolean,
): { label: string; startChannel: number }[] {
  const count = settings.outputChannelNames.length;
  const isActive = (i: number) => settings.activeOutputChannels[i] !== false;
  const options: { label: string; startChannel: number }[] = [];
  if (stereo) {
    for (let i = 0; i + 1 < count; i += 2) {
      if (isActive(i) && isActive(i + 1))
        options.push({ label: `${i + 1}/${i + 2}`, startChannel: i });
    }
  } else {
    for (let i = 0; i < count; i++) {
      if (isActive(i)) options.push({ label: `${i + 1}`, startChannel: i });
    }
  }
  return options;
}

const TRACK_COLORS = [
  "#0091ff",
  "#30d158",
  "#ff9230",
  "#db34f2",
  "#ff375f",
  "#00d2e0",
  "#ff4245",
  "#6d7cff",
  "#00dac3",
  "#3cd3fe",
  "#ffd600",
  "#b78a66",
];
function colorForIndex(i: number): string {
  return TRACK_COLORS[i % TRACK_COLORS.length];
}

const GAIN_MIN = -60;
const GAIN_MAX = 12;

function GainFader({
  gainDb,
  onChange,
  defaultValue = 0,
}: {
  gainDb: number;
  accent?: string;
  onChange: (v: number) => void;
  defaultValue?: number;
}) {
  const [value, handleChange] = useLiveValue(gainDb, onChange);
  return (
    <div
      className="h-full"
      title="Double-click to reset"
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleChange(defaultValue);
      }}
    >
      <Slider
        value={value}
        onChange={(v) => handleChange(Array.isArray(v) ? v[0] : v)}
        minValue={GAIN_MIN}
        maxValue={GAIN_MAX}
        step={0.1}
        orientation="vertical"
        aria-label="Gain"
        className="h-full"
      >
        <Slider.Track
          className="relative h-full w-2.5 rounded-full bg-background/50"
          style={{ borderBottomColor: "var(--surface)" }}
        >
          <Slider.Fill style={{ backgroundColor: "var(--surface)" }} />
          <Slider.Thumb
            style={
              {
                backgroundColor: "var(--surface)",
              } as any
            }
          />
        </Slider.Track>
      </Slider>
    </div>
  );
}

function formatDbReadout(v: number): string {
  if (!Number.isFinite(v) || v <= -100) return "-inf";
  // Clamp display so a backend glitch can't render "+463.0" on the strip.
  const c = Math.max(-100, Math.min(24, v));
  return c > 0 ? `+${c.toFixed(1)}` : c.toFixed(1);
}

// Logic Pro-style channel-strip readout: fader value on the left (plain,
// static), actual level on the right. The right box normally tracks the
// live level (average of L/R) and updates continuously; the moment either
// channel clips (>0 dBFS) it latches red and freezes on the loudest peak
// seen, same "held forever until clicked" convention as LevelMeterBar's own
// clip band -- and shares that exact clip state (see useChannelClipHold)
// so clicking either one clears both together.
function GainPeakReadout({
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

function SendKnobs({
  auxBusses,
  sends,
  trackIndex,
  onSendChange,
  onRemoveSend,
}: {
  auxBusses: BusRow[];
  sends: { busId: string; gainDb: number }[];
  trackIndex: number;
  onSendChange?: (busId: string, gainDb: number) => void;
  // Real per-track sends only (see mixer.removeTrackSend) -- click sends
  // (onSendChange set) are a different, song-scoped structure with their own
  // `enabled` flag instead of true removal, so this stays undefined there.
  onRemoveSend?: (busId: string) => void;
}) {
  const [removeMenu, setRemoveMenu] = useState<{
    x: number;
    y: number;
    busId: string;
    busName: string;
  } | null>(null);

  if (auxBusses.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-1 border-t border-default/20 py-1">
      {auxBusses.map((bus) => {
        const existing = sends.find((s) => s.busId === bus.id);
        const value = existing?.gainDb ?? SEND_FLOOR_DB;
        return (
          <div
            key={bus.id}
            className="flex items-center justify-between gap-1 w-full px-0.5"
          >
            <span
              className="truncate text-[9px] font-mono font-medium max-w-[48px] text-foreground/70"
              title={bus.name || bus.id}
            >
              {bus.name || bus.id}
            </span>
            <SendArcKnob
              value={value}
              min={SEND_FLOOR_DB}
              max={6}
              busColor="rgba(255,255,255,0.9)"
              title={`Send to ${bus.name || bus.id} (right-click to remove)`}
              onChange={(v) =>
                onSendChange
                  ? onSendChange(bus.id, v)
                  : mixer.setTrackSend(trackIndex, bus.id, v)
              }
              onContextMenu={
                onRemoveSend && existing
                  ? (e) => {
                      e.preventDefault();
                      setRemoveMenu({
                        x: e.clientX,
                        y: e.clientY,
                        busId: bus.id,
                        busName: bus.name || bus.id,
                      });
                    }
                  : undefined
              }
            />
          </div>
        );
      })}
      {removeMenu && onRemoveSend && (
        <ContextMenu
          x={removeMenu.x}
          y={removeMenu.y}
          width={150}
          onClose={() => setRemoveMenu(null)}
        >
          <ContextMenuItem
            danger
            onClick={() => {
              onRemoveSend(removeMenu.busId);
              setRemoveMenu(null);
            }}
          >
            Remove Send to {removeMenu.busName}
          </ContextMenuItem>
        </ContextMenu>
      )}
    </div>
  );
}

function TrackOutputRouting({
  busId,
  busses,
  settings,
  mono = false,
  onMonoChange,
  onBusSelect,
  onDirectOutput,
}: {
  busId: string;
  busses: BusRow[];
  settings: SettingsState;
  /** Omit both mono and onMonoChange for a strip with nothing meaningful to
   * sum to mono (e.g. the metronome click) -- the toggle just won't render,
   * rather than sitting there as a button that does nothing. */
  mono?: boolean;
  onMonoChange?: (mono: boolean) => void;
  onBusSelect: (id: string) => void;
  onDirectOutput: (mono: boolean, startChannel: number) => void;
}) {
  const [directOutputOpen, setDirectOutputOpen] = useState(false);

  const options = directOutputOptions(settings, !mono);
  const currentValue = directOutputOpen
    ? EXT_OUTPUT_VALUE
    : busId === ""
      ? "__sends_only__"
      : busId;

  return (
    <div className="w-full my-1 flex flex-col items-center gap-1.5">
      {/* Mono/Stereo: forces mono sum of the track for mix + meters */}
      {onMonoChange && (
        <div className="w-full flex items-center justify-center my-0.5">
          <button
            type="button"
            className="flex items-center justify-center p-1 text-foreground/70 transition-colors hover:text-foreground mx-auto"
            title={
              mono
                ? "Mono — click for stereo"
                : "Stereo — click for mono (sum L+R)"
            }
            onClick={() => {
              const nextMono = !mono;
              onMonoChange(nextMono);
              if (directOutputOpen) {
                const newOptions = directOutputOptions(settings, !nextMono);
                if (newOptions.length > 0) {
                  onDirectOutput(nextMono, newOptions[0].startChannel);
                }
              }
            }}
          >
            <MonoStereoIcon stereo={!mono} />
          </button>
        </div>
      )}

      <select
        value={currentValue}
        onChange={(e) => {
          if (e.target.value === EXT_OUTPUT_VALUE) {
            setDirectOutputOpen(true);
            if (options.length > 0) {
              onDirectOutput(mono, options[0].startChannel);
            }
          } else {
            setDirectOutputOpen(false);
            onBusSelect(
              e.target.value === "__sends_only__" ? "" : e.target.value,
            );
          }
        }}
        className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none"
      >
        {busses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name || b.id}
          </option>
        ))}
        <option value="__sends_only__">Sends Only</option>
        <option value={EXT_OUTPUT_VALUE}>Ext. Out</option>
      </select>

      {directOutputOpen && (
        <select
          value={options.length > 0 ? options[0].startChannel : ""}
          onChange={(e) => {
            const startChannel = Number(e.target.value);
            if (!Number.isNaN(startChannel) && e.target.value !== "")
              onDirectOutput(mono, startChannel);
          }}
          className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none"
        >
          {options.map((o) => (
            <option key={o.startChannel} value={o.startChannel}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function BusDestinationRouting({
  bus,
  index,
  master,
  settings,
}: {
  bus: BusRow;
  index: number;
  master: BusRow | undefined;
  settings: SettingsState;
}) {
  const isMaster = bus.id === "main";
  const stereo = bus.channels === 2;
  const options = directOutputOptions(settings, stereo);

  const updateBusChannels = (channels: number, startChannel: number) => {
    void builder.busUpdate({
      index,
      name: bus.name,
      channels,
      startChannel,
      gainDb: bus.gainDb,
      mute: bus.mute,
      solo: bus.solo,
      isAux: bus.isAux,
    });
  };

  // Non-master bus (Sub-bus / Aux). "Master" destination = same physical
  // channels as the master bus (engine sums both with += on the hardware
  // outs). "Ext. Out" = any hardware pair, including the same pair as master —
  // that case must still sum, not replace.
  const isFollowingMaster = Boolean(
    master &&
    bus.channels === master.channels &&
    bus.startChannel === master.startChannel,
  );
  // Local UI mode: once the user opens Ext. Out, keep the channel picker
  // visible even if they pick the same pair as master (isFollowingMaster).
  // Hoisted above the isMaster early return so the hook order is stable.
  const [extOutputOpen, setExtOutputOpen] = useState(!isFollowingMaster);

  if (isMaster) {
    return (
      <div className="w-full my-1 flex flex-col items-center gap-1.5">
        {/* Mono/Stereo toggle ALWAYS at top with vertical spacing */}
        <div className="w-full flex items-center justify-center my-0.5">
          <button
            type="button"
            className="flex items-center justify-center p-1 text-foreground/70 transition-colors hover:text-foreground mx-auto"
            title={
              stereo ? "Stereo (click for mono)" : "Mono (click for stereo)"
            }
            onClick={() => updateBusChannels(stereo ? 1 : 2, bus.startChannel)}
          >
            <MonoStereoIcon stereo={stereo} />
          </button>
        </div>

        {/* Master Physical Output Channel Selector */}
        <select
          value={String(bus.startChannel)}
          onChange={(e) => {
            const startChannel = Number(e.target.value);
            if (!Number.isNaN(startChannel)) {
              updateBusChannels(bus.channels, startChannel);
            }
          }}
          className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none"
          title="Master physical output hardware pair/channel"
        >
          {options.map((o) => (
            <option key={o.startChannel} value={o.startChannel}>
              Out: {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="w-full my-1 flex flex-col items-center gap-1.5">
      {/* Mono/Stereo toggle ALWAYS at top with vertical spacing */}
      <div className="w-full flex items-center justify-center my-0.5">
        <button
          type="button"
          className="flex items-center justify-center p-1 text-foreground/70 transition-colors hover:text-foreground mx-auto"
          title={stereo ? "Stereo (click for mono)" : "Mono (click for stereo)"}
          onClick={() => updateBusChannels(stereo ? 1 : 2, bus.startChannel)}
        >
          <MonoStereoIcon stereo={stereo} />
        </button>
      </div>

      <select
        value={extOutputOpen ? EXT_OUTPUT_VALUE : "master"}
        onChange={(e) => {
          if (e.target.value === EXT_OUTPUT_VALUE) {
            setExtOutputOpen(true);
            // Prefer a free pair if one exists; otherwise keep current (may
            // equal master — engine sums overlapping Ext. Outs).
            if (options.length > 0) {
              const free = master
                ? options.find((o) => o.startChannel !== master.startChannel)
                : undefined;
              const pick = free ?? options[0];
              updateBusChannels(bus.channels, pick.startChannel);
            }
          } else {
            setExtOutputOpen(false);
            if (master) updateBusChannels(master.channels, master.startChannel);
          }
        }}
        className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none"
        title="Where this bus's signal goes (Master = same outs as master; both still sum)"
      >
        <option value="master">Master</option>
        <option value={EXT_OUTPUT_VALUE}>Ext. Out</option>
      </select>

      {extOutputOpen && (
        <select
          value={String(bus.startChannel)}
          onChange={(e) => {
            const startChannel = Number(e.target.value);
            if (!Number.isNaN(startChannel))
              updateBusChannels(bus.channels, startChannel);
          }}
          className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none"
        >
          {options.map((o) => (
            <option key={o.startChannel} value={o.startChannel}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function StripButton({
  active,
  color,
  flashingMute,
  children,
  onClick,
}: {
  active: boolean;
  color: "danger" | "warning";
  flashingMute?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  const activeCls =
    color === "danger"
      ? "bg-danger text-white border-danger"
      : "bg-warning text-black border-warning";
  return (
    <button
      onClick={onClick}
      className={`flex h-5 w-full items-center justify-center rounded border text-[10px] font-bold transition-colors ${
        active
          ? activeCls
          : "border-default/50 bg-default/10 text-foreground/50 hover:bg-default/25"
      }`}
    >
      <span
        className={
          flashingMute ? "animate-pulse text-amber-400 font-extrabold" : ""
        }
      >
        {children}
      </span>
    </button>
  );
}

function ChannelStrip({
  name,
  icon,
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
  anySoloInGroup,
  onGain,
  onPan,
  onMute,
  onSolo,
}: {
  name: string;
  /** Optional glyph shown next to the name (e.g. the metronome strip). */
  icon?: React.ReactNode;
  subtitle?: string;
  color: string;
  busses?: BusRow[];
  busId?: string;
  onBusSelect?: (id: string) => void;
  // When set, the plain <select> is replaced by TrackOutputRouting (adds the
  // "Direct Output" escape hatch). Mono/stereo toggle is optional within
  // that -- omit mono/onMonoChange for a strip with nothing meaningful to
  // sum to mono (e.g. the metronome click uses this for Direct Output only).
  directOutput?: {
    settings: SettingsState;
    mono?: boolean;
    onMonoChange?: (mono: boolean) => void;
    onDirectOutput: (mono: boolean, startChannel: number) => void;
  };
  // Ableton-style send knob row, one per aux bus. Track strips only.
  sends?: {
    auxBusses: BusRow[];
    values: { busId: string; gainDb: number }[];
    trackIndex: number;
    onSendChange?: (busId: string, gainDb: number) => void;
    onRemoveSend?: (busId: string) => void;
  };
  // Mono/stereo toggle + Master-vs-Direct-Output routing. Bus strips only
  // (every bus except Master -- see BusDestinationRouting).
  busDestination?: React.ReactNode;
  gainDb: number;
  pan: number | null;
  peakDb: number | undefined;
  peakDbL?: number;
  peakDbR?: number;
  /** Live peak getters (no frame drop) — used for metronome / meters. */
  getLiveDb?: () => number;
  getLiveDbL?: () => number;
  getLiveDbR?: () => number;
  mute: boolean;
  solo: boolean;
  anySoloInGroup?: boolean;
  onGain: (v: number) => void;
  onPan: ((v: number) => void) | null;
  onMute: () => void;
  onSolo: () => void;
}) {
  const formatPan = (p: number) => {
    if (Math.abs(p) < 0.05) return "C";
    if (p < 0) return `L${Math.round(-p * 100)}`;
    return `R${Math.round(p * 100)}`;
  };

  const isDimmed = !!anySoloInGroup && !solo;

  // Shared clip state for this strip's meter + Logic-style peak readout box
  // (see useChannelClipHold) -- one flag both pieces render from and both
  // can clear, instead of latching red independently of each other.
  const stripLeftDb = peakDbL ?? peakDb ?? -100;
  const stripRightDb = peakDbR ?? peakDb ?? -100;
  const stripClip = useChannelClipHold(Math.max(stripLeftDb, stripRightDb));

  return (
    <div
      className={`flex h-full min-h-0 w-24 shrink-0 flex-col items-center justify-between rounded-lg border border-default/30 bg-background-secondary p-2 select-none transition-opacity duration-300 ${
        isDimmed ? "opacity-35" : "opacity-100"
      }`}
    >
      {/* Header */}
      <div className="flex flex-col items-center gap-0.5 w-full text-center">
        <div
          className="h-1 w-full rounded-full"
          style={{ backgroundColor: color }}
        />
        <div
          className="flex items-center justify-center gap-1 truncate text-xs font-semibold text-foreground w-full"
          title={name}
        >
          {icon}
          {name}
        </div>
        {subtitle && (
          <div className="text-[9px] text-foreground/40 font-mono truncate w-full">
            {subtitle}
          </div>
        )}
      </div>

      {/* Bus Routing Dropdown -- "Main and Sends": this main destination and
          the send knobs below are independent, both editable at once. */}
      {busses && onBusSelect && directOutput ? (
        <TrackOutputRouting
          busId={busId || ""}
          busses={busses}
          settings={directOutput.settings}
          mono={directOutput.mono}
          onMonoChange={directOutput.onMonoChange}
          onBusSelect={onBusSelect}
          onDirectOutput={directOutput.onDirectOutput}
        />
      ) : (
        busses &&
        onBusSelect && (
          <div className="w-full my-1">
            <select
              value={busId || ""}
              onChange={(e) => onBusSelect(e.target.value)}
              className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none"
            >
              {busses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name || b.id}
                </option>
              ))}
            </select>
          </div>
        )
      )}

      {busDestination}

      {/* Pan Knob */}
      {onPan && pan !== null ? (
        <div className="flex flex-col items-center gap-0.5 my-1">
          <Knob
            value={pan}
            min={-1}
            max={1}
            defaultValue={0}
            accent="rgba(255,255,255,0.9)"
            onCommit={onPan}
            size={24}
            title="Pan"
          />
          <div className="text-[9px] font-mono text-foreground/50">
            {formatPan(pan)}
          </div>
        </div>
      ) : (
        <div className="h-2" />
      )}

      {/* Gain / Peak readout (Logic-style pair: fader value left, actual
          level right). The right box and the meter below it share one clip
          state (useChannelClipHold) so clicking either clears both. */}
      <GainPeakReadout
        gainDb={gainDb}
        liveAvgDb={(stripLeftDb + stripRightDb) / 2}
        clipped={stripClip.clipped}
        heldPeakDb={stripClip.heldPeakDb}
        onClear={stripClip.clear}
      />

      {/* Fader & Meter Section */}
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 py-2">
        <GainFader gainDb={gainDb} accent={color} onChange={onGain} />
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
          barClassName="h-full w-1.5"
          clipLatched={stripClip.clipped}
          onClearClip={stripClip.clear}
        />
      </div>

      {/* Mute & Solo buttons */}
      <div className="flex w-full gap-1">
        <StripButton
          active={mute}
          color="danger"
          flashingMute={isDimmed}
          onClick={onMute}
        >
          M
        </StripButton>
        <StripButton active={solo} color="warning" onClick={onSolo}>
          S
        </StripButton>
      </div>

      {sends && (
        <SendKnobs
          auxBusses={sends.auxBusses}
          sends={sends.values}
          trackIndex={sends.trackIndex}
          onSendChange={sends.onSendChange}
          onRemoveSend={sends.onRemoveSend}
        />
      )}
    </div>
  );
}

function TrackStrip({
  t,
  index,
  busses,
  auxBusses,
  meters,
  settings,
  anySoloInGroup,
  onDirectOutput,
}: {
  t: TrackRow;
  index: number;
  busses: BusRow[];
  auxBusses: BusRow[];
  meters: import("../lib/types").MeterRow[];
  settings: SettingsState;
  anySoloInGroup?: boolean;
  onDirectOutput: (
    trackIndex: number,
    mono: boolean,
    startChannel: number,
  ) => void;
}) {
  const color = colorForIndex(index);
  const busMeter = meters.find((m) => m.id === t.busId);
  const peakDb = t.peakDb ?? busMeter?.peakDb;
  const peakDbL = t.peakDbL ?? busMeter?.peakDbL ?? peakDb;
  const peakDbR = t.peakDbR ?? busMeter?.peakDbR ?? peakDb;

  return (
    <ChannelStrip
      name={t.name || t.id}
      subtitle={`Track ${index + 1}`}
      color={color}
      busses={busses}
      busId={t.busId}
      onBusSelect={(bId) => mixer.setTrackBus(index, bId)}
      directOutput={{
        settings,
        mono: Boolean(t.mono),
        onMonoChange: (m) => void mixer.setTrackMono(index, m),
        onDirectOutput: (mono, ch) => onDirectOutput(index, mono, ch),
      }}
      sends={{
        auxBusses,
        values: t.sends,
        trackIndex: index,
        onRemoveSend: (busId) => void mixer.removeTrackSend(index, busId),
      }}
      gainDb={t.gainDb ?? 0}
      pan={t.pan ?? 0}
      peakDb={peakDb}
      peakDbL={peakDbL}
      peakDbR={peakDbR}
      getLiveDbL={() => getLiveLevels().tracks[index]?.peakDbL ?? -144}
      getLiveDbR={() => getLiveLevels().tracks[index]?.peakDbR ?? -144}
      mute={t.mute}
      solo={t.solo}
      anySoloInGroup={anySoloInGroup}
      onGain={(v) => mixer.setTrackGain(index, v)}
      onPan={(v) => mixer.setTrackPan(index, v)}
      onMute={() => mixer.setTrackMute(index, !t.mute)}
      onSolo={() => mixer.setTrackSolo(index, !t.solo)}
    />
  );
}

function MetronomeStrip({ state }: { state: WebUiState }) {
  const clickSolo = state.clickSolo ?? false;

  // Metronome is project-global (not per-song). Song rows mirror the same
  // values for older consumers; always read/write the project fields.
  const hasSongs = state.songs.length > 0;
  const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
  const currentSong = hasSongs ? state.songs[songIdx] : null;
  const isMetronomeOn = state.click ?? currentSong?.click ?? false;
  // Empty clickBusId = Sends Only. Do NOT coerce "" to the first bus — that
  // made Sends Only unselectable (falsy "" fell back to main every patch).
  const currentClickBus = state.clickBusId ?? currentSong?.clickBusId ?? "";
  const clickGain = state.clickGainDb ?? -6;
  const clickPan = state.clickPan ?? 0;

  const auxBusses = state.busses.filter((b) => b.isAux);
  const clickSends = state.clickSends ?? currentSong?.clickSends ?? [];
  // Dedicated click meter — never the destination bus (master) peaks.
  // Always show strip peaks (post gain/pan), even when the metronome is muted.
  const clickPeak = state.clickPeakDb ?? -100;
  const clickPeakL = state.clickPeakDbL ?? state.clickPeakDb ?? -100;
  const clickPeakR = state.clickPeakDbR ?? state.clickPeakDb ?? -100;
  const getLiveClick = () => getClickPeaks().peakDb;
  const getLiveClickL = () => getClickPeaks().peakDbL;
  const getLiveClickR = () => getClickPeaks().peakDbR;

  const patchClick = (partial: {
    click?: boolean;
    clickBusId?: string;
    clickGainDb?: number;
    clickPan?: number;
    clickSends?: typeof clickSends;
  }) => {
    // Project-global click — works with zero songs (index -1).
    const nextClickBusId =
      partial.clickBusId !== undefined ? partial.clickBusId : currentClickBus;
    void builder.songUpdate({
      index: hasSongs ? songIdx : -1,
      name: currentSong?.name ?? "",
      bpm: currentSong?.bpm ?? 120,
      mode: currentSong?.mode ?? "wait",
      tsNum: currentSong?.tsNum ?? 4,
      tsDen: currentSong?.tsDen ?? 4,
      click: partial.click ?? isMetronomeOn,
      clickBusId: nextClickBusId,
      clickGainDb: partial.clickGainDb ?? state.clickGainDb ?? -6,
      clickPan: partial.clickPan ?? state.clickPan ?? 0,
      clickSends: partial.clickSends ?? clickSends,
    });
  };

  const toggleMetronomeMute = () => {
    patchClick({ click: !isMetronomeOn });
  };

  const changeClickBus = (busId: string) => {
    patchClick({ clickBusId: busId });
  };

  const handleClickSendChange = (busId: string, gainDb: number) => {
    const existing = clickSends.find((cs) => cs.busId === busId);
    let updatedSends: typeof clickSends;
    if (existing) {
      updatedSends = clickSends.map((cs) =>
        cs.busId === busId ? { ...cs, gainDb, enabled: gainDb > -59 } : cs,
      );
    } else {
      updatedSends = [...clickSends, { busId, gainDb, enabled: gainDb > -59 }];
    }
    patchClick({ clickSends: updatedSends });
  };

  return (
    <ChannelStrip
      name="Click"
      icon={<FontIcon name="metronome" size={11} />}
      subtitle="Metronome"
      color="#ff9230"
      busses={state.busses}
      busId={currentClickBus}
      onBusSelect={changeClickBus}
      directOutput={{
        settings: state.settings,
        onDirectOutput: (_mono, startChannel) => {
          // Route click onto any bus (main or aux) already on this physical
          // pair so Ext. Out same-channel stacks with master/sends via the
          // engine's physical-out `+=` sum. Prefer exact startChannel match.
          const existing = state.busses.find(
            (b) => b.startChannel === startChannel,
          );
          if (existing) {
            changeClickBus(existing.id);
          }
        },
      }}
      sends={{
        auxBusses,
        values: clickSends,
        trackIndex: -1,
        onSendChange: handleClickSendChange,
      }}
      gainDb={clickGain}
      pan={clickPan}
      peakDb={clickPeak}
      peakDbL={clickPeakL}
      peakDbR={clickPeakR}
      getLiveDb={getLiveClick}
      getLiveDbL={getLiveClickL}
      getLiveDbR={getLiveClickR}
      mute={!isMetronomeOn}
      solo={clickSolo}
      onGain={(v) => patchClick({ clickGainDb: v })}
      onPan={(v) => patchClick({ clickPan: v })}
      onMute={toggleMetronomeMute}
      onSolo={() => void mixer.setClickSolo(!clickSolo)}
    />
  );
}

function BusStrip({
  b,
  index,
  meters,
  master,
  settings,
  isMaster = false,
  anySoloInGroup,
}: {
  b: BusRow;
  index: number;
  meters: import("../lib/types").MeterRow[];
  master?: BusRow;
  settings: SettingsState;
  isMaster?: boolean;
  anySoloInGroup?: boolean;
}) {
  const meter = meters.find((m) => m.id === b.id);
  const color = isMaster ? "#0091ff" : "#ff9230";
  const peakDb = meter?.peakDb ?? b.peakDb;
  const peakDbL = meter?.peakDbL ?? b.peakDbL ?? peakDb;
  const peakDbR = meter?.peakDbR ?? b.peakDbR ?? peakDb;

  return (
    <ChannelStrip
      name={b.name || b.id}
      subtitle={isMaster ? "Master Output" : b.isAux ? "Aux Send" : "Sub Bus"}
      color={color}
      gainDb={b.gainDb ?? 0}
      pan={null}
      peakDb={peakDb}
      peakDbL={peakDbL}
      peakDbR={peakDbR}
      getLiveDbL={() =>
        getLiveLevels().meters.find((m) => m.id === b.id)?.peakDbL ?? -144
      }
      getLiveDbR={() =>
        getLiveLevels().meters.find((m) => m.id === b.id)?.peakDbR ?? -144
      }
      mute={b.mute}
      solo={b.solo}
      anySoloInGroup={anySoloInGroup}
      onGain={(v) => mixer.setBusGain(index, v)}
      onPan={null}
      onMute={() => mixer.setBusMute(index, !b.mute)}
      onSolo={() => mixer.setBusSolo(index, !b.solo)}
      busDestination={
        <BusDestinationRouting
          bus={b}
          index={index}
          master={master}
          settings={settings}
        />
      }
    />
  );
}

interface TrackMenuState {
  x: number;
  y: number;
  index: number;
}

// Right-click menu for a mixer track strip. Everything here is backed by
// APIs that already exist (builder.trackMove/trackUpdate/trackRemove,
// mixer.setTrack*) -- no new backend routes needed. Rename uses an inline
// text field rather than window.prompt(), and Remove uses the in-app
// ConfirmDialog rather than window.confirm() -- the embedded native
// WebView's WKWebView backing isn't guaranteed to implement either JS
// dialog's UIDelegate method (this is what made "Remove Bus" silently do
// nothing: window.confirm() returned falsy without ever showing a panel).
function TrackContextMenu({
  menu,
  track,
  songIndex,
  onClose,
}: {
  menu: TrackMenuState;
  track: TrackRow;
  songIndex: number;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(track.name || track.id);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const act = (fn: () => void) => {
    fn();
    onClose();
  };

  const commitRename = () => {
    const name = nameDraft.trim();
    if (name.length > 0) {
      void builder.trackUpdate({
        songIndex,
        index: menu.index,
        name,
        busId: track.busId,
        gainDb: track.gainDb,
        pan: track.pan,
        mute: track.mute,
        solo: track.solo,
      });
    }
    onClose();
  };

  if (confirmRemove) {
    return (
      <ConfirmDialog
        open
        title="Remove track"
        message={`Remove track "${track.name || track.id}"?`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        danger
        onCancel={onClose}
        onConfirm={() => {
          void builder.trackRemove(songIndex, menu.index);
          onClose();
        }}
      />
    );
  }

  return (
    <ContextMenu x={menu.x} y={menu.y} onClose={onClose}>
      {renaming ? (
        <form
          className="px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            commitRename();
          }}
        >
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            className="w-full rounded border border-default/40 bg-default/20 px-1.5 py-1 text-xs text-foreground focus:outline-none"
          />
        </form>
      ) : (
        <ContextMenuItem onClick={() => setRenaming(true)}>
          Rename Track...
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onClick={() =>
          act(() => void builder.trackMove(songIndex, menu.index, -1))
        }
      >
        Move Left
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() =>
          act(() => void builder.trackMove(songIndex, menu.index, 1))
        }
      >
        Move Right
      </ContextMenuItem>
      <ContextMenuDivider />
      <ContextMenuItem
        onClick={() =>
          act(() => {
            void mixer.setTrackGain(menu.index, 0);
            void mixer.setTrackPan(menu.index, 0);
          })
        }
      >
        Reset Gain & Pan
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() =>
          act(() => {
            void mixer.setTrackMute(menu.index, false);
            void mixer.setTrackSolo(menu.index, false);
          })
        }
      >
        Clear Mute & Solo
      </ContextMenuItem>
      <ContextMenuItem
        disabled={track.sends.length === 0}
        onClick={() =>
          act(() => {
            for (const s of track.sends)
              void mixer.removeTrackSend(menu.index, s.busId);
          })
        }
      >
        Remove All Sends
      </ContextMenuItem>
      <ContextMenuDivider />
      <ContextMenuItem danger onClick={() => setConfirmRemove(true)}>
        Remove Track
      </ContextMenuItem>
    </ContextMenu>
  );
}

function BusContextMenu({
  menu,
  bus,
  onClose,
}: {
  menu: { x: number; y: number; index: number };
  bus: BusRow;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(bus.name || bus.id);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const act = (fn: () => void) => {
    fn();
    onClose();
  };

  const commitRename = () => {
    const name = nameDraft.trim();
    if (name.length > 0) {
      void builder.busUpdate({
        index: menu.index,
        name,
        channels: bus.channels,
        startChannel: bus.startChannel,
        gainDb: bus.gainDb,
        mute: bus.mute,
        solo: bus.solo,
        isAux: bus.isAux,
      });
    }
    onClose();
  };

  if (confirmRemove) {
    return (
      <ConfirmDialog
        open
        title="Remove bus"
        message={`Remove bus "${bus.name || bus.id}"?`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        danger
        onCancel={onClose}
        onConfirm={() => {
          void builder.busRemove(menu.index);
          onClose();
        }}
      />
    );
  }

  return (
    <ContextMenu x={menu.x} y={menu.y} onClose={onClose}>
      {renaming ? (
        <form
          className="px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            commitRename();
          }}
        >
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            className="w-full rounded border border-default/40 bg-default/20 px-1.5 py-1 text-xs text-foreground focus:outline-none"
          />
        </form>
      ) : (
        <ContextMenuItem onClick={() => setRenaming(true)}>
          Rename Bus...
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onClick={() =>
          act(() => {
            void mixer.setBusGain(menu.index, 0);
          })
        }
      >
        Reset Gain
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() =>
          act(() => {
            void mixer.setBusMute(menu.index, false);
            void mixer.setBusSolo(menu.index, false);
          })
        }
      >
        Clear Mute & Solo
      </ContextMenuItem>
      {bus.id !== "main" && (
        <>
          <ContextMenuDivider />
          <ContextMenuItem danger onClick={() => setConfirmRemove(true)}>
            Remove Bus
          </ContextMenuItem>
        </>
      )}
    </ContextMenu>
  );
}

// builder.busAdd() is fire-and-forget with no ID in the response -- the new
// bus only shows up on the next WebSocket state push. To turn "add a bus"
// into "add a bus AND configure it" (needed for both the mixer's "+ Add
// Send" button and a track's "Direct Output" picker, neither of which have
// a bus to point at yet), queue a job keyed by the bus-id snapshot taken
// right before the add, then finish configuring whichever bus shows up next
// that wasn't in that snapshot.
interface PendingBusJob {
  knownIds: Set<string>;
  finalize: (busId: string, index: number) => void;
}

export function MixerScreen({ state }: { state: WebUiState }) {
  const auxBusses = state.busses.filter((b) => b.isAux);
  const mainBusses = state.busses.filter((b) => !b.isAux);
  // "main" is the canonical master bus id (see ProjectLoader::newProject());
  // fall back to the first non-aux bus for older/unusual projects.
  const master = state.busses.find((b) => b.id === "main") ?? mainBusses[0];
  const pendingBusJobs = useRef<PendingBusJob[]>([]);
  const [trackMenu, setTrackMenu] = useState<TrackMenuState | null>(null);

  const [busMenu, setBusMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);

  useEffect(() => {
    if (pendingBusJobs.current.length === 0) return;
    const claimed = new Set<string>();
    const remaining: PendingBusJob[] = [];
    for (const job of pendingBusJobs.current) {
      const idx = state.busses.findIndex(
        (b) => !job.knownIds.has(b.id) && !claimed.has(b.id),
      );
      if (idx >= 0) {
        claimed.add(state.busses[idx].id);
        job.finalize(state.busses[idx].id, idx);
      } else {
        remaining.push(job);
      }
    }
    pendingBusJobs.current = remaining;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.busses]);

  function queueBusJob(finalize: (busId: string, index: number) => void) {
    pendingBusJobs.current.push({
      knownIds: new Set(state.busses.map((b) => b.id)),
      finalize,
    });
    void builder.busAdd();
  }

  function nextOutputChannel(): number {
    return state.busses.reduce(
      (max, b) => Math.max(max, b.startChannel + b.channels),
      0,
    );
  }

  // "+ Add Send" -- creates a new aux (return) bus directly from the mixer
  // page, same result as BuilderPanel's "Add Return" button, just reachable
  // without leaving the Mixer. Always starts stereo; mono is a per-bus
  // toggle on the strip itself afterward (see BusDestinationRouting), not a
  // separate creation path.
  function requestAddSend() {
    const label = `Send ${auxBusses.length + 1}`;
    // Prefer a free hardware pair when the interface has one; otherwise land
    // on the master's pair so the send is audible on a 2-out device (engine
    // sums overlapping Ext. Outs). nextOutputChannel() alone often returns
    // ch 2 on stereo devices — silent until remapped.
    const freeStart = nextOutputChannel();
    const hwCount = state.settings.outputChannelNames?.length ?? 2;
    const startChannel =
      freeStart + 2 <= hwCount ? freeStart : (master?.startChannel ?? 0);
    queueBusJob((_busId, index) => {
      void builder.busUpdate({
        index,
        name: label,
        channels: 2,
        startChannel,
        gainDb: 0,
        mute: false,
        solo: false,
        isAux: true,
      });
    });
  }

  // Track "Direct Output" -- pins a track straight to a physical channel (or
  // pair) instead of a project bus, by finding an existing non-aux bus
  // already pinned to that exact channel range or creating one on the fly.
  function requestDirectOutput(
    trackIndex: number,
    mono: boolean,
    startChannel: number,
  ) {
    const channels = mono ? 1 : 2;
    const existing = mainBusses.find(
      (b) => b.startChannel === startChannel && b.channels === channels,
    );
    if (existing) {
      void mixer.setTrackBus(trackIndex, existing.id);
      return;
    }
    const label = mono
      ? `Out ${startChannel + 1}`
      : `Out ${startChannel + 1}/${startChannel + 2}`;
    queueBusJob((busId, index) => {
      void builder.busUpdate({
        index,
        name: label,
        channels,
        startChannel,
        gainDb: 0,
        mute: false,
        solo: false,
        isAux: false,
      });
      void mixer.setTrackBus(trackIndex, busId);
    });
  }

  // Metronome solo joins the same solo group as track solo -- see
  // AudioEngine::setClickSolo(). Regular tracks dim exactly as if one of
  // them (rather than the click) had solo engaged.
  const anyTrackSolo =
    (state.clickSolo ?? false) || state.tracks.some((tr) => tr.solo);
  const anyAuxSolo = auxBusses.some((b) => b.solo);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 text-xs text-foreground/40">
        <span className="font-semibold uppercase tracking-wide">Console</span>
        <span>&middot;</span>
        <span>{state.tracks.length} tracks</span>
        <span>&middot;</span>
        <span>{state.busses.length} busses</span>
      </div>

      {/* Mixer Console Container: Scrollable Tracks on Left, Separator, Fixed Metronome/Master/Aux on Right */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-default/30 bg-background p-3">
        {state.tracks.length === 0 && state.busses.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center px-4 py-6 text-center text-sm text-foreground/40">
            No tracks staged in this project.
          </div>
        ) : (
          <>
            {/* Left: Scrollable Ordinary Track Strips */}
            <ScrollShadow
              orientation="horizontal"
              className="flex min-h-0 flex-1 gap-2 pr-1"
            >
              {state.tracks.map((t, i) => (
                <div
                  key={t.id}
                  className="flex h-full min-h-0 shrink-0"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTrackMenu({ x: e.clientX, y: e.clientY, index: i });
                  }}
                >
                  <TrackStrip
                    t={t}
                    index={i}
                    busses={state.busses}
                    auxBusses={auxBusses}
                    meters={state.meters}
                    settings={state.settings}
                    anySoloInGroup={anyTrackSolo}
                    onDirectOutput={requestDirectOutput}
                  />
                </div>
              ))}
            </ScrollShadow>

            {/* Vertical Separator Divider Line */}
            <div className="mx-2 w-px shrink-0 self-stretch bg-default/40" />

            {/* Middle: Aux Send Buses (Scrollable independently, max-w-[35%]) */}
            <ScrollShadow
              orientation="horizontal"
              className="flex shrink-0 gap-2 max-w-[35%]"
            >
              <div className="flex h-full w-20 shrink-0 flex-col items-center justify-center">
                <button
                  onClick={() => requestAddSend()}
                  title="Add a new return/send bus"
                  className="flex h-full w-20 shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-default/40 bg-default/10 text-foreground/60 transition-colors hover:bg-default/25 hover:text-foreground"
                >
                  <Plus size={22} />
                  <span className="text-[11px] font-semibold">Send</span>
                </button>
              </div>

              {auxBusses.map((b) => (
                <div
                  key={b.id}
                  className="flex h-full min-h-0 shrink-0"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setBusMenu({
                      x: e.clientX,
                      y: e.clientY,
                      index: state.busses.indexOf(b),
                    });
                  }}
                >
                  <BusStrip
                    b={b}
                    index={state.busses.indexOf(b)}
                    meters={state.meters}
                    master={master}
                    settings={state.settings}
                    anySoloInGroup={anyAuxSolo}
                  />
                </div>
              ))}
            </ScrollShadow>

            {/* Vertical Divider */}
            <div className="mx-2 w-px shrink-0 self-stretch bg-default/40" />

            {/* Rightmost Fixed Section: Metronome + Master Bus (ALWAYS VISIBLE, FULL HEIGHT) */}
            <div className="flex h-full min-h-0 shrink-0 gap-2 items-stretch">
              <div className="flex h-full min-h-0 shrink-0">
                <MetronomeStrip state={state} />
              </div>

              <div className="mx-1 w-px shrink-0 self-stretch bg-default/40" />

              {mainBusses.map((b) => (
                <div
                  key={b.id}
                  className="flex h-full min-h-0 shrink-0"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setBusMenu({
                      x: e.clientX,
                      y: e.clientY,
                      index: state.busses.indexOf(b),
                    });
                  }}
                >
                  <BusStrip
                    b={b}
                    index={state.busses.indexOf(b)}
                    meters={state.meters}
                    master={master}
                    settings={state.settings}
                    isMaster={b === master}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {trackMenu && state.tracks[trackMenu.index] && (
        <TrackContextMenu
          menu={trackMenu}
          track={state.tracks[trackMenu.index]}
          songIndex={state.songIndex >= 0 ? state.songIndex : 0}
          onClose={() => setTrackMenu(null)}
        />
      )}

      {busMenu && state.busses[busMenu.index] && (
        <BusContextMenu
          menu={busMenu}
          bus={state.busses[busMenu.index]}
          onClose={() => setBusMenu(null)}
        />
      )}
    </div>
  );
}
