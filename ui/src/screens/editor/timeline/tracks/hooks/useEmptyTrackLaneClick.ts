// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useCallback, type MouseEvent } from "react";
import { builder } from "@/lib/state/api";
import type { SongRow, TrackRow } from "@/lib/state/types";
import type { TimelineRow } from "@/screens/editor/timeline/layout/logic/rows";
import { midiRegionPlacementAt } from "@/screens/editor/timeline/regions/logic/midiRegionPlacement";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";

interface EmptyTrackLaneClickOptions {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  snapToGrid: boolean;
  readOnly: boolean;
  tool: TimelineTool;
  openTrackAudioImport: (songIndex: number, trackIndex: number) => void;
}

/** Handles Pencil-click creation/import on otherwise empty track-lane space. */
export function useEmptyTrackLaneClick({
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  snapToGrid,
  readOnly,
  tool,
  openTrackAudioImport,
}: EmptyTrackLaneClickOptions) {
  return useCallback(
    (
      event: MouseEvent<HTMLDivElement>,
      row: TimelineRow,
      track: TrackRow | undefined,
      trackIndex: number,
    ) => {
      if (readOnly || tool !== "pencil") return;
      // Empty lane only. Stopping the region's POINTERDOWN does not stop its
      // click, so a pencil click on an existing region used to bubble here and
      // open the file picker -- the pencil's one job, offered in the one place
      // it makes no sense.
      if ((event.target as HTMLElement).closest?.("[data-region-block]")) return;

      // No scrollLeft term: this lane IS the full-width content element, so
      // its bounding rect has already moved left by the scroll and `clientX -
      // rect.left` is content space. Adding the scroll offset double-counted it
      // and picked the wrong song once the timeline was scrolled past the first
      // one -- which also made this the only place in the tree that needed a
      // pixel-exact scroll position (see layout/logic/scrollWindow.ts).
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;

      // Find the song under the click.
      let songIndex = 0;
      for (let i = 0; i < songOffsets.length; i++) {
        const start = songOffsets[i] * pxPerSec;
        const end = start + songLengths[i] * pxPerSec;
        if (x >= start && x < end) {
          songIndex = i;
          break;
        }
        if (i === songOffsets.length - 1) songIndex = i;
      }

      if (trackIndex < 0) return;
      const clickedSong = songs[songIndex];
      const trackKind = track?.kind ?? "audio";
      const acceptsMidi =
        trackKind === "instrument" ||
        trackKind === "midi" ||
        trackKind === "externalMidi";

      if (acceptsMidi && track) {
        const localSeconds = Math.max(
          0,
          x / pxPerSec - (songOffsets[songIndex] ?? 0),
        );
        const placement = midiRegionPlacementAt(
          localSeconds,
          songLengths[songIndex] ?? 0,
          clickedSong?.bpm ?? 120,
          clickedSong?.tsNum ?? 4,
          pxPerSec,
          snapToGrid,
        );
        void builder.midiRegionAdd({
          songIndex,
          trackId: track.id,
          name: "MIDI Region",
          startBeats: placement.startBeats,
          durationBeats: placement.durationBeats,
          loop: false,
          loopLengthBeats: placement.durationBeats,
          color: row.color,
        });
        return;
      }

      if (trackKind === "audio")
        openTrackAudioImport(songIndex, trackIndex);
    },
    [
      openTrackAudioImport,
      pxPerSec,
      readOnly,
      snapToGrid,
      songLengths,
      songOffsets,
      songs,
      tool,
    ],
  );
}
