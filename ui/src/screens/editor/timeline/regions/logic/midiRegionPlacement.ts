// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { snapToGridSec } from "@/screens/editor/timeline/ruler/logic/geometry";

export function midiRegionPlacementAt(
  localSeconds: number,
  songLengthSeconds: number,
  bpm: number,
  beatsPerBar: number,
  pxPerSec: number,
  snapEnabled: boolean,
): { startBeats: number; durationBeats: number } {
  const safeBpm = bpm > 0 ? bpm : 120;
  const safeBeatsPerBar = Math.max(1, Math.round(beatsPerBar || 4));
  const snappedSeconds = Math.max(
    0,
    snapToGridSec(
      localSeconds,
      pxPerSec,
      safeBpm,
      safeBeatsPerBar,
      snapEnabled,
    ),
  );
  const startBeats = (snappedSeconds * safeBpm) / 60;
  const songEndBeats = Math.max(
    startBeats + 0.25,
    (songLengthSeconds * safeBpm) / 60,
  );
  return {
    startBeats,
    durationBeats: Math.max(
      0.25,
      Math.min(safeBeatsPerBar, songEndBeats - startBeats),
    ),
  };
}
