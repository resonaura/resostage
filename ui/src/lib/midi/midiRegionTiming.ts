import type { MidiRegionRow } from "../state/types";

const positiveModulo = (value: number, length: number): number => {
  if (!(length > 1e-9) || !Number.isFinite(value) || !Number.isFinite(length))
    return 0;
  return ((value % length) + length) % length;
};

export function midiRegionLoopPhase(region: MidiRegionRow): number {
  return positiveModulo(
    region.clipOffsetBeats - (region.loopStartBeats ?? 0),
    region.loopLengthBeats,
  );
}

/** Map region-relative timeline beats to the source notes/events being played. */
export function midiRegionSourceBeat(
  region: MidiRegionRow,
  elapsedBeats: number,
): number {
  if (!region.loop || !(region.loopLengthBeats > 1e-9))
    return elapsedBeats + region.clipOffsetBeats;
  const loopStart = region.loopStartBeats ?? 0;
  return loopStart + positiveModulo(
    midiRegionLoopPhase(region) + elapsedBeats,
    region.loopLengthBeats,
  );
}

/** Place a source event at its first occurrence after this region begins. */
export function midiRegionLoopOccurrence(
  region: MidiRegionRow,
  sourceBeat: number,
): number {
  const loopStart = region.loopStartBeats ?? 0;
  return positiveModulo(
    sourceBeat - loopStart - midiRegionLoopPhase(region),
    region.loopLengthBeats,
  );
}

export function midiRegionContainsLoopSourceBeat(
  region: MidiRegionRow,
  sourceBeat: number,
): boolean {
  const loopStart = region.loopStartBeats ?? 0;
  return region.loopLengthBeats > 1e-9
    && sourceBeat >= loopStart - 1e-9
    && sourceBeat < loopStart + region.loopLengthBeats - 1e-9;
}

/** A looped source note is cut at the loop window's right edge on every pass. */
export function midiRegionNotePlaybackDuration(
  region: MidiRegionRow,
  sourceStartBeats: number,
  noteDurationBeats: number,
): number {
  if (!region.loop || !(region.loopLengthBeats > 1e-9)) return noteDurationBeats;
  return Math.max(0, Math.min(
    noteDurationBeats,
    (region.loopStartBeats ?? 0) + region.loopLengthBeats - sourceStartBeats,
  ));
}
