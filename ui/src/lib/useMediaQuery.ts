import { useEffect, useState } from "react";

/**
 * Viewport queries, as a hook.
 *
 * Most responsive work in this app is plain CSS (Tailwind breakpoints), which
 * is always preferable: it costs nothing and it reflows without React. This
 * exists for the cases CSS cannot express -- deciding not to MOUNT something
 * at all. Hiding the arrangement view with `display: none` on a phone would
 * still build every lane, every region and every waveform canvas, run its
 * frame loop, and hold the peaks in memory, on the device least able to afford
 * any of it. `useIsCompact()` lets that subtree simply not exist.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * Phone-sized (and small tablets in portrait).
 *
 * The threshold is where the desktop layout stops being merely cramped and
 * starts being unusable: the transport bar's clock, song title, buttons and
 * health graphs are a single non-wrapping row about 900px wide.
 */
export function useIsCompact(): boolean {
  return useMediaQuery("(max-width: 899px)");
}

/** True on touch-primary devices -- no hover, coarse hit targets. */
export function useIsTouch(): boolean {
  return useMediaQuery("(pointer: coarse)");
}
