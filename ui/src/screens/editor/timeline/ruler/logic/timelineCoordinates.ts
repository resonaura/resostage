// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import type { SongRow } from "@/lib/state/types";
import { snapToGridSec } from "@/screens/editor/timeline/ruler/logic/geometry";

export interface TimelineSongPosition {
  songIndex: number;
  localSeconds: number;
}

/**
 * Maps an absolute (whole-timeline) second offset to whichever song segment
 * contains it, plus the position within that song.
 */
export function resolveTimelineSong(
  absSeconds: number,
  songs: readonly SongRow[],
  songOffsets: readonly number[],
  songLengths: readonly number[],
): TimelineSongPosition {
  for (let index = 0; index < songs.length; index++) {
    const start = songOffsets[index];
    const end = start + songLengths[index];
    if (absSeconds < end || index === songs.length - 1) {
      return {
        songIndex: index,
        localSeconds: Math.max(0, absSeconds - start),
      };
    }
  }
  return { songIndex: -1, localSeconds: 0 };
}

/**
 * Converts a client-space x coordinate to absolute project seconds. The body
 * element's rect already includes horizontal scrolling; do not add scrollLeft.
 */
export function timelineSecondsAtClientX(
  clientX: number,
  bodyLeft: number,
  pxPerSec: number,
): number {
  return Math.max(0, (clientX - bodyLeft) / pxPerSec);
}

/** Snap local song time using that song's own tempo and time signature. */
export function snapSongLocalSeconds(
  song: Pick<SongRow, "bpm" | "tsNum"> | undefined,
  localSeconds: number,
  pxPerSec: number,
  snapEnabled: boolean,
): number {
  if (!song) return localSeconds;
  return snapToGridSec(
    localSeconds,
    pxPerSec,
    song.bpm,
    song.tsNum ?? 4,
    snapEnabled,
  );
}
