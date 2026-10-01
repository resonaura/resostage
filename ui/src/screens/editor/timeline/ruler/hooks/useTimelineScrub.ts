// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useRef } from "react";
import { beginCancellableDrag, type CancellableDrag } from "@/lib/interaction/dragCancel";
import { transport } from "@/lib/state/api";
import type { SongRow } from "@/lib/state/types";
import { isPositionVisible } from "@/screens/editor/timeline/logic/timelineVisibility";
import {
  resolveTimelineSong,
  snapSongLocalSeconds,
  timelineSecondsAtClientX,
} from "@/screens/editor/timeline/ruler/logic/timelineCoordinates";

interface TimelineScrubOptions {
  hasSongs: boolean;
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSecRef: { current: number };
  snapToGrid: boolean;
  bodyRef: { current: HTMLDivElement | null };
  scrollRef: { current: HTMLDivElement | null };
  draggingRef: { current: boolean };
  livePlayheadRef: { current: () => number };
  setPlayheadAbsoluteSec: (seconds: number, lockMs?: number) => void;
  catchFollowOnSeek: () => void;
}

/**
 * Ruler / playhead-handle scrub. Mid-drag only moves the optimistic needle;
 * commit seeks the engine. Edge auto-scroll lives in the rAF loop
 * (`draggingRef.current`) so scrubbing past the viewport pans the timeline
 * like a DAW.
 */
export function useTimelineScrub({
  hasSongs,
  songs,
  songOffsets,
  songLengths,
  pxPerSecRef,
  snapToGrid,
  bodyRef,
  scrollRef,
  draggingRef,
  livePlayheadRef,
  setPlayheadAbsoluteSec,
  catchFollowOnSeek,
}: TimelineScrubOptions) {
  const scrubCancelRef = useRef<CancellableDrag | null>(null);
  const scrubOriginRef = useRef<number | null>(null);

  const seekFromClientX = (clientX: number, commit = false) => {
    const bodyEl = bodyRef.current;
    if (!bodyEl || songs.length === 0) return;
    // bodyRef is the full-width content inside the scroller -- its
    // getBoundingClientRect().left already shifts with scrollLeft. Adding
    // scrollLeft again double-counted and scrub landed far from the cursor.
    const rect = bodyEl.getBoundingClientRect();
    const absSeconds = timelineSecondsAtClientX(
      clientX,
      rect.left,
      pxPerSecRef.current,
    );
    const { songIndex, localSeconds } = resolveTimelineSong(
      absSeconds,
      songs,
      songOffsets,
      songLengths,
    );
    if (songIndex < 0) return;

    const targetSong = songs[songIndex] ?? { bpm: 120, tsNum: 4 };
    const snappedLocal = snapSongLocalSeconds(
      targetSong,
      localSeconds,
      pxPerSecRef.current,
      snapToGrid,
    );

    // Clamp into the resolved song's authored length so we never seek past EOF.
    const songLen = songLengths[songIndex] ?? 0;
    const songStart = songOffsets[songIndex] ?? 0;
    const clampedLocal =
      songLen > 0
        ? Math.min(snappedLocal, Math.max(0, songLen - 0.01))
        : snappedLocal;
    const clampedAbs = songStart + clampedLocal;

    // Optimistic absolute needle moves immediately (one continuous timeline).
    // The commit lock only needs to bridge a real seek + one WS telemetry
    // turn now that useContinuousPlayhead no longer has a proximity-based
    // early release to race against -- see optimistic.ts's draggingRef doc.
    setPlayheadAbsoluteSec(clampedAbs, commit ? 800 : undefined);
    // Re-enable follow only when the seek lands *outside* the viewport.
    // Clicking/scrubbing within the already-visible range must not pan.
    if (commit) {
      const scroller = scrollRef.current;
      if (scroller) {
        const px = clampedAbs * pxPerSecRef.current;
        if (
          !isPositionVisible(px, scroller.scrollLeft, scroller.clientWidth || 0)
        ) {
          catchFollowOnSeek();
        }
      }
    }

    // Engine seeks only on commit (pointer up). Mid-drag same-song seeks used
    // to restage every 60ms and produced the "chirp then stop then play" glitch.
    if (!commit) return;

    void transport.seek(clampedLocal, songIndex);
  };

  /**
   * Seek to an absolute project position that is already known -- no cursor,
   * no snapping. Used to undo a scrub, where the target is a position the
   * playhead genuinely held, so re-snapping it would move it.
   */
  const seekToAbsolute = (absSeconds: number) => {
    const clampedAbs = Math.max(0, absSeconds);
    const { songIndex, localSeconds } = resolveTimelineSong(
      clampedAbs,
      songs,
      songOffsets,
      songLengths,
    );
    if (songIndex < 0) return;
    setPlayheadAbsoluteSec(clampedAbs, 800);
    void transport.seek(localSeconds, songIndex);
  };

  // Esc mid-scrub: back to wherever the playhead was when the drag started,
  // and seek the engine there. A scrub only moves the optimistic needle until
  // pointerup, so the engine is usually still on the original position -- but
  // not always (crossing into another song commits), and re-seeking costs
  // nothing next to leaving the two disagreeing.
  const cancelScrub = () => {
    const origin = scrubOriginRef.current;
    scrubOriginRef.current = null;
    draggingRef.current = false;
    scrubCancelRef.current?.end();
    scrubCancelRef.current = null;
    if (origin == null) return;
    seekToAbsolute(origin);
  };

  const disarmScrub = () => {
    scrubOriginRef.current = null;
    scrubCancelRef.current?.end();
    scrubCancelRef.current = null;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (!hasSongs) return;
    draggingRef.current = true;
    // Captured BEFORE the first seekFromClientX -- pointerdown already jumps
    // the needle, so reading it afterwards would record the click position.
    scrubOriginRef.current = livePlayheadRef.current();
    scrubCancelRef.current?.end();
    scrubCancelRef.current = beginCancellableDrag(cancelScrub);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekFromClientX(event.clientX, false);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!draggingRef.current) return;
    if (event.buttons === 0) {
      draggingRef.current = false;
      disarmScrub();
      seekFromClientX(event.clientX, true);
      return;
    }
    seekFromClientX(event.clientX, false);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    disarmScrub();
    seekFromClientX(event.clientX, true);
  };

  const onPointerCancelOrLost = (event: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    disarmScrub();
    seekFromClientX(event.clientX, true);
  };

  return {
    seekFromClientX,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancelOrLost,
  };
}
