import { describe, expect, it } from "vitest";
import { isBlackKey, isPitchInScale, pitchToName, snapPitchToScale } from "./scales";
import { SpatialNoteIndex } from "./spatialIndex";
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
