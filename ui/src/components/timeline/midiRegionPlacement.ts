import { snapToGridSec } from "./geometry";

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
