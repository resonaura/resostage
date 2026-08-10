import type { SongRow } from "../../lib/types";

/**
 * Where a free drag is allowed to tick the trackpad.
 *
 * With the magnet on, every landing place is a detent and the tick follows the
 * snap -- nothing here is needed. With it off there is no landing place at
 * all: the value changes on every pixel, so ticking on change turns the Taptic
 * Engine into a buzzer for the length of the gesture, which is worse than no
 * haptics at all.
 *
 * What survives the magnet being off is the content: the edge of another
 * region, a section marker, a cycle locator, the end of the song. Those are
 * the positions you are actually aiming at when you turn snapping off to place
 * something by hand, so they are the ones worth feeling. The tick is not a
 * snap -- nothing moves, the drag stays exactly as free as it was; it only
 * tells the hand it just passed something.
 */

export interface CycleLocatorsForDetents {
  songIndex: number;
  leftSec: number;
  rightSec: number;
}

export interface SongDetentOptions {
  cycle?: CycleLocatorsForDetents | null;
  /** Song length in seconds -- the end of the song is a landmark too. */
  songLength?: number;
  /** The thing being dragged never ticks against itself. */
  excludeRegionId?: string;
  excludeSectionId?: string;
  /** Only regions on this track, when the drag is confined to one. */
  trackId?: string;
}

/**
 * Every landmark in a song, in seconds, sorted and de-duplicated.
 *
 * Built once per gesture -- a song can carry a few hundred of these, and
 * rebuilding the list on every pointermove would cost more than the drag.
 */
export function songDetents(
  song: SongRow | undefined,
  songIndex: number,
  opts: SongDetentOptions = {},
): number[] {
  if (!song) return [];
  const out: number[] = [0];

  if (opts.songLength && opts.songLength > 0) out.push(opts.songLength);

  for (const r of song.regions ?? []) {
    if (r.id === opts.excludeRegionId) continue;
    if (opts.trackId && r.trackId !== opts.trackId) continue;
    out.push(r.startSeconds);
    if (r.durationSeconds > 0) out.push(r.startSeconds + r.durationSeconds);
  }

  for (const s of song.sections ?? []) {
    if (s.id === opts.excludeSectionId) continue;
    out.push(s.startSeconds);
  }

  const cycle = opts.cycle;
  if (cycle && cycle.songIndex === songIndex) {
    out.push(cycle.leftSec, cycle.rightSec);
  }

  out.sort((a, b) => a - b);
  // Landmarks within a millisecond of each other are the same landmark as far
  // as a fingertip is concerned, and two ticks in one frame read as one loud
  // one.
  return out.filter((v, i) => i === 0 || v - out[i - 1] > 0.001);
}

/** Whether moving from `prev` to `next` passed (or landed on) a landmark. */
export function crossedDetent(
  prev: number,
  next: number,
  detents: readonly number[],
): boolean {
  if (prev === next || detents.length === 0) return false;
  const lo = Math.min(prev, next);
  const hi = Math.max(prev, next);
  for (const d of detents) {
    if (d > hi) break; // sorted
    // Half-open so a detent exactly under the pointer ticks once, on arrival,
    // and not again on the next move that leaves it.
    if (d > lo && d <= hi) return true;
  }
  return false;
}

/** Whether any of a set of moving edges crossed a landmark. */
export function edgesCrossedDetent(
  prev: readonly number[],
  next: readonly number[],
  detents: readonly number[],
): boolean {
  const n = Math.min(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    if (crossedDetent(prev[i], next[i], detents)) return true;
  }
  return false;
}
