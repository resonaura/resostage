/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

export interface CycleTimeRange {
  left: number;
  right: number;
}

/** Translate a seconds-backed cycle while preserving its span on the display axis. */
export function moveCycleRangeOnAxis({
  leftSeconds,
  rightSeconds,
  deltaCoordinate,
  songLengthSeconds,
  timeToCoordinate,
  coordinateToTime,
  snapTime,
}: {
  leftSeconds: number;
  rightSeconds: number;
  deltaCoordinate: number;
  songLengthSeconds: number;
  timeToCoordinate: (seconds: number) => number;
  coordinateToTime: (coordinate: number) => number;
  snapTime?: (seconds: number) => number;
}): CycleTimeRange {
  const originLeft = Math.min(leftSeconds, rightSeconds);
  const originRight = Math.max(leftSeconds, rightSeconds);
  const originLeftCoordinate = timeToCoordinate(originLeft);
  const originRightCoordinate = timeToCoordinate(originRight);
  const span = originRightCoordinate - originLeftCoordinate;
  const songEnd = timeToCoordinate(songLengthSeconds);
  if (![originLeftCoordinate, originRightCoordinate, span, songEnd, deltaCoordinate]
    .every(Number.isFinite) || span < 0 || songEnd < 0) {
    return { left: originLeft, right: originRight };
  }

  let leftCoordinate = originLeftCoordinate + deltaCoordinate;
  if (snapTime) leftCoordinate = timeToCoordinate(snapTime(coordinateToTime(leftCoordinate)));
  let rightCoordinate = leftCoordinate + span;
  if (leftCoordinate < 0) {
    leftCoordinate = 0;
    rightCoordinate = span;
  }
  if (rightCoordinate > songEnd) {
    rightCoordinate = songEnd;
    leftCoordinate = Math.max(0, songEnd - span);
  }
  return {
    left: coordinateToTime(leftCoordinate),
    right: coordinateToTime(rightCoordinate),
  };
}
