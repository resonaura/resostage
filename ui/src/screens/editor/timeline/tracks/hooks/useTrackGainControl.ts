/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useLiveValue } from "@/lib/state/optimistic";
import { mixer } from "@/lib/state/api";
import type { TrackRow } from "@/lib/state/types";

/** Owns optimistic gain state and the timeline's vertical dB readout gesture. */
export function useTrackGainControl(track: TrackRow, index: number) {
  const [gain, setGain] = useLiveValue(track.gainDb ?? 0, (value) =>
    mixer.setTrackGain(index, value),
  );

  const onReadoutPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startValue = Number.isFinite(gain) ? gain : -60;

    const onPointerMove = (pointerEvent: PointerEvent) => {
      const deltaY = startY - pointerEvent.clientY;
      const step = pointerEvent.shiftKey ? 0.1 : 0.5;
      const next = Math.max(
        -60,
        Math.min(12, Math.round((startValue + deltaY * 0.15) / step) * step),
      );
      setGain(next);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onReadoutDoubleClick = (event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    setGain(0);
  };

  return {
    gain,
    setGain,
    onReadoutPointerDown,
    onReadoutDoubleClick,
  };
}
