export const LANE_HEIGHT = 56;

/** Lane height in CSS px for a given vertical zoom (shared by sidebar + lanes). */
export function laneHeightPx(verticalZoom: number): number {
  return Math.max(22, Math.round(LANE_HEIGHT * verticalZoom));
}

/**
 * Below this height waveforms are unreadable noise — render a solid color
 * strip with the track name instead (see Timeline region chrome).
 */
export const COMPACT_LANE_MAX_PX = 32;

export function isCompactLane(verticalZoom: number): boolean {
  return laneHeightPx(verticalZoom) <= COMPACT_LANE_MAX_PX;
}
