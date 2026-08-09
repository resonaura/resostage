/**
 * Which items of a fixed-pitch horizontal row are worth mounting.
 *
 * Kept apart from the hook that uses it because this is the part with the
 * off-by-one risk, and it is pure arithmetic -- see horizontalWindow.test.ts.
 */

export interface WindowInput {
  /** How many items the row holds in total. */
  count: number;
  /** Width of one item INCLUDING the gap after it, in CSS px. */
  pitchPx: number;
  /**
   * How far the row's left edge sits from the viewport's left edge, in CSS px.
   * Negative once the row has been scrolled into.
   */
  offsetPx: number;
  /** Visible width of the scroll viewport, in CSS px. */
  viewportPx: number;
  /**
   * Extra px to mount either side of the viewport.
   *
   * This is the whole reason the row does not visibly pop: an item that is
   * about to be scrolled to is already mounted and painted, so it slides in
   * finished rather than appearing a frame late. Cheap to be generous with --
   * see MIN_OVERSCAN_PX.
   */
  overscanPx: number;
}

export interface WindowResult {
  /** First index to mount, inclusive. */
  start: number;
  /** Last index to mount, exclusive. */
  end: number;
  /** Width of the spacer standing in for the items before `start`. */
  padStartPx: number;
  /** Width of the spacer standing in for the items after `end`. */
  padEndPx: number;
}

/**
 * Never mount less than this beyond the viewport, and never less than one
 * viewport's worth either side (see below). A console strip is ~100px, so this
 * is roughly six strips -- more than a flick of the trackpad covers in the
 * frame it takes to notice the scroll and re-window.
 */
export const MIN_OVERSCAN_PX = 600;

export function horizontalWindow({
  count,
  pitchPx,
  offsetPx,
  viewportPx,
  overscanPx,
}: WindowInput): WindowResult {
  if (count <= 0 || pitchPx <= 0) {
    return { start: 0, end: 0, padStartPx: 0, padEndPx: 0 };
  }

  // A viewport we have not measured yet (0 on the first render, before layout)
  // must not be read as "nothing is visible" -- that would mount an empty row
  // and then pop every strip in at once on the next frame. Mount everything
  // until there is a real measurement.
  if (viewportPx <= 0) {
    return { start: 0, end: count, padStartPx: 0, padEndPx: 0 };
  }

  // One full viewport either side, at minimum: that is what makes a fast
  // fling arrive at already-painted content rather than at spacers.
  const overscan = Math.max(overscanPx, viewportPx, MIN_OVERSCAN_PX);

  const firstVisiblePx = -offsetPx - overscan;
  const lastVisiblePx = -offsetPx + viewportPx + overscan;

  const start = Math.max(0, Math.floor(firstVisiblePx / pitchPx));
  const end = Math.min(count, Math.max(start, Math.ceil(lastVisiblePx / pitchPx)));

  return {
    start,
    end,
    padStartPx: start * pitchPx,
    padEndPx: (count - end) * pitchPx,
  };
}
