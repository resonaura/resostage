import { useEffect, useRef, useState } from "react";
import { Slider } from "@heroui/react";
import { Plus } from "lucide-react";
import { LevelMeterBar } from "../components/LevelMeterBar";
import { builder, mixer } from "../lib/api";
import { useLiveValue } from "../lib/optimistic";
import type { BusRow, SettingsState, TrackRow, WebUiState } from "../lib/types";

// Floor for a send knob that hasn't been touched yet -- matches native
// MixerStrip's convention (see MixerPanel.cpp's auxSlotTemplate): a track
// with no TrackSendDef for a given aux bus is treated as "sending at -60dB",
// and turning the knob up from there implicitly creates the send.
const SEND_FLOOR_DB = -60;

// Sentinel value for the track/bus output <select>: picking it reveals a
// secondary channel-list dropdown instead of immediately committing a
// change (mirrors the two-step "pick a category, then pick specifics" UX
// used for everything else in this screen -- no huge flat list of every
// channel dumped into the primary select).
const EXT_OUTPUT_VALUE = "__ext_output__";

function MonoStereoIcon({ stereo, size = 13 }: { stereo: boolean; size?: number }) {
  if (!stereo) {
    return (
      <span
        className="inline-block shrink-0 rounded-full border-[1.5px] border-current"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span className="relative inline-block shrink-0" style={{ width: size * 1.6, height: size }}>
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
      if (isActive(i) && isActive(i + 1)) options.push({ label: `${i + 1}/${i + 2}`, startChannel: i });
    }
  } else {
    for (let i = 0; i < count; i++) {
      if (isActive(i)) options.push({ label: `${i + 1}`, startChannel: i });
    }
  }
  return options;
}

const TRACK_COLORS = [
  "#0091ff", "#30d158", "#ff9230", "#db34f2", "#ff375f",
  "#00d2e0", "#ff4245", "#6d7cff", "#00dac3", "#3cd3fe",
  "#ffd600", "#b78a66",
];
function colorForIndex(i: number): string {
  return TRACK_COLORS[i % TRACK_COLORS.length];
}

const GAIN_MIN = -60;
const GAIN_MAX = 12;

function GainFader({
  gainDb,
  accent = "var(--accent, #0091ff)",
  onChange,
}: {
  gainDb: number;
  accent?: string;
  onChange: (v: number) => void;
}) {
  const [value, handleChange] = useLiveValue(gainDb, onChange);
  return (
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
      <Slider.Track className="relative h-full w-2.5 rounded-full bg-default/20">
        <Slider.Fill
          className="rounded-full transition-all"
          style={{ backgroundColor: accent }}
        />
        <Slider.Thumb
          className="size-4 border-2 border-background shadow-md transition-transform hover:scale-110"
          style={{ backgroundColor: accent }}
        />
      </Slider.Track>
    </Slider>
  );
}

function Knob({
  value,
  min,
  max,
  defaultValue = 0,
  accent = "var(--accent, #0091ff)",
  onCommit,
  size = 26,
  title,
}: {
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  accent?: string;
  onCommit: (v: number) => void;
  size?: number;
  title?: string;
}) {
  const [localValue, setLocalValue] = useState(value);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);
  const rafId = useRef<number | null>(null);
  const pendingCommit = useRef<number | null>(null);

  if (!dragging.current && localValue !== value) setLocalValue(value);

  const angleFor = (v: number) => {
    const t = (v - min) / (max - min);
    return -135 + t * 270;
  };

  const scheduleCommit = (v: number) => {
    pendingCommit.current = v;
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        if (pendingCommit.current != null) {
          onCommit(pendingCommit.current);
          pendingCommit.current = null;
        }
      });
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    startY.current = e.clientY;
    startValue.current = localValue;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const dy = startY.current - e.clientY;
    const range = max - min;
    const next = Math.round(Math.max(min, Math.min(max, startValue.current + (dy / 120) * range)) * 100) / 100;
    setLocalValue(next);
    scheduleCommit(next);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    if (pendingCommit.current != null) {
      onCommit(pendingCommit.current);
      pendingCommit.current = null;
    }
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      role="slider"
      aria-label={title}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={localValue}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => { setLocalValue(defaultValue); onCommit(defaultValue); }}
      className="relative shrink-0 cursor-ns-resize touch-none select-none rounded-full border border-default/60 bg-default/20"
      style={{ width: size, height: size }}
    >
      <div
        className="absolute left-1/2 top-1/2 w-[2px] -translate-x-1/2 -translate-y-full rounded-full"
        style={{
          height: size * 0.4,
          backgroundColor: accent,
          transformOrigin: "bottom center",
          transform: `translateX(-50%) rotate(${angleFor(localValue)}deg)`,
        }}
      />
    </div>
  );
}

// Ableton-style send-knob row: one small knob per aux bus, floor = "no send
// yet" (matches native MixerStrip::setSendSlots). Turning a knob up from the
// floor implicitly creates the TrackSendDef via mixer.setTrackSend -- no
// separate "add" step, same as the native mixer.
function SendKnobs({
  auxBusses,
  sends,
  trackIndex,
}: {
  auxBusses: BusRow[];
  sends: { busId: string; gainDb: number }[];
  trackIndex: number;
}) {
  if (auxBusses.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-1 border-t border-default/20 py-1">
      {auxBusses.map((bus) => {
        const existing = sends.find((s) => s.busId === bus.id);
        const value = existing?.gainDb ?? SEND_FLOOR_DB;
        return (
          <div key={bus.id} className="flex items-center justify-between gap-1">
            <span className="truncate text-[8px] font-mono text-foreground/40" title={bus.name || bus.id}>
              {(bus.name || bus.id).slice(0, 4)}
            </span>
            <Knob
              value={value}
              min={SEND_FLOOR_DB}
              max={6}
              defaultValue={SEND_FLOOR_DB}
              accent="#00dac3"
              onCommit={(v) => mixer.setTrackSend(trackIndex, bus.id, v)}
              size={16}
              title={`Send to ${bus.name || bus.id}`}
            />
          </div>
        );
      })}
    </div>
  );
}

// Track output routing: the normal bus <select> plus an "Ext. Output"
// escape hatch that pins the track straight to a physical output channel
// (or channel pair) instead of any bus in the project. Mono selects a single
// channel; stereo selects an adjacent pair ("1/2", "3/4", ...) depending on
// what's active in Settings.
function TrackOutputRouting({
  busId,
  busses,
  settings,
  onBusSelect,
  onDirectOutput,
}: {
  busId: string;
  busses: BusRow[];
  settings: SettingsState;
  onBusSelect: (id: string) => void;
  onDirectOutput: (mono: boolean, startChannel: number) => void;
}) {
  const [directOutputOpen, setDirectOutputOpen] = useState(false);
  const [mono, setMono] = useState(false);

  const options = directOutputOptions(settings, !mono);

  return (
    <div className="w-full my-1">
      <select
        value={directOutputOpen ? EXT_OUTPUT_VALUE : busId || ""}
        onChange={(e) => {
          if (e.target.value === EXT_OUTPUT_VALUE) {
            setDirectOutputOpen(true);
          } else {
            setDirectOutputOpen(false);
            onBusSelect(e.target.value);
          }
        }}
        className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none"
      >
        {busses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name || b.id}
          </option>
        ))}
        <option value={EXT_OUTPUT_VALUE}>Ext. Output</option>
      </select>

      {/* Always visible (not just once Ext. Output is picked) -- it's the
          same per-track mono/stereo choice the bus strips always show, and
          determines whether Ext. Output offers single channels or pairs. */}
      <button
        type="button"
        className="mt-1 flex items-center gap-1 text-foreground/70"
        title={mono ? "Mono (click for stereo)" : "Stereo (click for mono)"}
        onClick={() => setMono((m) => !m)}
      >
        <MonoStereoIcon stereo={!mono} />
        <span className="text-[8px] uppercase">{mono ? "Mono" : "Stereo"}</span>
      </button>

      {directOutputOpen && (
        <div className="mt-1 flex flex-col items-center gap-1 rounded border border-default/40 bg-default/10 p-1">
          <select
            defaultValue=""
            onChange={(e) => {
              const startChannel = Number(e.target.value);
              if (!Number.isNaN(startChannel) && e.target.value !== "") onDirectOutput(mono, startChannel);
            }}
            className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] text-foreground focus:outline-none"
          >
            <option value="" disabled>
              Channel...
            </option>
            {options.map((o) => (
              <option key={o.startChannel} value={o.startChannel}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function updateBusChannels(bus: BusRow, index: number, channels: number, startChannel: number) {
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
}

// Bus output destination: send this bus's signal to the same physical
// channels as Master (summed into the main mix), or pin it to its own
// dedicated hardware output -- same two-step "Ext. Output" pattern as
// TrackOutputRouting (a single escape-hatch entry in the primary select,
// actual channel choices only appear in the secondary list once picked --
// not every channel dumped into the main dropdown). Every bus strip except
// Master gets this, plus a mono/stereo toggle for how many channels it claims.
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
  const stereo = bus.channels >= 2;
  const isFollowingMaster = !!master && bus.startChannel === master.startChannel && bus.channels === master.channels;
  const [extOutputOpen, setExtOutputOpen] = useState(!isFollowingMaster);
  const options = directOutputOptions(settings, stereo);

  return (
    <div className="w-full my-1 flex flex-col items-center gap-1">
      <button
        type="button"
        className="flex items-center gap-1 text-foreground/70"
        title={stereo ? "Stereo (click for mono)" : "Mono (click for stereo)"}
        onClick={() => updateBusChannels(bus, index, stereo ? 1 : 2, bus.startChannel)}
      >
        <MonoStereoIcon stereo={stereo} />
        <span className="text-[8px] uppercase">{stereo ? "Stereo" : "Mono"}</span>
      </button>
      <select
        value={extOutputOpen ? EXT_OUTPUT_VALUE : "master"}
        onChange={(e) => {
          if (e.target.value === EXT_OUTPUT_VALUE) {
            setExtOutputOpen(true);
          } else {
            setExtOutputOpen(false);
            if (master) updateBusChannels(bus, index, master.channels, master.startChannel);
          }
        }}
        className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none"
        title="Where this bus's signal goes"
      >
        <option value="master">Master</option>
        <option value={EXT_OUTPUT_VALUE}>Ext. Output</option>
      </select>

      {extOutputOpen && (
        <select
          value={isFollowingMaster ? "" : String(bus.startChannel)}
          onChange={(e) => {
            const startChannel = Number(e.target.value);
            if (!Number.isNaN(startChannel) && e.target.value !== "") updateBusChannels(bus, index, bus.channels, startChannel);
          }}
          className="w-full rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] text-foreground focus:outline-none"
        >
          <option value="" disabled>
            Channel...
          </option>
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
  children,
  onClick,
}: {
  active: boolean;
  color: "danger" | "warning";
  children: React.ReactNode;
  onClick: () => void;
}) {
  const activeCls =
    color === "danger" ? "bg-danger text-white border-danger" : "bg-warning text-black border-warning";
  return (
    <button
      onClick={onClick}
      className={`flex h-5 w-full items-center justify-center rounded border text-[10px] font-bold transition-colors ${
        active ? activeCls : "border-default/50 bg-default/10 text-foreground/50 hover:bg-default/25"
      }`}
    >
      {children}
    </button>
  );
}

function ChannelStrip({
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
  mute,
  solo,
  onGain,
  onPan,
  onMute,
  onSolo,
}: {
  name: string;
  subtitle?: string;
  color: string;
  busses?: BusRow[];
  busId?: string;
  onBusSelect?: (id: string) => void;
  // When set, the plain <select> is replaced by TrackOutputRouting (adds the
  // "Direct Output" escape hatch + mono/stereo channel picker). Track strips
  // only -- doesn't apply to bus/master/click strips.
  directOutput?: { settings: SettingsState; onDirectOutput: (mono: boolean, startChannel: number) => void };
  // Ableton-style send knob row, one per aux bus. Track strips only.
  sends?: { auxBusses: BusRow[]; values: { busId: string; gainDb: number }[]; trackIndex: number };
  // Mono/stereo toggle + Master-vs-Direct-Output routing. Bus strips only
  // (every bus except Master -- see BusDestinationRouting).
  busDestination?: React.ReactNode;
  gainDb: number;
  pan: number | null;
  peakDb: number | undefined;
  mute: boolean;
  solo: boolean;
  onGain: (v: number) => void;
  onPan: ((v: number) => void) | null;
  onMute: () => void;
  onSolo: () => void;
}) {
  const formatDb = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
  const formatPan = (p: number) => {
    if (Math.abs(p) < 0.05) return "C";
    if (p < 0) return `L${Math.round(-p * 100)}`;
    return `R${Math.round(p * 100)}`;
  };

  return (
    <div className="flex w-24 shrink-0 flex-col items-center justify-between rounded-lg border border-default/30 bg-surface/80 p-2 select-none">
      {/* Header */}
      <div className="flex flex-col items-center gap-0.5 w-full text-center">
        <div className="h-1 w-full rounded-full" style={{ backgroundColor: color }} />
        <div className="truncate text-xs font-semibold text-foreground w-full" title={name}>
          {name}
        </div>
        {subtitle && <div className="text-[9px] text-foreground/40 font-mono truncate w-full">{subtitle}</div>}
      </div>

      {/* Bus Routing Dropdown -- "Main and Sends": this main destination and
          the send knobs below are independent, both editable at once. */}
      {busses && onBusSelect && directOutput ? (
        <TrackOutputRouting
          busId={busId || ""}
          busses={busses}
          settings={directOutput.settings}
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
            accent={color}
            onCommit={onPan}
            size={24}
            title="Pan"
          />
          <div className="text-[9px] font-mono text-foreground/50">{formatPan(pan)}</div>
        </div>
      ) : (
        <div className="h-2" />
      )}

      {/* Fader & Meter Section */}
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 py-2">
        <GainFader gainDb={gainDb} accent={color} onChange={onGain} />
        <LevelMeterBar db={peakDb ?? -100} vertical={true} showValue={false} barClassName="h-full w-2" />
      </div>

      {/* Gain readout */}
      <div className="text-[10px] font-mono text-foreground/70 font-medium mb-1">
        {formatDb(gainDb)} dB
      </div>

      {/* Mute & Solo buttons */}
      <div className="flex w-full gap-1">
        <StripButton active={mute} color="danger" onClick={onMute}>
          M
        </StripButton>
        <StripButton active={solo} color="warning" onClick={onSolo}>
          S
        </StripButton>
      </div>

      {sends && <SendKnobs auxBusses={sends.auxBusses} sends={sends.values} trackIndex={sends.trackIndex} />}
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
  onDirectOutput,
}: {
  t: TrackRow;
  index: number;
  busses: BusRow[];
  auxBusses: BusRow[];
  meters: import("../lib/types").MeterRow[];
  settings: SettingsState;
  onDirectOutput: (trackIndex: number, mono: boolean, startChannel: number) => void;
}) {
  const color = colorForIndex(index);
  const busMeter = meters.find((m) => m.id === t.busId);
  const peakDb = t.peakDb ?? busMeter?.peakDb;

  return (
    <ChannelStrip
      name={t.name || t.id}
      subtitle={`Track ${index + 1}`}
      color={color}
      busses={busses}
      busId={t.busId}
      onBusSelect={(bId) => mixer.setTrackBus(index, bId)}
      directOutput={{ settings, onDirectOutput: (mono, ch) => onDirectOutput(index, mono, ch) }}
      sends={{ auxBusses, values: t.sends, trackIndex: index }}
      gainDb={t.gainDb ?? 0}
      pan={t.pan ?? 0}
      peakDb={peakDb}
      mute={t.mute}
      solo={t.solo}
      onGain={(v) => mixer.setTrackGain(index, v)}
      onPan={(v) => mixer.setTrackPan(index, v)}
      onMute={() => mixer.setTrackMute(index, !t.mute)}
      onSolo={() => mixer.setTrackSolo(index, !t.solo)}
    />
  );
}

function MetronomeStrip({ state }: { state: WebUiState }) {
  const [clickGain, setClickGain] = useState(0);
  const [clickPan, setClickPan] = useState(0);
  const [clickSolo, setClickSolo] = useState(false);

  const hasSongs = state.songs.length > 0;
  const isMetronomeOn = hasSongs ? state.songs.some((s) => s.click) : false;
  const currentClickBus =
    hasSongs && state.songIndex >= 0 && state.songs[state.songIndex]?.clickBusId
      ? state.songs[state.songIndex].clickBusId
      : state.busses[0]?.id || "main";

  const clickBusMeter = state.meters.find((m) => m.id === currentClickBus);

  const toggleMetronomeMute = () => {
    const nextState = !isMetronomeOn;
    const busId = currentClickBus;
    if (hasSongs && state.songIndex >= 0 && state.songs[state.songIndex]) {
      const s = state.songs[state.songIndex];
      void builder.songUpdate({
        index: state.songIndex,
        name: s.name,
        bpm: s.bpm,
        mode: s.mode,
        tsNum: s.tsNum,
        tsDen: s.tsDen,
        click: nextState,
        clickBusId: s.clickBusId || busId,
        clickSends: s.clickSends ?? [],
      });
    }
  };

  const changeClickBus = (busId: string) => {
    if (hasSongs && state.songIndex >= 0 && state.songs[state.songIndex]) {
      const s = state.songs[state.songIndex];
      void builder.songUpdate({
        index: state.songIndex,
        name: s.name,
        bpm: s.bpm,
        mode: s.mode,
        tsNum: s.tsNum,
        tsDen: s.tsDen,
        click: s.click,
        clickBusId: busId,
        clickSends: s.clickSends ?? [],
      });
    }
  };

  return (
    <ChannelStrip
      name="Click"
      subtitle="Metronome"
      color="#ff9230"
      busses={state.busses}
      busId={currentClickBus}
      onBusSelect={changeClickBus}
      gainDb={clickGain}
      pan={clickPan}
      peakDb={isMetronomeOn ? clickBusMeter?.peakDb : -100}
      mute={!isMetronomeOn}
      solo={clickSolo}
      onGain={(v) => setClickGain(v)}
      onPan={(v) => setClickPan(v)}
      onMute={toggleMetronomeMute}
      onSolo={() => setClickSolo(!clickSolo)}
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
}: {
  b: BusRow;
  index: number;
  meters: import("../lib/types").MeterRow[];
  master?: BusRow;
  settings: SettingsState;
  isMaster?: boolean;
}) {
  const meter = meters.find((m) => m.id === b.id);
  const color = isMaster ? "#ff375f" : "#ff9230";

  return (
    <ChannelStrip
      name={b.name || b.id}
      subtitle={isMaster ? "Master Output" : b.isAux ? "Aux Send" : "Sub Bus"}
      color={color}
      gainDb={b.gainDb ?? 0}
      pan={null}
      peakDb={meter?.peakDb ?? b.peakDb}
      mute={b.mute}
      solo={b.solo}
      onGain={(v) => mixer.setBusGain(index, v)}
      onPan={null}
      onMute={() => mixer.setBusMute(index, !b.mute)}
      onSolo={() => mixer.setBusSolo(index, !b.solo)}
      busDestination={!isMaster ? <BusDestinationRouting bus={b} index={index} master={master} settings={settings} /> : undefined}
    />
  );
}

interface TrackMenuState {
  x: number;
  y: number;
  index: number;
}

function MenuItem({
  children,
  danger = false,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center px-3 py-1.5 text-left transition-colors disabled:opacity-30 disabled:cursor-default ${
        danger
          ? "text-danger hover:bg-danger/10"
          : "text-foreground/80 hover:bg-default/20"
      }`}
    >
      {children}
    </button>
  );
}

// Right-click menu for a mixer track strip. Everything here is backed by
// APIs that already exist (builder.trackMove/trackUpdate/trackRemove,
// mixer.setTrack*) -- no new backend routes needed. Rename uses an inline
// text field rather than window.prompt(), since the embedded native
// WebView's WKWebView backing isn't guaranteed to implement the JS prompt()
// panel (window.confirm() already works elsewhere in this app and is used
// here for the destructive Remove action, but prompt() is a separate,
// less-commonly-implemented UIDelegate method).
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

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="fixed z-50 w-48 overflow-hidden rounded-lg border border-default/40 bg-surface py-1 text-xs shadow-xl"
        style={{ left: menu.x, top: menu.y }}
      >
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
          <MenuItem onClick={() => setRenaming(true)}>Rename...</MenuItem>
        )}
        <MenuItem onClick={() => act(() => void builder.trackMove(songIndex, menu.index, -1))}>Move Left</MenuItem>
        <MenuItem onClick={() => act(() => void builder.trackMove(songIndex, menu.index, 1))}>Move Right</MenuItem>
        <div className="my-1 h-px bg-default/20" />
        <MenuItem
          onClick={() =>
            act(() => {
              void mixer.setTrackGain(menu.index, 0);
              void mixer.setTrackPan(menu.index, 0);
            })
          }
        >
          Reset Gain &amp; Pan
        </MenuItem>
        <MenuItem
          onClick={() =>
            act(() => {
              void mixer.setTrackMute(menu.index, false);
              void mixer.setTrackSolo(menu.index, false);
            })
          }
        >
          Clear Mute &amp; Solo
        </MenuItem>
        <MenuItem
          disabled={track.sends.length === 0}
          onClick={() =>
            act(() => {
              for (const s of track.sends) void mixer.setTrackSend(menu.index, s.busId, SEND_FLOOR_DB);
            })
          }
        >
          Clear All Sends
        </MenuItem>
        <div className="my-1 h-px bg-default/20" />
        <MenuItem
          danger
          onClick={() =>
            act(() => {
              if (window.confirm(`Remove track "${track.name || track.id}"? This can't be undone.`))
                void builder.trackRemove(songIndex, menu.index);
            })
          }
        >
          Remove Track
        </MenuItem>
      </div>
    </>
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

  useEffect(() => {
    if (pendingBusJobs.current.length === 0) return;
    const claimed = new Set<string>();
    const remaining: PendingBusJob[] = [];
    for (const job of pendingBusJobs.current) {
      const idx = state.busses.findIndex((b) => !job.knownIds.has(b.id) && !claimed.has(b.id));
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
    pendingBusJobs.current.push({ knownIds: new Set(state.busses.map((b) => b.id)), finalize });
    void builder.busAdd();
  }

  function nextOutputChannel(): number {
    return state.busses.reduce((max, b) => Math.max(max, b.startChannel + b.channels), 0);
  }

  // "+ Add Send" -- creates a new aux (return) bus directly from the mixer
  // page, same result as BuilderPanel's "Add Return" button, just reachable
  // without leaving the Mixer. Always starts stereo; mono is a per-bus
  // toggle on the strip itself afterward (see BusDestinationRouting), not a
  // separate creation path.
  function requestAddSend() {
    const label = `Send ${auxBusses.length + 1}`;
    queueBusJob((_busId, index) => {
      void builder.busUpdate({
        index,
        name: label,
        channels: 2,
        startChannel: nextOutputChannel(),
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
  function requestDirectOutput(trackIndex: number, mono: boolean, startChannel: number) {
    const channels = mono ? 1 : 2;
    const existing = mainBusses.find((b) => b.startChannel === startChannel && b.channels === channels);
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
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-default/30 bg-surface/60 p-3">
        {state.tracks.length === 0 && state.busses.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center px-4 py-6 text-center text-sm text-foreground/40">
            No tracks staged in this project.
          </div>
        ) : (
          <>
            {/* Left: Scrollable Ordinary Track Strips */}
            <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto pr-1">
              {state.tracks.map((t, i) => (
                <div
                  key={t.id}
                  className="flex shrink-0"
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
                    onDirectOutput={requestDirectOutput}
                  />
                </div>
              ))}
            </div>

            {/* Vertical Separator Divider Line */}
            <div className="mx-2 w-px shrink-0 self-stretch bg-default/40" />

            {/* Right: "+ Send" (left, centered, big), then Sends, then Metronome (own separator), then Master */}
            <div className="flex shrink-0 gap-2">
              <div className="flex h-full w-20 shrink-0 flex-col items-center justify-center">
                <button
                  onClick={() => requestAddSend()}
                  title="Add a new return/send bus"
                  className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-default/40 bg-default/10 text-foreground/60 transition-colors hover:bg-default/25 hover:text-foreground"
                >
                  <Plus size={22} />
                  <span className="text-[11px] font-semibold">Send</span>
                </button>
              </div>

              {auxBusses.map((b) => (
                <BusStrip
                  key={b.id}
                  b={b}
                  index={state.busses.indexOf(b)}
                  meters={state.meters}
                  master={master}
                  settings={state.settings}
                />
              ))}

              <div className="mx-1 w-px shrink-0 self-stretch bg-default/40" />

              <MetronomeStrip state={state} />

              <div className="mx-1 w-px shrink-0 self-stretch bg-default/40" />

              {mainBusses.map((b) => (
                <BusStrip
                  key={b.id}
                  b={b}
                  index={state.busses.indexOf(b)}
                  meters={state.meters}
                  master={master}
                  settings={state.settings}
                  isMaster={b === master}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {trackMenu && state.tracks[trackMenu.index] && (
        <TrackContextMenu
          menu={trackMenu}
          track={state.tracks[trackMenu.index]}
          songIndex={state.songIndex}
          onClose={() => setTrackMenu(null)}
        />
      )}
    </div>
  );
}
