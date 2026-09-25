import type { ScaleMode } from "./types";

export const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

export const BLACK_KEY_SEMITONES = new Set([1, 3, 6, 8, 10]);

export const SCALE_INTERVALS: Record<ScaleMode, readonly number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

export const SCALE_LABELS: Record<ScaleMode, string> = {
  chromatic: "Chromatic (All Notes)",
  major: "Major (Ionian)",
  minor: "Natural Minor (Aeolian)",
  harmonicMinor: "Harmonic Minor",
  melodicMinor: "Melodic Minor",
  dorian: "Dorian",
  phrygian: "Phrygian",
  lydian: "Lydian",
  mixolydian: "Mixolydian",
  majorPentatonic: "Major Pentatonic",
  minorPentatonic: "Minor Pentatonic",
  blues: "Blues",
};

/** Checks whether a MIDI pitch (0..127) is a black piano key. */
export function isBlackKey(pitch: number): boolean {
  const semitone = ((pitch % 12) + 12) % 12;
  return BLACK_KEY_SEMITONES.has(semitone);
}

/** Formats a MIDI pitch as musical note name with octave (e.g. 60 -> "C4"). */
export function pitchToName(pitch: number): string {
  const semitone = ((pitch % 12) + 12) % 12;
  const octave = Math.floor(pitch / 12) - 1;
  return `${NOTE_NAMES[semitone]}${octave}`;
}

/** Checks whether a pitch is part of the specified musical scale. */
export function isPitchInScale(
  pitch: number,
  rootNote: number,
  scale: ScaleMode,
): boolean {
  if (scale === "chromatic") return true;
  const semitone = ((pitch % 12) + 12) % 12;
  const rootSemitone = ((rootNote % 12) + 12) % 12;
  const relativeInterval = (semitone - rootSemitone + 12) % 12;
  return SCALE_INTERVALS[scale].includes(relativeInterval);
}

/** Snaps a given pitch to the nearest in-scale pitch. */
export function snapPitchToScale(
  pitch: number,
  rootNote: number,
  scale: ScaleMode,
): number {
  if (scale === "chromatic") return Math.max(0, Math.min(127, Math.round(pitch)));

  const clampedPitch = Math.max(0, Math.min(127, Math.round(pitch)));
  if (isPitchInScale(clampedPitch, rootNote, scale)) {
    return clampedPitch;
  }

  // Find nearest neighbor in scale
  for (let delta = 1; delta <= 6; ++delta) {
    const down = clampedPitch - delta;
    if (down >= 0 && isPitchInScale(down, rootNote, scale)) {
      return down;
    }
    const up = clampedPitch + delta;
    if (up <= 127 && isPitchInScale(up, rootNote, scale)) {
      return up;
    }
  }

  return clampedPitch;
}
