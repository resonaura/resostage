/**
 * Whether a document-space x position sits inside the visible scroll
 * viewport, inset by `margin` on both edges. Pure so it's cheap to reason
 * about (and test) apart from the rAF loop that calls it -- see Timeline.tsx's
 * `notYetVisible` (reveals the playhead on first tick after a Timeline
 * mounts, e.g. right after switching to the Player/Editor tab) and any
 * future "is this on-screen" check the timeline needs.
 */
export function isPositionVisible(
  x: number,
  scrollLeft: number,
  viewportWidth: number,
  margin = 40,
): boolean {
  return x >= scrollLeft + margin && x <= scrollLeft + viewportWidth - margin;
}
