import {
  useCallback,
  useEffect,
  useState,
} from "react";
import { Timeline } from "../editor/timeline";
import { useSongLayout } from "../editor/timeline/layout/hooks/useSongLayout";
import { Card } from "../../components/ui";
import { transport } from "../../lib/state/api";
import { useContinuousPlayhead } from "../../lib/state/optimistic";
import {
  type AllPeaksResponse,
  type LightFixtureRow,
  type PeaksResponse,
  type WebUiState,
} from "../../lib/state/types";
import { useIsCompact } from "../../hooks/useMediaQuery";
import { CountInControl } from "../../transport/components/CountInControl";
import { SystemHealthWidget } from "./components/SystemHealthWidget";
import { BusMetersPanel } from "./components/BusMetersPanel";
import { SetlistPanel } from "./components/SetlistPanel";
import { DriftReadout } from "./components/DriftReadout";
import { PlayerLightStagePreview } from "./components/PlayerLightStagePreview";
import { PlayerClickControls } from "./components/PlayerClickControls";
import { PlayerTransportButtons } from "./components/PlayerTransportButtons";
import { PlayerClockReadout } from "./components/PlayerClockReadout";

/** Stable empty roster so a rig with no fixtures doesn't churn the memo. */
const EMPTY_FIXTURES: LightFixtureRow[] = [];


export function PlayerScreen({
  state,
  cpuHistory,
  ramHistory,
  peaks,
  allPeaks,
  pxPerSec,
  setPxPerSec,
}: {
  state: WebUiState;
  cpuHistory: number[];
  ramHistory: number[];
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
}) {
  const compact = useIsCompact();
  // Optimistic setlist highlight: flip immediately on click so hopscotch
  // never waits for the ~30 Hz WS round-trip / stageSong to paint.
  const [optimisticSongIndex, setOptimisticSongIndex] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (
      optimisticSongIndex != null &&
      state.songIndex === optimisticSongIndex
    ) {
      setOptimisticSongIndex(null);
    }
  }, [state.songIndex, optimisticSongIndex]);
  const displaySongIndex =
    optimisticSongIndex != null ? optimisticSongIndex : state.songIndex;
  // Stable identity so the memoized setlist isn't invalidated every frame by
  // a freshly-allocated click handler.
  const selectSong = useCallback((i: number) => {
    setOptimisticSongIndex(i);
    void transport.select(i);
  }, []);

  // ONE continuous absolute clock for transport. Song-local is derived from
  // the current song's offset so gapless boundaries don't reset a second clock.
  //
  // Deliberately NOT mirrored into React state (the trailing `false`): the
  // only things that read this clock are the four readouts below, and each
  // paints itself off the shared frame driver. Mirroring it re-rendered the
  // entire Player -- setlist, meter bay, light preview, transport -- sixty
  // times a second to move a handful of digits. Timeline already reads its
  // playhead this way; see useContinuousPlayhead's `publishToReact`.
  const [, , getLiveAbsolute] = useContinuousPlayhead(
    state.globalPlayheadSeconds,
    state.playing,
    state.projectName,
    false,
    undefined,
    undefined,
    false,
  );

  const song =
    state.songIndex >= 0 && state.songs[state.songIndex]
      ? state.songs[state.songIndex]
      : null;

  // The same layout the timeline lays out from, not a second opinion.
  //
  // This screen used to derive song length itself, from the longest region
  // DURATION -- which is not a length: it ignored where the region starts, so
  // anything not butted up against zero came out short, and it ignored
  // SongDef::endSeconds entirely, so a song stretched by hand still counted
  // to wherever its audio happened to stop. Two screens showing two different
  // ends of the same song, with the timeline's the correct one.
  const { songLengths, songOffsets } = useSongLayout(
    state.songs,
    allPeaks,
    peaks,
    state.songIndex,
  );
  const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
  const songOffset = songOffsets[songIdx] ?? 0;
  const songLength = state.songs.length > 0 ? (songLengths[songIdx] ?? 0) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto sm:gap-3 sm:overflow-visible">
      {/* ── 1. Top Transport bar ──────────────────────────────── */}
      {/* Stacks on phones: the desktop row is one ~900px-wide line of clock,
          title, transport and health graphs that cannot usefully shrink. */}
      <Card className="flex shrink-0 flex-col items-stretch gap-0 overflow-hidden sm:flex-row p-0">
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
              <strong key={state.recordingCountInBeatsRemaining} className="rs-count-in-beat text-2xl tabular-nums">
                {((Math.max(1, state.recordingCountInBeatsRemaining ?? 1) - 1) % Math.max(1, song?.tsNum ?? 4)) + 1}
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

      {/* ── 2. Middle: Setlist + Bus meters (flex layout, max 40% meters width) ─ */}
      <div className="flex shrink-0 flex-col gap-2 sm:h-52.5 sm:flex-row sm:gap-3">
        <SetlistPanel
          songs={state.songs}
          activeIndex={displaySongIndex}
          playing={state.playing}
          onSelect={selectSong}
        />

        <PlayerLightStagePreview
          fixtures={state.lighting?.fixtures ?? EMPTY_FIXTURES}
          enabled={Boolean(state.lighting?.enabled)}
        />

        <BusMetersPanel
          meters={state.meters}
          busses={state.busses}
          tracks={state.tracks}
          click={state.click}
        />
      </div>

      {/* ── 3. Bottom: Timeline (expands to fill remaining height) ──
          Deliberately NOT rendered on phones: a multi-song arrangement with
          per-region waveform canvases is neither usable at that width nor
          affordable on that hardware, and `display: none` would still build
          and animate all of it. */}
      {!compact && (
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <Timeline
            state={state}
            peaks={peaks}
            allPeaks={allPeaks}
            pxPerSec={pxPerSec}
            setPxPerSec={setPxPerSec}
            readOnly
          />
        </Card>
      )}
    </div>
  );
}
