import { useEffect, useRef, useState } from "react";
import { Slider } from "@heroui/react";
import { LevelMeterBar } from "../components/LevelMeterBar";
import { mixer } from "../lib/api";
import type { BusRow, TrackRow, WebUiState } from "../lib/types";

// Ableton-style channel strip console: colored title bar, pan knob, mute/
// solo, then a peak meter running alongside the vertical gain fader. Same
// backend calls as before (AudioEngine::setTrackGainDb et al. via
// MainComponent::drainWebCommands()) -- this is a visual rebuild only.

const TRACK_COLORS = [
  "#ff5a5f", "#ff9f43", "#feca57", "#1dd1a1", "#00d2d3",
  "#54a0ff", "#5f27cd", "#c56cf0", "#ff6b81", "#a4b0be",
];
function colorForIndex(i: number): string {
  return TRACK_COLORS[i % TRACK_COLORS.length];
}

// Server round-trips take a WS frame or two; keep the control's visual value
// local for ~400ms after a user edit so drags feel instant, then let the next
// live snapshot take back over (so other clients moving the same control are
// still reflected here).
function useLiveValue(serverValue: number, commit: (v: number) => void) {
  const [value, setValue] = useState(serverValue);
  const lastLocalEdit = useRef(0);

  useEffect(() => {
    if (Date.now() - lastLocalEdit.current > 400) setValue(serverValue);
  }, [serverValue]);

  const onChange = (v: number) => {
    lastLocalEdit.current = Date.now();
    setValue(v);
    commit(v);
  };

  return [value, onChange] as const;
}

const GAIN_MIN = -60;
const GAIN_MAX = 12;

function GainFader({ gainDb, onChange }: { gainDb: number; onChange: (v: number) => void }) {
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
      <Slider.Track className="h-full w-1.5 rounded-full bg-default/30">
        <Slider.Fill className="w-full rounded-full bg-accent" />
        <Slider.Thumb className="size-3.5 rounded-full border-2 border-background bg-accent shadow" />
      </Slider.Track>
    </Slider>
  );
}

// Compact rotary knob (drag up/down to change) -- pan control, Ableton-style.
function Knob({
  value,
  min,
  max,
  defaultValue = 0,
  onChange,
  size = 26,
  title,
}: {
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  onChange: (v: number) => void;
  size?: number;
  title?: string;
}) {
  const dragging = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);

  const angleFor = (v: number) => {
    const t = (v - min) / (max - min);
    return -135 + t * 270;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    startY.current = e.clientY;
    startValue.current = value;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const dy = startY.current - e.clientY;
    const range = max - min;
    const next = Math.max(min, Math.min(max, startValue.current + (dy / 120) * range));
    onChange(Math.round(next * 100) / 100);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      role="slider"
      aria-label={title}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => onChange(defaultValue)}
      className="relative shrink-0 cursor-ns-resize touch-none select-none rounded-full border border-default/60 bg-default/20"
      style={{ width: size, height: size }}
    >
      <div
        className="absolute left-1/2 top-1/2 w-[2px] -translate-x-1/2 -translate-y-full rounded-full bg-foreground/80"
        style={{
          height: size * 0.4,
          transformOrigin: "bottom center",
          transform: `translateX(-50%) rotate(${angleFor(value)}deg)`,
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
  sub,
  accent,
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
  sub: string;
  accent: string;
  gainDb: number;
  pan: number | null;
  peakDb: number;
  mute: boolean;
  solo: boolean;
  onGain: (v: number) => void;
  onPan: ((v: number) => void) | null;
  onMute: () => void;
  onSolo: () => void;
}) {
  const [panValue, handlePan] = useLiveValue(pan ?? 0, onPan ?? (() => {}));

  return (
    <div className="flex h-full w-[76px] shrink-0 flex-col overflow-hidden rounded-lg border border-default/40 bg-black/25">
      <div className="h-1 w-full shrink-0" style={{ background: accent }} />
      <div className="flex shrink-0 flex-col gap-1 px-1.5 pt-1.5">
        <div className="truncate text-center text-[11px] font-semibold leading-tight" title={name}>
          {name}
        </div>
        <div className="truncate text-center text-[9px] leading-tight text-foreground/40" title={sub}>
          {sub}
        </div>
        <div className="flex justify-center py-0.5">
          {onPan ? (
            <Knob value={panValue} min={-1} max={1} onChange={handlePan} title="Pan" />
          ) : (
            <div className="h-[26px]" />
          )}
        </div>
        <div className="flex gap-1">
          <StripButton active={mute} color="danger" onClick={onMute}>
            M
          </StripButton>
          <StripButton active={solo} color="warning" onClick={onSolo}>
            S
          </StripButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-stretch justify-center gap-1.5 px-2 py-2">
        <LevelMeterBar
          db={peakDb}
          vertical
          showValue={false}
          barClassName="h-full w-2.5"
          className="!gap-0 h-full"
        />
        <GainFader gainDb={gainDb} onChange={onGain} />
      </div>
      <div className="shrink-0 border-t border-default/30 bg-black/20 py-1 text-center text-[10px] tabular-nums text-foreground/60">
        {gainDb.toFixed(1)}
      </div>
    </div>
  );
}

function TrackStrip({ t, index }: { t: TrackRow; index: number }) {
  return (
    <ChannelStrip
      name={t.name || t.id}
      sub={t.busId || "sends only"}
      accent={colorForIndex(index)}
      gainDb={t.gainDb}
      pan={t.pan}
      peakDb={t.peakDb}
      mute={t.mute}
      solo={t.solo}
      onGain={(v) => mixer.setTrackGain(index, v)}
      onPan={(v) => mixer.setTrackPan(index, v)}
      onMute={() => mixer.setTrackMute(index, !t.mute)}
      onSolo={() => mixer.setTrackSolo(index, !t.solo)}
    />
  );
}

function BusStrip({ b, index }: { b: BusRow; index: number }) {
  return (
    <ChannelStrip
      name={b.name || b.id}
      sub={b.isAux ? "AUX RETURN" : `ch ${b.startChannel}`}
      accent={b.isAux ? "#8e8e93" : "#0a84ff"}
      gainDb={b.gainDb}
      pan={null}
      peakDb={b.peakDb}
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
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 text-xs text-foreground/40">
        <span className="font-semibold uppercase tracking-wide">Console</span>
        <span>&middot;</span>
        <span>{state.tracks.length} tracks</span>
        <span>&middot;</span>
        <span>{state.busses.length} busses</span>
      </div>

      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto rounded-xl border border-default/30 bg-surface/60 p-3">
        {state.tracks.length === 0 && state.busses.length === 0 ? (
          <div className="w-full py-10 text-center text-sm text-foreground/50">No tracks staged.</div>
        ) : (
          <>
            {state.tracks.map((t, i) => (
              <TrackStrip key={t.id} t={t} index={i} />
            ))}
            {state.tracks.length > 0 && state.busses.length > 0 && (
              <div className="mx-1 w-px shrink-0 self-stretch bg-default/30" />
            )}
            {state.busses.map((b, i) => (
              <BusStrip key={b.id} b={b} index={i} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
