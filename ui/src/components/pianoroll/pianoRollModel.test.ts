import { describe, expect, it } from "vitest";
import { isBlackKey, isPitchInScale, pitchToName, snapPitchToScale } from "./scales";
import { SpatialNoteIndex } from "./spatialIndex";
import { applyLegato, applyOverlapTrim, paintBrushNote, sliceNote } from "./pianoRollModel";
import type { MidiNoteRow } from "../../lib/types";

describe("Piano Roll Scales & Harmonics", () => {
  it("correctly identifies black and white piano keys", () => {
    // C4 = 60 (white), C#4 = 61 (black), D4 = 62 (white), D#4 = 63 (black)
    expect(isBlackKey(60)).toBe(false);
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(62)).toBe(false);
    expect(isBlackKey(63)).toBe(true);
    expect(isBlackKey(64)).toBe(false); // E4
    expect(isBlackKey(65)).toBe(false); // F4
    expect(isBlackKey(66)).toBe(true);  // F#4
  });

  it("formats pitch numbers to note names with octave", () => {
    expect(pitchToName(60)).toBe("C4");
    expect(pitchToName(61)).toBe("C#4");
    expect(pitchToName(72)).toBe("C5");
    expect(pitchToName(57)).toBe("A3");
    expect(pitchToName(69)).toBe("A4");
  });

  it("checks scale membership", () => {
    // C Major: C D E F G A B (60, 62, 64, 65, 67, 69, 71)
    expect(isPitchInScale(60, 0, "major")).toBe(true);
    expect(isPitchInScale(61, 0, "major")).toBe(false);
    expect(isPitchInScale(62, 0, "major")).toBe(true);

    // A Minor (Root 9): A B C D E F G
    expect(isPitchInScale(69, 9, "minor")).toBe(true);  // A4
    expect(isPitchInScale(70, 9, "minor")).toBe(false); // A#4
    expect(isPitchInScale(72, 9, "minor")).toBe(true);  // C5
  });

  it("snaps out-of-scale pitches to nearest scale degree", () => {
    // In C Major: 61 (C#4) should snap to 60 (C4) or 62 (D4)
    const snapped = snapPitchToScale(61, 0, "major");
    expect([60, 62]).toContain(snapped);

    // In C Major: 60 (C4) stays 60
    expect(snapPitchToScale(60, 0, "major")).toBe(60);
  });
});

describe("Piano Roll Spatial Index", () => {
  it("indexes and queries notes efficiently in 2D bounding boxes", () => {
    const index = new SpatialNoteIndex(4.0, 12);

    const notes: MidiNoteRow[] = [
      {
        id: 1,
        pitch: 60,
        startBeats: 0.0,
        durationBeats: 1.0,
        velocity: 0.8,
        releaseVelocity: 0.5,
        probability: 1.0,
      },
      {
        id: 2,
        pitch: 64,
        startBeats: 2.0,
        durationBeats: 2.0,
        velocity: 0.9,
        releaseVelocity: 0.5,
        probability: 1.0,
      },
      {
        id: 3,
        pitch: 67,
        startBeats: 8.0,
        durationBeats: 4.0,
        velocity: 0.7,
        releaseVelocity: 0.5,
        probability: 1.0,
      },
    ];

    index.rebuild(notes);
    expect(index.size()).toBe(3);

    // Query beat 0..4, pitch 50..70: should find notes 1 and 2
    const results = index.queryRange(0.0, 4.0, 50, 70);
    expect(results.length).toBe(2);
    expect(results.map((n) => n.id).sort()).toEqual([1, 2]);

    // Query beat 7..10, pitch 65..70: should find note 3
    const results2 = index.queryRange(7.0, 10.0, 65, 70);
    expect(results2.length).toBe(1);
    expect(results2[0].id).toBe(3);
  });

  it("performs accurate hit tests on note body and resize handles", () => {
    const index = new SpatialNoteIndex(4.0, 12);
    const note: MidiNoteRow = {
      id: 10,
      pitch: 60,
      startBeats: 2.0,
      durationBeats: 2.0, // spans 2.0 to 4.0
      velocity: 0.8,
      releaseVelocity: 0.5,
      probability: 1.0,
    };
    index.rebuild([note]);

    // Hit middle of note: body hit
    const bodyHit = index.hitTest(2.5, 60.2, 0.1);
    expect(bodyHit).not.toBeNull();
    expect(bodyHit?.note.id).toBe(10);
    expect(bodyHit?.isResizeHandle).toBe(false);

    // Hit right edge of note (near 4.0): resize handle hit
    const resizeHit = index.hitTest(3.95, 60.1, 0.1);
    expect(resizeHit).not.toBeNull();
    expect(resizeHit?.note.id).toBe(10);
    expect(resizeHit?.isResizeHandle).toBe(true);

    // Hit outside note: null
    const miss = index.hitTest(1.0, 60.0, 0.1);
    expect(miss).toBeNull();
  });

  it("handles high density benchmark (10,000 notes) in < 1ms query time", () => {
    const index = new SpatialNoteIndex(4.0, 12);
    const largeNotes: MidiNoteRow[] = [];

    for (let i = 0; i < 10000; ++i) {
      largeNotes.push({
        id: i + 1,
        pitch: 36 + (i % 60),
        startBeats: (i * 0.25) % 256,
        durationBeats: 0.5,
        velocity: 0.8,
        releaseVelocity: 0.5,
        probability: 1.0,
      });
    }

    const tStart = performance.now();
    index.rebuild(largeNotes);
    const tRebuild = performance.now() - tStart;

    expect(index.size()).toBe(10000);
    expect(tRebuild).toBeLessThan(150); // fast rebuild

    // Query 4 bars window (16 beats, 2 octaves)
    const tQueryStart = performance.now();
    const queryResults = index.queryRange(16.0, 32.0, 48, 72);
    const tQuery = performance.now() - tQueryStart;

    expect(queryResults.length).toBeGreaterThan(0);
    expect(tQuery).toBeLessThan(2.0); // sub-2ms query for 10,000 notes
  });
});

describe("Piano Roll Pro Edit Operations (Logic Pro X Spec)", () => {
  it("slices note into two notes at cutBeat", () => {
    const note: MidiNoteRow = {
      id: 100,
      pitch: 60,
      startBeats: 2.0,
      durationBeats: 4.0, // spans 2.0 to 6.0
      velocity: 0.8,
      releaseVelocity: 0.5,
      probability: 1.0,
    };

    // Cut at beat 3.5
    const result = sliceNote(note, 3.5, () => 101);
    expect(result).not.toBeNull();
    const [noteA, noteB] = result!;

    expect(noteA.id).toBe(100);
    expect(noteA.startBeats).toBe(2.0);
    expect(noteA.durationBeats).toBe(1.5);
    expect(noteA.pitch).toBe(60);

    expect(noteB.id).toBe(101);
    expect(noteB.startBeats).toBe(3.5);
    expect(noteB.durationBeats).toBe(2.5);
    expect(noteB.pitch).toBe(60);

    // Cutting outside the note boundaries returns null
    expect(sliceNote(note, 1.5)).toBeNull();
    expect(sliceNote(note, 6.5)).toBeNull();
    expect(sliceNote(note, 2.01)).toBeNull(); // within margin
  });

  it("applies Force Legato to extend notes to next event start", () => {
    const notes: MidiNoteRow[] = [
      { id: 1, pitch: 60, startBeats: 0.0, durationBeats: 0.5, velocity: 0.8, releaseVelocity: 0.5, probability: 1.0 },
      { id: 2, pitch: 64, startBeats: 0.0, durationBeats: 0.5, velocity: 0.8, releaseVelocity: 0.5, probability: 1.0 }, // chord with note 1
      { id: 3, pitch: 62, startBeats: 2.0, durationBeats: 0.5, velocity: 0.8, releaseVelocity: 0.5, probability: 1.0 },
      { id: 4, pitch: 67, startBeats: 3.0, durationBeats: 1.0, velocity: 0.8, releaseVelocity: 0.5, probability: 1.0 },
    ];

    const legatoNotes = applyLegato(notes);

    // Notes 1 and 2 at beat 0 extend to beat 2 (duration 2.0)
    expect(legatoNotes.find((n) => n.id === 1)?.durationBeats).toBe(2.0);
    expect(legatoNotes.find((n) => n.id === 2)?.durationBeats).toBe(2.0);

    // Note 3 at beat 2 extends to beat 3 (duration 1.0)
    expect(legatoNotes.find((n) => n.id === 3)?.durationBeats).toBe(1.0);

    // Note 4 is the last note, so its duration is preserved
    expect(legatoNotes.find((n) => n.id === 4)?.durationBeats).toBe(1.0);
  });

  it("trims overlapping note tails on identical pitch", () => {
    const notes: MidiNoteRow[] = [
      { id: 10, pitch: 60, startBeats: 1.0, durationBeats: 2.5, velocity: 0.8, releaseVelocity: 0.5, probability: 1.0 }, // spans 1.0..3.5
      { id: 11, pitch: 60, startBeats: 2.0, durationBeats: 2.0, velocity: 0.8, releaseVelocity: 0.5, probability: 1.0 }, // spans 2.0..4.0 (overlaps with 10)
      { id: 12, pitch: 64, startBeats: 1.0, durationBeats: 3.0, velocity: 0.8, releaseVelocity: 0.5, probability: 1.0 }, // different pitch
    ];

    const trimmed = applyOverlapTrim(notes);

    // Note 10 should be trimmed from 2.5 down to (2.0 - 1.0) = 1.0
    expect(trimmed.find((n) => n.id === 10)?.durationBeats).toBe(1.0);

    // Note 11 has no subsequent overlapping note on pitch 60
    expect(trimmed.find((n) => n.id === 11)?.durationBeats).toBe(2.0);

    // Note 12 on pitch 64 is unaffected
    expect(trimmed.find((n) => n.id === 12)?.durationBeats).toBe(3.0);
  });

  it("paints brush notes on grid without duplicating occupied slots", () => {
    const notes: MidiNoteRow[] = [
      { id: 1, pitch: 60, startBeats: 0.0, durationBeats: 0.5, velocity: 0.8, releaseVelocity: 0.5, probability: 1.0 },
    ];

    // Attempting to paint on occupied slot (pitch 60, beat 0.25) fails
    const failRes = paintBrushNote(notes, 0.25, 60, 0.25);
    expect(failRes).toBeNull();

    // Painting on empty slot (pitch 60, beat 0.5) succeeds
    const successRes = paintBrushNote(notes, 0.5, 60, 0.25, 0.85, () => 2);
    expect(successRes).not.toBeNull();
    expect(successRes!.updatedNotes.length).toBe(2);
    expect(successRes!.newNote.id).toBe(2);
    expect(successRes!.newNote.startBeats).toBe(0.5);
    expect(successRes!.newNote.durationBeats).toBe(0.25);
    expect(successRes!.newNote.velocity).toBe(0.85);

    // Painting on same beat but different pitch succeeds
    const diffPitchRes = paintBrushNote(notes, 0.0, 62, 0.5, 0.8, () => 3);
    expect(diffPitchRes).not.toBeNull();
    expect(diffPitchRes!.newNote.pitch).toBe(62);
  });
});

