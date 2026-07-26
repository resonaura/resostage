import { useEffect, useRef, useState } from "react";
import { Button, Card, Slider } from "@heroui/react";
import { LevelMeterBar } from "../components/LevelMeterBar";
import { mixer } from "../lib/api";
import type { BusRow, TrackRow, WebUiState } from "../lib/types";

// Full parity with the native MixerStrip: gain fader (-60..12 dB), pan
// (track-only, -1..1), mute/solo. Posts land on the same
// AudioEngine::setTrackGainDb et al. setters MixerPanel.cpp already uses --
// see MainComponent::drainWebCommands(). Local value is optimistic (updates
// immediately on drag) and re-syncs from the ~30Hz WS snapshot once the user
// stops touching the control, so other clients moving the same fader still
// show up here.
function useLiveValue(serverValue: number, commit: (v: number) => void) {
  const [value, setValue] = useState(serverValue);
  const lastLocalEdit = useRef(0);

  useEffect(() => {
    if (Date.now() - lastLocalEdit.current > 400) {
      setValue(serverValue);
    }
  }, [serverValue]);

  const onChange = (v: number | number[]) => {
    const n = Array.isArray(v) ? v[0] : v;
    lastLocalEdit.current = Date.now();
    setValue(n);
    commit(n);
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
      onChange={handleChange}
      minValue={GAIN_MIN}
      maxValue={GAIN_MAX}
      step={0.1}
      orientation="vertical"
      aria-label="Gain"
      className="h-28"
    >
      <Slider.Track className="h-full w-2 rounded-full bg-default/40">
        <Slider.Fill className="w-full rounded-full bg-accent" />
        <Slider.Thumb className="size-4 rounded-full border-2 border-background bg-accent" />
      </Slider.Track>
    </Slider>
  );
}

function PanKnob({ pan, onChange }: { pan: number; onChange: (v: number) => void }) {
  const [value, handleChange] = useLiveValue(pan, onChange);
  return (
    <Slider
      value={value}
      onChange={handleChange}
      minValue={-1}
      maxValue={1}
      step={0.01}
      aria-label="Pan"
      className="w-full"
    >
      <Slider.Track className="h-1.5 w-full rounded-full bg-default/40">
        <Slider.Fill className="h-full rounded-full bg-foreground/40" />
        <Slider.Thumb className="size-3 rounded-full border-2 border-background bg-foreground/70" />
      </Slider.Track>
    </Slider>
  );
}

function StripCard({
  name,
  sub,
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
  return (
    <Card className="w-28 shrink-0">
      <Card.Content className="flex flex-col items-center gap-2 pt-4">
        <div className="w-full truncate text-center text-xs font-bold">{name}</div>
        <div className="w-full truncate text-center text-[10px] text-foreground/50">{sub}</div>
        <GainFader gainDb={gainDb} onChange={onGain} />
        <div className="text-[11px] tabular-nums text-foreground/60">{gainDb.toFixed(1)} dB</div>
        <div className="text-[10px] tabular-nums text-foreground/40">peak {peakDb.toFixed(1)}</div>
        {onPan && pan !== null ? <PanKnob pan={pan} onChange={onPan} /> : null}
        <div className="flex gap-1">
          <Button size="sm" variant={mute ? "danger" : "outline"} onPress={onMute}>
            M
          </Button>
          <Button size="sm" variant={solo ? "secondary" : "outline"} onPress={onSolo}>
            S
          </Button>
        </div>
      </Card.Content>
    </Card>
  );
}

function TrackStrip({ t, index }: { t: TrackRow; index: number }) {
  return (
    <StripCard
      name={t.name || t.id}
      sub={`→ ${t.busId || "(sends only)"}`}
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
    <StripCard
      name={b.name || b.id}
      sub={b.isAux ? "AUX" : `ch ${b.startChannel}`}
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
    <div className="flex flex-col gap-4">
      <Card>
        <Card.Header>
          <Card.Title>Tracks</Card.Title>
          <Card.Description>Current song</Card.Description>
        </Card.Header>
        <Card.Content className="flex gap-3 overflow-x-auto pb-2">
          {state.tracks.length === 0 ? (
            <div className="py-6 text-sm text-foreground/50">No tracks staged.</div>
          ) : (
            state.tracks.map((t, i) => <TrackStrip key={t.id} t={t} index={i} />)
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Busses</Card.Title>
        </Card.Header>
        <Card.Content className="flex gap-3 overflow-x-auto pb-2">
          {state.busses.length === 0 ? (
            <div className="py-6 text-sm text-foreground/50">No busses.</div>
          ) : (
            state.busses.map((b, i) => <BusStrip key={b.id} b={b} index={i} />)
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Bus meters</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          {state.meters.map((m) => (
            <LevelMeterBar key={m.id} db={m.peakDb} label={m.id} vertical={false} />
          ))}
        </Card.Content>
      </Card>
    </div>
  );
}
