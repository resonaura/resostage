/**
 * The coarse scroll window the timeline's React tree renders against.
 *
 * The scroller moves every frame while the transport follows the playhead,
 * and its position used to reach React within 8 pixels of the truth. Nothing
 * in the tree wanted that precision:
 *
 *  - BeatGrid and Ruler both floor scrollLeft to 250px themselves and paint a
 *    canvas 500px wider than the viewport, precisely so that they can sit
 *    still through a quarter-screen of scrolling. Every commit finer than
 *    that recomputed their props, re-ran their layout effects and rasterized
 *    the same pixels again.
 *  - the lane components cull whole song segments, which either overlap the
 *    viewport or do not; a couple of hundred pixels of error only decides
 *    whether an off-screen segment stays mounted a moment longer.
 *
 * So the window is quantized here instead, once, at the point where the
 * scroller's position enters React. Scrolling a screen now costs a handful of
 * commits rather than a hundred and fifty, and the playhead is unaffected:
 * it never went through React state at all -- it is written straight to the
 * DOM from the rAF loop.
 */

/**
 * Quantization step. Deliberately the same 250px BeatGrid and Ruler already
 * use: pick anything else and the two would drift in and out of phase, and a
 * commit that lands mid-step would repaint a canvas that had not moved.
 */
export const SCROLL_QUANTUM_PX = 250;

export interface ScrollWindow {
  scrollLeft: number;
  viewportWidth: number;
}

/**
 * Snap a live scroll position to the rendering window that contains it.
 *
 * `scrollLeft` floors, so the window's left edge is never to the right of the
 * real one. That alone would let the right edge fall short by up to a step,
 * culling something that is genuinely on screen -- hence the viewport is
 * widened by two steps, one to cover the floor and one of plain overscan.
 */
export function quantizeScrollWindow(
  scrollLeft: number,
  viewportWidth: number,
): ScrollWindow {
  const left = Math.max(
    0,
    Math.floor((scrollLeft || 0) / SCROLL_QUANTUM_PX) * SCROLL_QUANTUM_PX,
  );
  return {
    scrollLeft: left,
    viewportWidth: Math.max(0, viewportWidth) + SCROLL_QUANTUM_PX * 2,
  };
}

/** Whether two windows would render identically -- i.e. whether to commit. */
export function sameScrollWindow(a: ScrollWindow, b: ScrollWindow): boolean {
  return a.scrollLeft === b.scrollLeft && a.viewportWidth === b.viewportWidth;
}
