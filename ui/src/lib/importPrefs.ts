/**
 * What to do when imported audio does not fit the song it lands in.
 *
 * Only a song with an AUTHORED end can be overrun: a song whose length is
 * derived from its content simply grows, which is already the right answer and
 * needs no question. So this is specifically about the case where the user has
 * said how long the song is and the file disagrees -- and there is no default
 * that is right for everyone there. Trimming is right when the song length is
 * the arrangement and the file has a long tail; extending is right when the
 * file IS the arrangement and the end marker was a guess.
 */

export type LongImportChoice = "trim" | "extend";
/** `ask` is the shipped default: neither answer is safe to assume. */
export type LongImportPreference = LongImportChoice | "ask";

const STORAGE_KEY = "resostage.import.longRegion";

export function readLongImportPreference(): LongImportPreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "trim" || v === "extend" || v === "ask") return v;
  } catch {
    /* private mode */
  }
  return "ask";
}

export function writeLongImportPreference(v: LongImportPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* best-effort */
  }
}

export interface LongImportCase {
  songIndex: number;
  regionId: string;
  /** Where the region would end, in song-local seconds. */
  regionEndSeconds: number;
  /** The song's authored end, in seconds. */
  songEndSeconds: number;
}

/**
 * Whether an imported region overruns its song, and by enough to matter.
 *
 * The tolerance is there because an import that lands a few milliseconds past
 * an end marker is a rounding difference, not a decision worth interrupting
 * anyone for.
 */
export const OVERRUN_TOLERANCE_SECONDS = 0.05;

export function overrunsSong(
  regionEndSeconds: number,
  songEndSeconds: number,
): boolean {
  if (!(songEndSeconds > 0)) return false; // derived length: it just grows
  return regionEndSeconds > songEndSeconds + OVERRUN_TOLERANCE_SECONDS;
}
