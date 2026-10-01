// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

export interface TapTempoResult {
  times: number[];
  /** Undefined means the tap did not produce a new tempo yet. */
  bpm?: number;
}

/**
 * Adds a tap to a short recent window and derives tempo from its median beat.
 * The median limits the effect of one imprecise tap; stale runs and implausible
 * intervals are ignored rather than producing extreme project tempos.
 */
export function recordTempoTap(previousTimes: number[], now: number): TapTempoResult {
  const lastTime = previousTimes.at(-1);
  const recentTimes =
    lastTime !== undefined && now - lastTime > 2000 ? [] : previousTimes;
  const times = [...recentTimes, now].slice(-6);
  if (times.length < 2) return { times };

  const intervals = times
    .slice(1)
    .map((time, index) => time - times[index])
    .filter((interval) => interval >= 150 && interval <= 3000)
    .sort((a, b) => a - b);
  if (intervals.length === 0) return { times };

  const middle = Math.floor(intervals.length / 2);
  const median =
    intervals.length % 2 === 0
      ? (intervals[middle - 1] + intervals[middle]) / 2
      : intervals[middle];
  const bpm = Math.round(Math.max(20, Math.min(400, 60_000 / median)) * 10) / 10;
  return { times, bpm };
}
