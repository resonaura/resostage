/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Separator, Toolbar, Tooltip } from "@heroui/react";
import {
  Circle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react";
import { useEffect, useState } from "react";
import { FontIcon } from "@/components/common/FontIcon";
import { patchClickFields } from "@/screens/mixer/logic/mixerUtils";
import { transport } from "@/lib/state/api";
import { useContinuousPlayhead } from "@/lib/state/optimistic";
import type { WebUiState } from "@/lib/state/types";
import { TimeDisplay } from "@/components/daw";
import { CountInControl } from "@/transport/components/CountInControl";
import { SongTempoControl } from "@/transport/components/SongTempoControl";
import { ToggleButton, ToggleButtonGroup } from "@/components/ui";

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
      <SongTempoControl
        state={state}
        song={song}
        songTitle={songTitle}
        bpm={bpm}
        tsNum={tsNum}
        tsDen={tsDen}
      />
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
