import type { ProjectCycleRow } from "../../../../lib/state/types";
import type { CycleWrapRange } from "../../../../lib/state/optimistic";

/** Convert the project's song-local loop locators to absolute playhead bounds. */
export function resolveCycleWrapRange(
  cycle: ProjectCycleRow | null | undefined,
  songOffsets: number[],
): CycleWrapRange | null {
  if (
    !cycle?.active ||
    cycle.skip ||
    typeof cycle.songIndex !== "number" ||
    cycle.songIndex < 0
  ) {
    return null;
  }

  const lo = Math.min(cycle.startSeconds, cycle.endSeconds);
  const hi = Math.max(cycle.startSeconds, cycle.endSeconds);
  if (!(hi - lo >= 0.05)) return null;

  const offset = songOffsets[cycle.songIndex] ?? 0;
  return { loAbs: offset + lo, hiAbs: offset + hi };
}
