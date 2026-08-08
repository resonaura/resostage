import { Button } from "@heroui/react";
import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { transport } from "../lib/api";
import type { WebUiState } from "../lib/types";
import { IconButton, TimeDisplay } from "./daw";

/**
 * Compact transport for the app header (non-Player tabs): clock chip, song +
 * BPM, transport buttons. Parent owns center placement + show/hide fade.
 *
 * The clock and the icon buttons are DAW primitives now (see components/daw)
 * — this file is arrangement only.
 */
export function GlobalTransportBar({ state }: { state: WebUiState }) {
  const song =
    state.songIndex >= 0 && state.songs[state.songIndex]
      ? state.songs[state.songIndex]
      : null;
  const bpm = song && song.bpm > 0 ? song.bpm : 0;
  const tsNum = song && song.tsNum > 0 ? song.tsNum : 4;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-default/40 bg-default/10 px-1.5">
      <TimeDisplay
        seconds={state.playheadSeconds}
        bpm={bpm}
        tsNum={tsNum}
        playing={state.playing}
        hasSong={song !== null}
      />

      <IconButton onClick={() => transport.prev()} ariaLabel="Previous">
        <SkipBack size={14} />
      </IconButton>

      {/* Play/pause is the one wide button: it is the control you hit without
          looking, so it gets a target the others do not. */}
      <Button
        size="sm"
        variant="secondary"
        onPress={() => (state.playing ? transport.stop() : transport.play())}
        aria-label={state.playing ? "Pause" : "Play"}
        className="w-[4.75rem] font-semibold"
      >
        {state.playing ? <Pause size={13} /> : <Play size={13} />}
        <span className="tabular-nums">{state.playing ? "Pause" : "Play"}</span>
      </Button>

      <IconButton
        onClick={() => void transport.stopToStart()}
        danger
        ariaLabel="Stop (again at song start → project start)"
      >
        <Square size={13} />
      </IconButton>
      <IconButton onClick={() => transport.next()} ariaLabel="Next">
        <SkipForward size={14} />
      </IconButton>

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
