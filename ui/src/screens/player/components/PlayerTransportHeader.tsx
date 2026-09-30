import { Card } from "../../../components/ui";
import { CountInControl } from "../../../transport/components/CountInControl";
import type { WebUiState } from "../../../lib/state/types";
import { DriftReadout } from "./DriftReadout";
import { PlayerClickControls } from "./PlayerClickControls";
import { PlayerClockReadout } from "./PlayerClockReadout";
import { PlayerTransportButtons } from "./PlayerTransportButtons";
import { SystemHealthWidget } from "./SystemHealthWidget";

type PlayerSong = WebUiState["songs"][number] | null;

/** The Player screen's clock, song summary, transport, count-in, and health header. */
export function PlayerTransportHeader({
  state,
  song,
  songLength,
  songOffset,
  getLiveAbsolute,
  cpuHistory,
  ramHistory,
}: {
  state: WebUiState;
  song: PlayerSong;
  songLength: number;
  songOffset: number;
  getLiveAbsolute: () => number;
  cpuHistory: number[];
  ramHistory: number[];
}) {
  return (
    <>
      {/* Stacks on phones: the desktop row is one ~900px-wide line of clock,
          title, transport and health graphs that cannot usefully shrink. */}
      <Card className="flex shrink-0 flex-col items-stretch gap-0 overflow-hidden p-0 sm:flex-row">
        {/* Clock + bar/beat + abs (full info — header has compact clock) */}
        <PlayerClockReadout
          playing={state.playing}
          song={song}
          songLength={songLength}
          songOffset={songOffset}
          globalBeatsElapsed={state.globalBeatsElapsed}
          globalPlayheadSeconds={state.globalPlayheadSeconds}
          getLiveAbsolute={getLiveAbsolute}
        />

        {/* Song metadata — flex-1 so the card fills evenly (clock + transport
            + health stay fixed; title/BPM claim the leftover width). */}
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center border-b border-default/30 px-4 py-2 text-center sm:border-b-0 sm:border-r sm:py-2.5">
          <div className="w-full max-w-full truncate text-sm font-semibold">
            {state.songName || "No song selected"}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[11px] text-foreground/40">
            {song && song.bpm > 0 ? (
              <>
                <span className="font-mono tabular-nums text-accent">
                  {song.bpm.toFixed(1)} BPM
                </span>
                <span>
                  {song.tsNum}/{song.tsDen}
                </span>
                <span>{state.tracks.length} tracks</span>
              </>
            ) : (
              <span>Select a song to begin</span>
            )}
            <DriftReadout drift={state.drift} />
          </div>
        </div>

        {/* Transport control buttons */}
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-3 py-2.5">
          <PlayerTransportButtons
            playing={state.playing}
            recording={state.recording}
          />

          <PlayerClickControls state={state} />
          <CountInControl state={state} />
          {state.recordingCountIn && (
            <span
              role="status"
              aria-live="polite"
              aria-label={`Count-in: ${state.recordingCountInBeatsRemaining ?? 0} beats remaining`}
              className="flex h-9 min-w-10 items-center justify-center rounded-md bg-(--rs-record)/15 px-2 font-mono text-(--rs-record)"
            >
              <strong
                key={state.recordingCountInBeatsRemaining}
                className="rs-count-in-beat text-2xl tabular-nums"
              >
                {((Math.max(1, state.recordingCountInBeatsRemaining ?? 1) - 1) %
                  Math.max(1, song?.tsNum ?? 4)) +
                  1}
              </strong>
            </span>
          )}
        </div>

        {/* Dual sparkline graphs: CPU & RAM */}
        <SystemHealthWidget
          health={state.health}
          playing={state.playing}
          cpuHistory={cpuHistory}
          ramHistory={ramHistory}
        />
      </Card>
    </>
  );
}
