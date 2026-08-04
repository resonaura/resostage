import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { transport } from "../lib/api";
import type { WebUiState } from "../lib/types";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * 10);
  return `${m}:${s < 10 ? "0" : ""}${s}.${f}`;
}

/**
 * Compact transport strip for every tab except Player (Player has its own
 * full transport + metronome + clock). Shown in the app header so Mixer /
 * Editor / Light / Settings can control playback without duplicating the
 * main transport bar.
 */
export function GlobalTransportBar({ state }: { state: WebUiState }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-default/40 bg-default/10 px-1.5 py-0.5">
      <span
        className={`min-w-[4.5rem] px-1.5 font-mono text-xs tabular-nums ${
          state.playing ? "text-success" : "text-foreground/60"
        }`}
        title="Song playhead"
      >
        {formatTime(state.playheadSeconds)}
      </span>
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
        className="flex h-7 items-center gap-1 rounded-md bg-accent/20 px-2.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/30"
        title={state.playing ? "Pause" : "Play"}
      >
        {state.playing ? <Pause size={13} /> : <Play size={13} />}
        <span className="hidden sm:inline">
          {state.playing ? "Pause" : "Play"}
        </span>
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
      {state.songName ? (
        <span
          className="hidden max-w-[10rem] truncate border-l border-default/30 pl-2 text-[11px] text-foreground/45 md:inline"
          title={state.songName}
        >
          {state.songName}
        </span>
      ) : null}
    </div>
  );
}
