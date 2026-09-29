import type { AutomationPointRow, MidiNoteRow } from "../../lib/state/types";

/** A controller gesture adds at most one endpoint; keep saved lanes bounded. */
export const MAX_CONTROLLER_POINTS = 4096;

/**
 * Replace an existing automation point, or insert one at a musical beat.
 * The result is sorted and has at most one point at the edited beat.
 */
export function editControllerPoint(
  points: AutomationPointRow[],
  pointIndex: number | null,
  beat: number,
  value: number,
): AutomationPointRow[] | null {
  const timeBeats = Math.max(0, beat);
  if (pointIndex === null && points.length >= MAX_CONTROLLER_POINTS &&
      !points.some((point) => Math.abs(point.timeBeats - timeBeats) <= 1e-9)) return null;
  if (pointIndex !== null && (pointIndex < 0 || pointIndex >= points.length)) return null;

  const edited = pointIndex === null
    ? { timeBeats, value, curve: 0 }
    : { ...points[pointIndex], timeBeats, value };
  const next = points.filter((point, index) =>
    index !== pointIndex && Math.abs(point.timeBeats - timeBeats) > 1e-9,
  );
  next.push(edited);
  next.sort((left, right) => left.timeBeats - right.timeBeats);
  return next;
}

let nextNoteCounter = 1;
export function generateNoteId(): number {
  return Date.now() * 1000 + (nextNoteCounter++ % 1000);
}

/** Inverse of the canvas pitch-to-Y transform, including fractional scroll. */
export function canvasYToPitch(
  y: number,
  gridBottom: number,
  scrollPitch: number,
  pixelsPerPitch: number,
): number {
  return Math.floor(scrollPitch + (gridBottom - y) / pixelsPerPitch);
}

/**
 * Resolve the musical length of a pencil drag. A click keeps the remembered
 * single-note duration; once the pointer moves, the dragged span (rather than
 * the remembered duration plus the span) becomes the note length.
 */
export function resolveDrawNoteDuration(
  anchorBeat: number,
  pointerBeat: number,
  snap: number,
  clickDuration: number,
  dragThresholdBeats = 0.02,
): number {
  const delta = Math.abs(pointerBeat - anchorBeat);
  if (delta < Math.max(1e-6, dragThresholdBeats))
    return Math.max(0.125, clickDuration);

  if (snap > 0) {
    const start = Math.round(Math.min(anchorBeat, pointerBeat) / snap) * snap;
    const end = Math.round(Math.max(anchorBeat, pointerBeat) / snap) * snap;
    return Math.max(snap, end - start);
  }
  return Math.max(0.125, delta);
}

/**
 * Split a note at `cutBeat` into two consecutive notes.
 * Returns null if `cutBeat` is outside the note body.
 */
export function sliceNote(
  note: MidiNoteRow,
  cutBeat: number,
  idGen: () => number = generateNoteId,
): [MidiNoteRow, MidiNoteRow] | null {
  const noteEnd = note.startBeats + note.durationBeats;
  const minDuration = 0.03125; // 1/128 beat minimum
  if (
    cutBeat <= note.startBeats + minDuration ||
    cutBeat >= noteEnd - minDuration
  ) {
    return null;
  }

  const noteA: MidiNoteRow = {
    ...note,
    durationBeats: cutBeat - note.startBeats,
  };

  const noteB: MidiNoteRow = {
    ...note,
    id: idGen(),
    startBeats: cutBeat,
    durationBeats: noteEnd - cutBeat,
  };

  return [noteA, noteB];
}

/**
 * Force Legato: Extends notes so that their duration meets the next note's start time.
 * If multiple notes form a chord, all chord notes extend to the start of the next event.
 */
export function applyLegato(
  notes: MidiNoteRow[],
  selectedIds?: Set<number>,
): MidiNoteRow[] {
  const isTarget = (n: MidiNoteRow) =>
    !selectedIds || selectedIds.size === 0 || selectedIds.has(n.id);
  const targetNotes = notes.filter(isTarget);
  if (targetNotes.length === 0) return notes;

  // Gather unique start times of all target notes in ascending order
  const startTimes = Array.from(
    new Set(targetNotes.map((n) => n.startBeats)),
  ).sort((a, b) => a - b);

  const durationOverrides = new Map<number, number>();

  for (const note of targetNotes) {
    // Find next start time strictly greater than current note start
    const nextStart = startTimes.find((t) => t > note.startBeats);
    if (nextStart !== undefined) {
      const newDur = Math.max(0.0625, nextStart - note.startBeats);
      durationOverrides.set(note.id, newDur);
    }
  }

  return notes.map((n) => {
    if (durationOverrides.has(n.id)) {
      return { ...n, durationBeats: durationOverrides.get(n.id)! };
    }
    return n;
  });
}

/**
 * Trim Overlaps: Eliminates overlapping note tails on the same pitch,
 * preventing voice-stealing artifacts and stuck notes.
 */
export function applyOverlapTrim(
  notes: MidiNoteRow[],
  selectedIds?: Set<number>,
): MidiNoteRow[] {
  const isTarget = (n: MidiNoteRow) =>
    !selectedIds || selectedIds.size === 0 || selectedIds.has(n.id);

  // Group target notes by pitch
  const byPitch = new Map<number, MidiNoteRow[]>();
  for (const note of notes) {
    if (!isTarget(note)) continue;
    const list = byPitch.get(note.pitch) || [];
    list.push(note);
    byPitch.set(note.pitch, list);
  }

  const durationOverrides = new Map<number, number>();

  for (const [, pitchNotes] of byPitch) {
    pitchNotes.sort((a, b) => a.startBeats - b.startBeats);
    for (let i = 0; i < pitchNotes.length - 1; ++i) {
      const current = pitchNotes[i];
      const next = pitchNotes[i + 1];
      const currentEnd = current.startBeats + current.durationBeats;
      if (
        currentEnd > next.startBeats &&
        next.startBeats > current.startBeats
      ) {
        const clampedDur = Math.max(
          0.0625,
          next.startBeats - current.startBeats,
        );
        durationOverrides.set(current.id, clampedDur);
      }
    }
  }

  return notes.map((n) => {
    if (durationOverrides.has(n.id)) {
      return { ...n, durationBeats: durationOverrides.get(n.id)! };
    }
    return n;
  });
}

/**
 * Brush tool note painting: Creates a new note at (beat, pitch) with `duration`
 * if no existing note already covers that slot on the same pitch.
 */
export function paintBrushNote(
  notes: MidiNoteRow[],
  beat: number,
  pitch: number,
  duration: number,
  velocity = 0.8,
  idGen: () => number = generateNoteId,
): { updatedNotes: MidiNoteRow[]; newNote: MidiNoteRow } | null {
  // Check collision: any note on this pitch that overlaps [beat, beat + duration]
  const slotEnd = beat + duration;
  const collides = notes.some((n) => {
    if (n.pitch !== pitch) return false;
    const nEnd = n.startBeats + n.durationBeats;
    return beat < nEnd - 0.001 && slotEnd > n.startBeats + 0.001;
  });

  if (collides) return null;

  const newNote: MidiNoteRow = {
    id: idGen(),
    pitch,
    startBeats: beat,
    durationBeats: duration,
    velocity,
    releaseVelocity: 0.5,
    probability: 1.0,
  };

  return {
    updatedNotes: [...notes, newNote],
    newNote,
  };
}
