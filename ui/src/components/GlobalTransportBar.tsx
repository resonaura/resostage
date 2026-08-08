import { Button, ButtonGroup, Separator, Toolbar } from "@heroui/react";
import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { transport } from "../lib/api";
import type { WebUiState } from "../lib/types";
import { TimeDisplay } from "./daw";

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
    <Toolbar isAttached aria-label="Transport controls" className="h-9">
      <TimeDisplay
        seconds={state.playheadSeconds}
        bpm={bpm}
        tsNum={tsNum}
        playing={state.playing}
        hasSong={song !== null}
      />
      <Separator orientation="vertical" />
      <ButtonGroup size="sm" variant="tertiary">
        <Button
          isIconOnly
          onPress={() => transport.prev()}
          aria-label="Previous"
        >
          <SkipBack size={14} />
        </Button>
        {/* Play/pause is the one wide button: it is the control you hit without
            looking, so it gets a target the others do not. */}
        <Button
          onPress={() => (state.playing ? transport.stop() : transport.play())}
          aria-label={state.playing ? "Pause" : "Play"}
          className="w-[4.75rem] font-semibold"
        >
          <ButtonGroup.Separator />
          {state.playing ? <Pause size={13} /> : <Play size={13} />}
          <span className="tabular-nums">
            {state.playing ? "Pause" : "Play"}
          </span>
        </Button>
        <Button
          isIconOnly
          onPress={() => void transport.stopToStart()}
          aria-label="Stop (again at song start → project start)"
          className="text-danger"
        >
          <ButtonGroup.Separator />
          <Square size={13} />
        </Button>
        <Button isIconOnly onPress={() => transport.next()} aria-label="Next">
          <ButtonGroup.Separator />
          <SkipForward size={14} />
        </Button>
      </ButtonGroup>
      <Separator orientation="vertical" />
      {/* Fixed song + BPM chip */}
      <div
        className="hidden h-7 w-36 shrink-0 flex-col justify-center pl-2 sm:flex"
        title={state.songName || undefined}
      >
        <div className="truncate text-center text-[11px] font-medium leading-tight text-foreground/70">
          {state.songName || "—"}
        </div>
        <div className="text-center font-mono text-[10px] tabular-nums leading-tight text-foreground/40">
          {bpm > 0 ? `${bpm.toFixed(1)} BPM` : "—"}
        </div>
      </div>
    </Toolbar>
  );
}
