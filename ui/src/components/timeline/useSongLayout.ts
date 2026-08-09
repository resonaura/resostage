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
  /**
   * A song length the user is currently dragging, applied on top of what the
   * engine has confirmed.
   *
   * The whole layout downstream of a resized song moves with it -- every later
   * song's offset, the content width, the playhead's absolute mapping -- so
   * waiting for the round trip would make the marker drag a scene that lags
   * behind the pointer. This is the same optimism useLiveValue gives a fader,
   * expressed where the value happens to be a layout input rather than a
   * control's own state.
   */
  endOverride?: { index: number; seconds: number } | null,
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
      const len =
        endOverride && endOverride.index === i
          ? Math.max(1, endOverride.seconds)
          : Math.max(1, songDurationSeconds(songs[i], fromAll ?? fromCurrent));
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
    // Keyed on the override's FIELDS, not the object: it is rebuilt on every
    // frame of a drag, so depending on the reference would recompute the whole
    // layout for every pointer event that did not actually move the boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    songs,
    allPeaks,
    peaks,
    songIndex,
    endOverride?.index,
    endOverride?.seconds,
  ]);
}
