import { useEffect, useRef, useState } from "react";
import {
  horizontalWindow,
  type WindowResult,
} from "../lib/horizontalWindow";

/**
 * Mount only the part of a fixed-pitch horizontal row that is near the
 * viewport, plus a generous margin either side.
 *
 * The console is the case this exists for: every strip carries two routing
 * selects, a send knob per aux bus and a fader, and a rig with dozens of
 * tracks pays for all of them on every tab switch even though six fit on
 * screen. Windowing turns that into a cost proportional to the window.
 *
 * Two things it deliberately does NOT do:
 *
 *   - It does not own the scroll container. The console scrolls per pane on a
 *     desktop and as one strip on a phone (see ConsolePane), so the hook finds
 *     whichever ancestor actually scrolls rather than requiring the caller to
 *     restructure around it.
 *   - It does not re-render per scroll event. State is written only when the
 *     mounted range actually changes, which with the overscan below means
 *     roughly once every few strips rather than once per frame of a drag.
 */
export function useHorizontalWindow({
  count,
  pitchPx,
  enabled = true,
}: {
  count: number;
  /** Item width INCLUDING the gap after it. Must be uniform. */
  pitchPx: number;
  /** Off = mount everything (a row too short to be worth the machinery). */
  enabled?: boolean;
}): {
  /** Put this on the element that directly contains the items. */
  contentRef: React.RefObject<HTMLDivElement | null>;
  window: WindowResult;
} {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState<WindowResult>(() => ({
    start: 0,
    end: count,
    padStartPx: 0,
    padEndPx: 0,
  }));

  // Read by the scroll handler without re-subscribing it on every render.
  const countRef = useRef(count);
  countRef.current = count;
  const pitchRef = useRef(pitchPx);
  pitchRef.current = pitchPx;
  const rangeRef = useRef(range);
  rangeRef.current = range;

  useEffect(() => {
    if (!enabled) {
      const all = {
        start: 0,
        end: countRef.current,
        padStartPx: 0,
        padEndPx: 0,
      };
      if (
        rangeRef.current.start !== all.start ||
        rangeRef.current.end !== all.end
      )
        setRange(all);
      return;
    }

    const content = contentRef.current;
    if (!content) return;

    const scroller = findScrollParent(content);

    const measure = () => {
      const el = contentRef.current;
      if (!el) return;
      const viewportPx = scroller
        ? scroller.clientWidth
        : window.innerWidth;
      const offsetPx = scroller
        ? el.getBoundingClientRect().left - scroller.getBoundingClientRect().left
        : el.getBoundingClientRect().left;

      const next = horizontalWindow({
        count: countRef.current,
        pitchPx: pitchRef.current,
        offsetPx,
        viewportPx,
        overscanPx: 0,
      });
      // The padding is a pure function of the indices, so comparing those two
      // is comparing the whole result -- and a scroll that has not crossed a
      // strip boundary must not cost a render.
      const cur = rangeRef.current;
      if (cur.start === next.start && cur.end === next.end) return;
      setRange(next);
    };

    measure();

    const target: EventTarget = scroller ?? window;
    target.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    // The pane resizes without scrolling when the window is resized, when the
    // sends pane grows, or when the compact/desktop layout flips.
    const ro = new ResizeObserver(measure);
    if (scroller) ro.observe(scroller);
    ro.observe(content);

    return () => {
      target.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [enabled, count, pitchPx]);

  return { contentRef, window: range };
}

/** Nearest ancestor that actually scrolls horizontally, or null for the page. */
function findScrollParent(from: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = from.parentElement;
  while (el) {
    const overflowX = getComputedStyle(el).overflowX;
    if (overflowX === "auto" || overflowX === "scroll") return el;
    el = el.parentElement;
  }
  return null;
}
