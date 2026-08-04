import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { useState } from "react";
import { transport } from "../lib/api";
import type { WebUiState } from "../lib/types";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * 10);
  return `${m}:${s < 10 ? "0" : ""}${s}.${f}`;
}

function barBeat(seconds: number, bpm: number, tsNum: number): string {
  if (bpm <= 0 || seconds < 0) return "—";
  const beatsPerBar = Math.max(1, tsNum);
  const totalBeats = seconds / (60 / bpm);
  const bar = Math.floor(totalBeats / beatsPerBar) + 1;
  const beat = (Math.floor(totalBeats) % beatsPerBar) + 1;
  return `${bar} | ${beat}`;
}

/**
 * Compact transport for the app header (non-Player tabs). Fixed-width
 * time chip (click toggles time ↔ bar|beat), song+BPM, transport buttons.
 * Parent owns center placement + show/hide fade.
 */
export function GlobalTransportBar({ state }: { state: WebUiState }) {
  const [clockMode, setClockMode] = useState<"time" | "bars">("time");
  const song =
    state.songIndex >= 0 && state.songs[state.songIndex]
      ? state.songs[state.songIndex]
      : null;
  const bpm = song && song.bpm > 0 ? song.bpm : 0;
  const tsNum = song && song.tsNum > 0 ? song.tsNum : 4;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-default/40 bg-default/10 px-1.5">
      {/* Fixed-width time chip — click toggles display mode */}
      <button
        type="button"
        onClick={() => setClockMode((m) => (m === "time" ? "bars" : "time"))}
        className={`flex h-7 w-[5.5rem] shrink-0 items-center justify-center rounded-md px-1 font-mono text-xs tabular-nums transition-colors hover:bg-default/20 ${
          state.playing ? "text-success" : "text-foreground/70"
        }`}
        title={
          clockMode === "time"
            ? "Time — click for bar|beat"
            : "Bar|beat — click for time"
        }
      >
        {clockMode === "time"
          ? formatTime(state.playheadSeconds)
          : song
            ? barBeat(state.playheadSeconds, bpm || 120, tsNum)
            : "—"}
      </button>

      <button
        type="button"
        onClick={() => transport.prev()}
        className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/55 transition-colors hover:bg-default/25 hover:text-foreground"
        title="Previous"
      >
        <SkipBack size={14} />
      </button>
      <button
        type="button"
        onClick={() => (state.playing ? transport.stop() : transport.play())}
        className="flex h-7 w-[4.75rem] shrink-0 items-center justify-center gap-1 rounded-md bg-accent/20 text-xs font-semibold text-accent transition-colors hover:bg-accent/30"
        title={state.playing ? "Pause" : "Play"}
      >
        {state.playing ? <Pause size={13} /> : <Play size={13} />}
        <span className="tabular-nums">{state.playing ? "Pause" : "Play"}</span>
      </button>
      <button
        type="button"
        onClick={() => void transport.stopToStart()}
        className="flex h-7 w-7 items-center justify-center rounded-md text-danger/55 transition-colors hover:bg-danger/15 hover:text-danger"
        title="Stop (again at song start → project start)"
      >
        <Square size={13} />
      </button>
      <button
        type="button"
        onClick={() => transport.next()}
        className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/55 transition-colors hover:bg-default/25 hover:text-foreground"
        title="Next"
      >
        <SkipForward size={14} />
      </button>

      {/* Fixed song + BPM chip */}
      <div
        className="hidden h-7 w-36 shrink-0 flex-col justify-center border-l border-default/30 pl-2 sm:flex"
        title={state.songName || undefined}
      >
        <div className="truncate text-center text-[11px] font-medium leading-tight text-foreground/70">
          {state.songName || "—"}
        </div>
        <div className="text-center font-mono text-[10px] tabular-nums leading-tight text-foreground/40">
          {bpm > 0 ? `${bpm.toFixed(1)} BPM` : "—"}
        </div>
      </div>
    </div>
  );
}
