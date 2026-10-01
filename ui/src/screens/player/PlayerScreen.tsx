// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import {
  useCallback,
  useEffect,
  useState,
} from "react";
import { Timeline } from "@/screens/editor/timeline";
import { useSongLayout } from "@/screens/editor/timeline/layout/hooks/useSongLayout";
import { Card } from "@/components/ui";
import { transport } from "@/lib/state/api";
import { useContinuousPlayhead } from "@/lib/state/optimistic";
import {
  type AllPeaksResponse,
  type LightFixtureRow,
  type PeaksResponse,
  type WebUiState,
} from "@/lib/state/types";
import { useIsCompact } from "@/hooks/useMediaQuery";
import { BusMetersPanel } from "@/screens/player/components/BusMetersPanel";
import { SetlistPanel } from "@/screens/player/components/SetlistPanel";
import { PlayerLightStagePreview } from "@/screens/player/components/PlayerLightStagePreview";
import { PlayerTransportHeader } from "@/screens/player/components/PlayerTransportHeader";

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
      <PlayerTransportHeader
        state={state}
        song={song}
        songLength={songLength}
        songOffset={songOffset}
        getLiveAbsolute={getLiveAbsolute}
        cpuHistory={cpuHistory}
        ramHistory={ramHistory}
      />

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
