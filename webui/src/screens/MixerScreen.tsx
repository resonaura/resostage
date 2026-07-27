import { useRef, useState } from "react";
import { Slider } from "@heroui/react";
import { LevelMeterBar } from "../components/LevelMeterBar";
import { builder, mixer } from "../lib/api";
import { useLiveValue } from "../lib/optimistic";
import type { BusRow, TrackRow, WebUiState } from "../lib/types";

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

      {/* Bus Routing Dropdown */}
      {busses && onBusSelect && (
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
      )}

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
    </div>
  );
}

function TrackStrip({
  t,
  index,
  busses,
  meters,
}: {
  t: TrackRow;
  index: number;
  busses: BusRow[];
  meters: import("../lib/types").MeterRow[];
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
  isMaster = false,
}: {
  b: BusRow;
  index: number;
  meters: import("../lib/types").MeterRow[];
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
    />
  );
}

export function MixerScreen({ state }: { state: WebUiState }) {
  const auxBusses = state.busses.filter((b) => b.isAux);
  const mainBusses = state.busses.filter((b) => !b.isAux);

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
                <TrackStrip key={t.id} t={t} index={i} busses={state.busses} meters={state.meters} />
              ))}
            </div>

            {/* Vertical Separator Divider Line */}
            <div className="mx-2 w-px shrink-0 self-stretch bg-default/40" />

            {/* Right: Pinned Metronome Track Strip + Aux Busses + Master Bus (Always pinned on the far right) */}
            <div className="flex shrink-0 gap-2">
              <MetronomeStrip state={state} />
              {auxBusses.map((b) => (
                <BusStrip
                  key={b.id}
                  b={b}
                  index={state.busses.indexOf(b)}
                  meters={state.meters}
                />
              ))}
              {mainBusses.map((b) => (
                <BusStrip
                  key={b.id}
                  b={b}
                  index={state.busses.indexOf(b)}
                  meters={state.meters}
                  isMaster={true}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
