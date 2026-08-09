import { Separator, Toolbar } from "@heroui/react";
import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { transport } from "../lib/api";
import type { WebUiState } from "../lib/types";
import { TimeDisplay } from "./daw";
import { ToggleButton, ToggleButtonGroup } from "./ui";

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
    <Toolbar
      aria-label="Transport controls"
      className="h-9 flex items-center bg-transparent"
    >
      <TimeDisplay
        seconds={state.playheadSeconds}
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
          variant={state.playing ? "success-soft" : "accent-soft"}
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
