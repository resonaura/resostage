import { useEffect, useRef, useState } from "react";

const FLOOR_DB = -100;
/** Anything above this is treated as a metering glitch, not a real clip. */
const SANE_PEAK_DB = 24;

export function useChannelClipHold(maxDb: number): {
  clipped: boolean;
  heldPeakDb: number;
  clear: () => void;
} {
  const [clipped, setClipped] = useState(false);
  const [heldPeakDb, setHeldPeakDb] = useState(FLOOR_DB);
  const clippedRef = useRef(false);
  const heldRef = useRef(FLOOR_DB);
  clippedRef.current = clipped;
  heldRef.current = heldPeakDb;

  useEffect(() => {
    // Ignore non-finite / absurd peaks (+400 dB etc.) so a single bad
    // sample after a stem EOF cannot latch the clip hold forever.
    if (!Number.isFinite(maxDb) || maxDb > SANE_PEAK_DB) return;
    if (maxDb > 0) {
      if (!clippedRef.current) {
        setClipped(true);
        setHeldPeakDb(maxDb);
      } else if (maxDb > heldRef.current) {
        setHeldPeakDb(maxDb);
      }
    }
  }, [maxDb]);

  const clear = () => {
    setClipped(false);
    setHeldPeakDb(FLOOR_DB);
  };

  return { clipped, heldPeakDb, clear };
}
