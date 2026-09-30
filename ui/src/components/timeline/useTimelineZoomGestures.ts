import { useEffect } from "react";

interface TimelineZoomGestureOptions {
  containerRef: { current: HTMLDivElement | null };
  pxPerSecRef: { current: number };
  applyZoomAtRef: { current: (nextPxPerSec: number, focusX: number) => void };
  markGestureActiveRef: { current: () => void };
  markZoomActiveRef: { current: () => void };
  endGestureRef: { current: () => void };
}

/** Attach non-passive wheel and trackpad-pinch zoom listeners to the timeline. */
export function useTimelineZoomGestures({
  containerRef,
  pxPerSecRef,
  applyZoomAtRef,
  markGestureActiveRef,
  markZoomActiveRef,
  endGestureRef,
}: TimelineZoomGestureOptions) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.style.touchAction = "none";
    el.style.overscrollBehavior = "contain";

    let lastScale = 1.0;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        markGestureActiveRef.current();
        markZoomActiveRef.current();

        const base = 2;
        const speed = event.deltaMode === 1 ? 0.14 : 0.0065;
        let factor = Math.pow(base, -event.deltaY * speed * 4);
        factor = Math.max(0.2, Math.min(5, factor));

        applyZoomAtRef.current(
          pxPerSecRef.current * factor,
          event.clientX,
        );
      }
    };

    const handleGestureStart = (event: any) => {
      event.preventDefault();
      event.stopPropagation();
      lastScale = 1.0;
      markGestureActiveRef.current();
      markZoomActiveRef.current();
    };

    const handleGestureChange = (event: any) => {
      event.preventDefault();
      event.stopPropagation();
      markGestureActiveRef.current();
      markZoomActiveRef.current();
      if (typeof event.scale === "number" && event.scale > 0) {
        const deltaScale = event.scale / lastScale;
        lastScale = event.scale;
        applyZoomAtRef.current(
          pxPerSecRef.current * deltaScale,
          event.clientX,
        );
      }
    };

    const handleGestureEnd = (event: any) => {
      event.preventDefault();
      event.stopPropagation();
      lastScale = 1.0;
      endGestureRef.current();
    };

    el.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturestart", handleGestureStart as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturechange", handleGestureChange as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gestureend", handleGestureEnd as any, {
      capture: true,
      passive: false,
    });

    return () => {
      el.removeEventListener("wheel", handleWheel, { capture: true });
      el.removeEventListener("gesturestart", handleGestureStart as any, {
        capture: true,
      });
      el.removeEventListener("gesturechange", handleGestureChange as any, {
        capture: true,
      });
      el.removeEventListener("gestureend", handleGestureEnd as any, {
        capture: true,
      });
    };
  }, [
    applyZoomAtRef,
    containerRef,
    endGestureRef,
    markGestureActiveRef,
    markZoomActiveRef,
    pxPerSecRef,
  ]);
}
