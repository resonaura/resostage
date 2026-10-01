/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useRef, useState } from "react";
import { builder } from "@/lib/state/api";
import { useCoalescedCommit } from "@/lib/state/optimistic";
import type { SongEndDrag } from "@/screens/editor/timeline/ruler/components/SongEndMarker";

/** Owns the optimistic song-end drag and coalesces it into one undo action. */
export function useSongEndDrag() {
  // Held locally for the duration of the gesture and fed back into the layout
  // (see useSongLayout's endOverride), so the resized song and everything
  // after it move with the pointer instead of a round trip behind it. Writes
  // are coalesced to one a frame under a shared gesture id, which is also what
  // makes the whole drag a single undo entry.
  const [songEndDrag, setSongEndDrag] = useState<SongEndDrag | null>(null);
  const songEndGestureRef = useRef("");
  const [sendSongEnd] = useCoalescedCommit(
    ({ index, seconds }: SongEndDrag) =>
      void builder.songEnd(index, seconds, songEndGestureRef.current),
  );

  const handleSongEndDrag = useCallback(
    (drag: SongEndDrag) => {
      if (!songEndGestureRef.current)
        songEndGestureRef.current = `song_end_${drag.index}_${Date.now()}`;
      setSongEndDrag(drag);
      sendSongEnd(drag);
    },
    [sendSongEnd],
  );

  const handleSongEndCommit = useCallback(
    (drag: SongEndDrag | null) => {
      if (drag) sendSongEnd(drag);
      setSongEndDrag(null);
      // A fresh id next time, so the next drag is its own undo step.
      songEndGestureRef.current = "";
    },
    [sendSongEnd],
  );

  return { songEndDrag, handleSongEndDrag, handleSongEndCommit };
}
