/**
 * Serialise a physical-output pick that is present in the mapping but no
 * longer reachable on the device. Used as an <option value> so the select
 * still shows exactly what the route targets, even though that output is gone
 * (rather than silently snapping to a different, available device output).
 */
export function missingRouteOptionId(
  startChannel: number,
  channels: number,
): string {
  return `u:${startChannel}:${channels}`;
}

/** Display label ("3/4" or "3") for a missing output pick. */
export function missingRouteLabel(
  startChannel: number,
  channels: number,
): string {
  if (channels >= 2) return `${startChannel + 1}/${startChannel + 2}`;
  return `${startChannel + 1}`;
}
