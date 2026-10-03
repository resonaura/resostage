/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { createSongTempoMap } from "@/lib/midi/tempoMap";
import type { SongRow } from "@/lib/state/types";

export interface PianoRollProjectAxis {
  secondsToBeats(seconds: number): number;
  beatsToSeconds(beat: number): number;
  durationBeats(seconds: number): number;
  snapSeconds(seconds: number, gridBeats: number): number;
}

/** Project header and cycle coordinates share Core's song-local TempoMap. */
export function createPianoRollProjectAxis(
  song: Pick<SongRow, "bpm" | "tempoPoints">,
): PianoRollProjectAxis {
  const tempoMap = createSongTempoMap(song);
  return {
    secondsToBeats: tempoMap.secondsToBeats,
    beatsToSeconds: tempoMap.beatsToSeconds,
    durationBeats: (seconds) => Math.max(0, tempoMap.secondsToBeats(seconds)),
    snapSeconds: (seconds, gridBeats) => {
      if (!Number.isFinite(seconds) || !Number.isFinite(gridBeats) || gridBeats <= 0)
        return seconds;
      const beat = tempoMap.secondsToBeats(seconds);
      return tempoMap.beatsToSeconds(Math.round(beat / gridBeats) * gridBeats);
    },
  };
}
