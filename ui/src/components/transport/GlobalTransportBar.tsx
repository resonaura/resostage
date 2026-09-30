import { Popover, Separator, Toolbar, Tooltip } from "@heroui/react";
import {
  Circle,
  Footprints,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FontIcon } from "../common/FontIcon";
import { patchClickFields } from "../../screens/mixer/logic/mixerUtils";
import { transport } from "../../lib/state/api";
import { useContinuousPlayhead } from "../../lib/state/optimistic";
import type { WebUiState } from "../../lib/state/types";
import { TimeDisplay } from "../daw";
import { CountInControl } from "./CountInControl";
import { ToggleButton, ToggleButtonGroup } from "../ui";

/**
 * Compact transport for the app header (non-Player tabs): clock chip, song +
 * BPM, transport buttons, and metronome toggle. Parent owns center placement + show/hide fade.
 *
 * The clock and the icon buttons are DAW primitives now (see components/daw)
 * — this file is arrangement only.
 */
export function GlobalTransportBar({ state }: { state: WebUiState }) {
  const song =
    state.songIndex >= 0 && state.songs[state.songIndex]
      ? state.songs[state.songIndex]
      : null;
  const songTitle = state.songName || song?.name || "";
  const bpm = song && song.bpm > 0 ? song.bpm : (state.bpm ?? 0);
  const tsNum = song && song.tsNum > 0 ? song.tsNum : 4;
  const tsDen = song && song.tsDen > 0 ? song.tsDen : 4;
  const [meterOpen, setMeterOpen] = useState(false);
  const [draftBpm, setDraftBpm] = useState("");
  const [draftNumerator, setDraftNumerator] = useState("");
  const [draftDenominator, setDraftDenominator] = useState("");
  const tapTimesRef = useRef<number[]>([]);
  const [tapTempoBpm, setTapTempoBpm] = useState<number | null>(null);

  useEffect(() => {
    tapTimesRef.current = [];
    setTapTempoBpm(null);
  }, [state.songIndex]);

  useEffect(() => {
    if (tapTempoBpm !== null && Math.abs(tapTempoBpm - bpm) < 0.05)
      setTapTempoBpm(null);
  }, [bpm, tapTempoBpm]);

  const tapTempo = () => {
    if (!song) return;
    const now = performance.now();
    const previous = tapTimesRef.current.at(-1);
    if (previous !== undefined && now - previous > 2000)
      tapTimesRef.current = [];
    tapTimesRef.current.push(now);
    tapTimesRef.current = tapTimesRef.current.slice(-6);
    if (tapTimesRef.current.length < 2) return;

    const intervals = tapTimesRef.current.slice(1)
      .map((time, index) => time - tapTimesRef.current[index])
      .filter((interval) => interval >= 150 && interval <= 3000)
      .sort((a, b) => a - b);
    if (intervals.length === 0) return;
    const middle = Math.floor(intervals.length / 2);
    const median = intervals.length % 2 === 0
      ? (intervals[middle - 1] + intervals[middle]) / 2
      : intervals[middle];
    const nextBpm = Math.round(Math.max(20, Math.min(400, 60_000 / median)) * 10) / 10;
    setTapTempoBpm(nextBpm);
    patchClickFields(state, { bpm: nextBpm });
  };

  const openMeter = (open: boolean) => {
    if (open) {
      setDraftBpm(String(bpm));
      setDraftNumerator(String(tsNum));
      setDraftDenominator(String(tsDen));
    }
    setMeterOpen(open);
  };
  const commitMeter = () => {
    const nextBpm = Number(draftBpm);
    const nextNum = Number(draftNumerator);
    const nextDen = Number(draftDenominator);
    if (!song || !Number.isFinite(nextBpm) || nextBpm < 20 || nextBpm > 400 ||
        !Number.isInteger(nextNum) || nextNum < 1 || nextNum > 32 ||
        ![1, 2, 4, 8, 16, 32].includes(nextDen)) return;
    patchClickFields(state, { bpm: nextBpm, tsNum: nextNum, tsDen: nextDen });
    setMeterOpen(false);
  };

  const [metronomeOverride, setMetronomeOverride] = useState<boolean | null>(
    null,
  );
  const isMetronomeOn =
    metronomeOverride ?? state.click?.enabled ?? song?.click ?? false;

  useEffect(() => {
    if (
      metronomeOverride != null &&
      (state.click?.enabled ?? song?.click) === metronomeOverride
    ) {
      setMetronomeOverride(null);
    }
  }, [state.click?.enabled, song?.click, metronomeOverride]);

  const toggleMetronome = () => {
    const nextState = !isMetronomeOn;
    setMetronomeOverride(nextState);
    patchClickFields(state, { click: nextState });
  };

  // A local clock that keeps moving between telemetry frames, re-synced to
  // the engine whenever one arrives. `publishToReact: false` -- this bar has
  // no business re-rendering on the clock; the readout samples it directly.
  const [, , getLiveSeconds] = useContinuousPlayhead(
    state.playheadSeconds,
    state.playing,
    state.songIndex,
    false,
    undefined,
    undefined,
    false,
  );

  return (
    <Toolbar
      aria-label="Transport controls"
      className="h-9 flex items-center bg-transparent"
    >
      <TimeDisplay
        seconds={state.playheadSeconds}
        getSeconds={getLiveSeconds}
        bpm={bpm}
        tsNum={tsNum}
        playing={state.playing}
        hasSong={song !== null}
      />
      <Separator orientation="vertical" />
      <ToggleButtonGroup
        size="sm"
        orientation="horizontal"
        isDetached={false}
        fullWidth={false}
      >
        <ToggleButton
          isIconOnly
          isSelected={false}
          onPress={() => transport.prev()}
          aria-label="Previous"
          variant="ghost"
        >
          <SkipBack size={14} />
        </ToggleButton>
        {/* Play/pause is the one wide button: it is the control you hit without
            looking, so it gets a target the others do not. */}
        <ToggleButton
          isIconOnly
          isSelected={true}
          onPress={() => (state.playing ? transport.stop() : transport.play())}
          aria-label={state.playing ? "Pause" : "Play"}
          className="font-semibold"
          variant={state.playing ? "accent-soft" : "default-soft"}
        >
          <ToggleButtonGroup.Separator />
          {state.playing ? <Pause size={13} /> : <Play size={13} />}
        </ToggleButton>
        <ToggleButton
          isIconOnly
          isSelected={true}
          onPress={() => transport.stopToStart()}
          aria-label="Stop"
          variant="danger-soft"
        >
          <ToggleButtonGroup.Separator />
          <Square size={14} />
        </ToggleButton>
        <ToggleButton
          isIconOnly
          isSelected={state.recording ?? false}
          onPress={() => void transport.record()}
          aria-label={
            state.recordingCountIn
              ? "Recording count-in in progress"
              : state.recording
                ? "Stop Recording"
                : "Record"
          }
          variant={state.recording ? "danger-soft" : "ghost"}
          className={
            state.recording
              ? "text-danger animate-pulse font-bold"
              : "text-foreground/70 hover:text-danger"
          }
        >
          <ToggleButtonGroup.Separator />
          <Circle
            size={12}
            className={state.recording ? "fill-danger" : "fill-current"}
          />
        </ToggleButton>
        {state.recordingCountIn && (
          <span
            className="flex h-8 min-w-10 items-center justify-center rounded-md bg-(--rs-record)/15 px-1 font-mono text-(--rs-record)"
            role="status"
            aria-live="polite"
            aria-label={`Count-in: ${state.recordingCountInBeatsRemaining ?? 0} beats remaining`}
          >
            <strong
              key={state.recordingCountInBeatsRemaining}
              className="rs-count-in-beat text-2xl font-bold leading-none tabular-nums"
            >
              {((Math.max(1, state.recordingCountInBeatsRemaining ?? 1) - 1) % tsNum) + 1}
            </strong>
          </span>
        )}
        <ToggleButton
          isIconOnly
          isSelected={false}
          onPress={() => transport.next()}
          aria-label="Next"
          variant="ghost"
        >
          <ToggleButtonGroup.Separator />
          <SkipForward size={14} />
        </ToggleButton>
      </ToggleButtonGroup>
      <Separator orientation="vertical" />
      <Popover isOpen={meterOpen} onOpenChange={openMeter}>
        <button
          type="button"
          disabled={!song}
          className="flex h-7 w-28 sm:w-36 shrink-0 flex-col justify-center rounded-md px-2 text-center transition-colors hover:bg-default/10 disabled:opacity-40"
          title={`${songTitle || "Song"} · Edit tempo and meter`}
          aria-label="Edit song tempo and time signature"
        >
          <span className="font-mono text-[11px] font-semibold tabular-nums leading-tight text-foreground/85">
            {Number.isInteger(tapTempoBpm ?? bpm)
              ? (tapTempoBpm ?? bpm)
              : (tapTempoBpm ?? bpm).toFixed(1)} BPM
          </span>
          <span className="font-mono text-[10px] tabular-nums leading-tight text-foreground/50">
            {tsNum}/{tsDen}
          </span>
        </button>
        <Popover.Content className="w-64 rounded-xl border border-default/30 bg-surface shadow-xl">
          <Popover.Dialog>
            <form className="space-y-3 p-3" onSubmit={(event) => { event.preventDefault(); commitMeter(); }}>
              <div className="truncate text-xs font-semibold text-foreground/65">{songTitle}</div>
              <label className="block text-[10px] text-foreground/55">
                Tempo (BPM)
                <input type="number" min="20" max="400" step="0.1" value={draftBpm}
                  onChange={(event) => setDraftBpm(event.target.value)}
                  className="mt-1 w-full rounded-md border border-default/40 bg-background px-2 py-1 text-sm text-foreground" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] text-foreground/55">Beats/bar
                  <input type="number" min="1" max="32" value={draftNumerator}
                    onChange={(event) => setDraftNumerator(event.target.value)}
                    className="mt-1 w-full rounded-md border border-default/40 bg-background px-2 py-1 text-sm text-foreground" />
                </label>
                <label className="text-[10px] text-foreground/55">Beat unit
                  <select value={draftDenominator} onChange={(event) => setDraftDenominator(event.target.value)}
                    className="mt-1 w-full rounded-md border border-default/40 bg-background px-2 py-1 text-sm text-foreground">
                    {[1, 2, 4, 8, 16, 32].map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                  </select>
                </label>
              </div>
              <button type="submit" className="w-full rounded-md bg-accent px-2 py-1.5 text-xs font-semibold text-accent-foreground">Apply</button>
            </form>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <Tooltip>
        <ToggleButton
          isIconOnly
          size="sm"
          isSelected={false}
          isDisabled={!song}
          onPress={tapTempo}
          aria-label="Tap Tempo"
          variant="ghost"
          className="h-7 w-7 min-w-7 text-foreground/70 hover:text-accent disabled:opacity-40"
        >
          <Footprints size={15} aria-hidden="true" />
        </ToggleButton>
        <Tooltip.Content>Tap Tempo · tap in time to set the song BPM</Tooltip.Content>
      </Tooltip>
      <Separator orientation="vertical" />
      {/* Metronome toggle */}
      <div className="pl-1">
        <Tooltip>
          <ToggleButton
            isIconOnly
            size="sm"
            isSelected={isMetronomeOn}
            onPress={toggleMetronome}
            aria-label="Metronome"
            variant={isMetronomeOn ? "accent-soft" : "ghost"}
            className={`h-7 w-7 ${
              isMetronomeOn
                ? "text-accent font-semibold"
                : "text-foreground/70 hover:text-foreground"
            }`}
          >
            <FontIcon name="metronome" size={15} />
          </ToggleButton>
          <Tooltip.Content>{`Metronome (${isMetronomeOn ? "On" : "Off"})`}</Tooltip.Content>
        </Tooltip>
      </div>
      <div className="pl-1">
        <CountInControl state={state} compact />
      </div>
    </Toolbar>
  );
}
