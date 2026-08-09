import { useCallback, useEffect, useRef, useState } from "react";
import { addRafTask } from "../lib/rafLoop";

const FLOOR_DB = -100;
/** Anything above this is treated as a metering glitch, not a real clip. */
const SANE_PEAK_DB = 24;
/** Don't re-render for a held peak creeping up by less than this. */
const HELD_PEAK_EPSILON_DB = 0.1;

/**
 * Clip latch shared by everything on one strip -- the meter bars and the dB
 * box next to them light up and clear together.
 *
 * This used to take the peak as a PROP, which meant the strip had to re-render
 * on every telemetry frame for the latch to see the signal at all -- and the
 * strip is the expensive thing on the mixer (routing selects, send knobs,
 * fader), all of it reconciled sixty times a second to watch for an event that
 * happens once a set. It now samples the same live levels the meters paint
 * from, off the shared rAF, and touches React state only when the latch
 * actually flips.
 *
 * `getMaxDb` should return max(L, R): either channel clipping counts. It is
 * read through a ref, so callers may pass a fresh closure every render.
 */
export function useChannelClipHold(getMaxDb: () => number): {
  clipped: boolean;
  heldPeakDb: number;
  clear: () => void;
} {
  const [clipped, setClipped] = useState(false);
  const [heldPeakDb, setHeldPeakDb] = useState(FLOOR_DB);

  const getMaxDbRef = useRef(getMaxDb);
  getMaxDbRef.current = getMaxDb;

  // The refs lead and the state follows -- the sampler runs between renders,
  // so it cannot read the latch back out of state without racing itself.
  const clippedRef = useRef(false);
  const heldRef = useRef(FLOOR_DB);

  useEffect(
    () =>
      addRafTask(() => {
        const maxDb = getMaxDbRef.current();
        // Ignore non-finite / absurd peaks (+400 dB etc.) so a single bad
        // sample after a stem EOF cannot latch the clip hold forever.
        if (!Number.isFinite(maxDb) || maxDb > SANE_PEAK_DB) return;
        if (maxDb <= 0) return;
        if (!clippedRef.current) {
          clippedRef.current = true;
          heldRef.current = maxDb;
          setClipped(true);
          setHeldPeakDb(maxDb);
        } else if (maxDb > heldRef.current + HELD_PEAK_EPSILON_DB) {
          heldRef.current = maxDb;
          setHeldPeakDb(maxDb);
        }
      }),
    [],
  );

  const clear = useCallback(() => {
    clippedRef.current = false;
    heldRef.current = FLOOR_DB;
    setClipped(false);
    setHeldPeakDb(FLOOR_DB);
  }, []);

  return { clipped, heldPeakDb, clear };
}
