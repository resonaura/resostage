// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useCallback } from "react";
import type { MidiRegionRow } from "@/lib/state/types";
import { midiRegionSourceBeat } from "@/lib/midi/midiRegionTiming";
import { canvasYToPitch } from "@/screens/editor/pianoroll/logic/pianoRollModel";
import type {
  GridSnapValue,
  PianoRollViewport,
} from "@/screens/editor/pianoroll/logic/types";

interface PianoRollCoordinatesOptions {
  viewport: PianoRollViewport;
  snap: GridSnapValue;
  region: MidiRegionRow;
}

/** Converts between Piano Roll screen coordinates and musical coordinates. */
export function usePianoRollCoordinates({
  viewport,
  snap,
  region,
}: PianoRollCoordinatesOptions) {
  const beatToX = useCallback(
    (beat: number) => {
      return (
        viewport.keyWidth +
        (beat - viewport.scrollBeats) * viewport.pixelsPerBeat
      );
    },
    [viewport.keyWidth, viewport.scrollBeats, viewport.pixelsPerBeat],
  );

  const xToBeat = useCallback(
    (x: number) => {
      return (
        viewport.scrollBeats + (x - viewport.keyWidth) / viewport.pixelsPerBeat
      );
    },
    [viewport.keyWidth, viewport.scrollBeats, viewport.pixelsPerBeat],
  );

  const pitchToY = useCallback(
    (pitch: number, height: number) => {
      const gridBottom = height - viewport.velocityLaneHeight;
      // High pitches at top, low pitches at bottom
      return (
        gridBottom -
        (pitch - viewport.scrollPitch + 1) * viewport.pixelsPerPitch
      );
    },
    [
      viewport.velocityLaneHeight,
      viewport.scrollPitch,
      viewport.pixelsPerPitch,
    ],
  );

  const yToPitch = useCallback(
    (y: number, height: number) => {
      const gridBottom = height - viewport.velocityLaneHeight;
      // scrollPitch is intentionally fractional during smooth wheel/trackpad
      // panning. Round the complete inverse transform, not just its delta;
      // otherwise a visible note can hit-test as the adjacent semitone.
      return canvasYToPitch(
        y,
        gridBottom,
        viewport.scrollPitch,
        viewport.pixelsPerPitch,
      );
    },
    [
      viewport.velocityLaneHeight,
      viewport.scrollPitch,
      viewport.pixelsPerPitch,
    ],
  );

  // Quantize beat to grid snap
  const snapBeat = useCallback(
    (beat: number): number => {
      if (snap <= 0) return Math.max(0, beat);
      return Math.max(0, Math.round(beat / snap) * snap);
    },
    [snap],
  );

  const sourceBeatAt = useCallback(
    (beat: number) => midiRegionSourceBeat(region, beat),
    [region],
  );

  return {
    beatToX,
    xToBeat,
    pitchToY,
    yToPitch,
    snapBeat,
    sourceBeatAt,
  };
}
