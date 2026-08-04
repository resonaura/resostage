import { useMemo } from "react";
import type { AllPeaksResponse, PeaksResponse, SongRow } from "../../lib/types";
import { songDurationSeconds } from "./rows";

/**
 * Per-song duration/offset in absolute project time. Uses allPeaks (every
 * song) when available, falling back to the fast single-song `peaks` fetch
 * for whichever song is currently staged so its segment doesn't wait on the
 * slower whole-project sweep.
 */
export function useSongLayout(
  songs: SongRow[],
  allPeaks: AllPeaksResponse | null,
  peaks: PeaksResponse | null,
  songIndex: number,
): { songLengths: number[]; songOffsets: number[]; totalLength: number } {
  return useMemo(() => {
    const lengths: number[] = [];
    const offsets: number[] = [];
    let acc = 0;
    if (songs.length === 0) {
      return { songLengths: [120], songOffsets: [0], totalLength: 120 };
    }
    for (let i = 0; i < songs.length; i++) {
      const fromAll = allPeaks?.songs[i]?.tracks;
      const fromCurrent = i === songIndex ? peaks?.tracks : undefined;
      // Use real authored duration for seek math. A fake 60s floor used to
      // skew songOffsets when peaks/regions weren't ready yet, so scrubbing
      // into song N landed at the wrong localSeconds.
      const len = Math.max(
        1,
        songDurationSeconds(songs[i], fromAll ?? fromCurrent),
      );
      lengths.push(len);
      offsets.push(acc);
      acc += len;
    }
    return {
      songLengths: lengths,
      songOffsets: offsets,
      // Exact project length -- a 120s floor used to leave a long empty
      // tail the user could scroll into past the last song.
      totalLength: Math.max(acc, 1),
    };
  }, [songs, allPeaks, peaks, songIndex]);
}
