/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { MidiNoteRow, MidiRegionRow } from "@/lib/state/types";
import {
  boundedNoteMove,
  boundedNoteResize,
  findNotesInMarquee,
  marqueeSelection,
  sweepBrushNotes,
} from "@/screens/editor/pianoroll/logic/gestures";

const note = (id: number, pitch: number, startBeats: number): MidiNoteRow => ({
  id, pitch, startBeats, durationBeats: 1, velocity: 0.8,
  releaseVelocity: 0.5, probability: 1,
});

describe("Piano Roll multi-note gestures", () => {
  it("keeps the initial selection while an additive marquee changes its box", () => {
    const initial = new Set([1, 2]);
    expect([...marqueeSelection([2, 3], initial)]).toEqual([1, 2, 3]);
    expect([...marqueeSelection([4], initial)]).toEqual([1, 2, 4]);
    expect([...initial]).toEqual([1, 2]);
    expect([...marqueeSelection([4])]).toEqual([4]);
  });

  it("preserves chord intervals at the top and bottom MIDI pitches", () => {
    const highChord = [note(1, 120, 1), note(2, 127, 2)];
    expect(boundedNoteMove(highChord, 2, 12)).toEqual({ deltaBeats: 2, deltaPitch: 0 });
    const lowChord = [note(3, 0, 1), note(4, 7, 2)];
    expect(boundedNoteMove(lowChord, 2, -12)).toEqual({ deltaBeats: 2, deltaPitch: 0 });
    expect(boundedNoteMove(highChord, 2, -12)).toEqual({ deltaBeats: 2, deltaPitch: -12 });
  });

  it("preserves rhythmic offsets when a group reaches beat zero", () => {
    const group = [note(1, 60, 0.25), note(2, 64, 1.75)];
    const delta = boundedNoteMove(group, -3, 1);
    expect(delta).toEqual({ deltaBeats: -0.25, deltaPitch: 1 });
    const moved = group.map((event) => event.startBeats + delta.deltaBeats);
    expect(moved).toEqual([0, 1.5]);
  });

  it("sweeps intervening brush cells without skipping during fast moves", () => {
    let nextId = 100;
    const swept = sweepBrushNotes([], 0, 2, 60, 0.5, 64, 0.8, () => nextId++);
    expect(swept).not.toBeNull();
    expect(swept?.addedNotes.map((n) => n.startBeats)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(swept?.updatedNotes.length).toBe(5);
  });

  it("avoids duplicate notes when sweeping across existing notes on the pitch", () => {
    let nextId = 200;
    const existing: MidiNoteRow[] = [
      { id: 1, pitch: 60, startBeats: 1, durationBeats: 0.5, velocity: 0.8, releaseVelocity: 0.5, probability: 1 },
    ];
    const swept = sweepBrushNotes(existing, 0, 2, 60, 0.5, 64, 0.8, () => nextId++);
    expect(swept).not.toBeNull();
    // Beat 1.0 already exists, so addedNotes should only contain 0, 0.5, 1.5, 2.0
    expect(swept?.addedNotes.map((n) => n.startBeats)).toEqual([0, 0.5, 1.5, 2]);
    expect(swept?.updatedNotes.length).toBe(5);
  });

  it("bounds the maximum number of swept cells per pointer event", () => {
    let nextId = 300;
    const swept = sweepBrushNotes([], 0, 100, 60, 0.25, 8, 0.8, () => nextId++);
    expect(swept?.addedNotes.length).toBe(8);
  });

  it("preserves relative note durations within a multi-note selection when shrinking", () => {
    const group: MidiNoteRow[] = [
      { ...note(1, 60, 0), durationBeats: 0.5 },
      { ...note(2, 64, 0), durationBeats: 2.0 },
    ];
    // Shortest note is 0.5. With free snap (min 0.125), max shrink is 0.375.
    // Asking to shrink by 1.0 beat should clamp to -0.375.
    const delta = boundedNoteResize(group, -1.0, 0);
    expect(delta).toBe(-0.375);
    const resized = group.map((n) => n.durationBeats + delta);
    expect(resized).toEqual([0.125, 1.625]);
    // Relative difference remains exactly 2.0 - 0.5 = 1.5
    expect(resized[1] - resized[0]).toBe(1.5);
  });

  it("snaps group resize deltas without exceeding the shortest note constraint", () => {
    const group: MidiNoteRow[] = [
      { ...note(1, 60, 0), durationBeats: 0.5 },
      { ...note(2, 64, 0), durationBeats: 1.5 },
    ];
    // Snap = 0.25. Min duration = 0.25. Max shrink = 0.5 - 0.25 = 0.25.
    // Asking to shrink by 0.6: clampedDelta = -0.25, snapped = -0.25.
    const delta = boundedNoteResize(group, -0.6, 0.25);
    expect(delta).toBe(-0.25);
    const resized = group.map((n) => n.durationBeats + delta);
    expect(resized).toEqual([0.25, 1.25]);
    expect(resized[1] - resized[0]).toBe(1.0);
  });

  describe("findNotesInMarquee loop selection", () => {
    const testRegion: MidiRegionRow = {
      id: "reg-1",
      trackId: "trk-1",
      name: "MIDI",
      startBeats: 0,
      durationBeats: 32,
      clipOffsetBeats: 0,
      loop: true,
      loopLengthBeats: 16,
      loopStartBeats: 0,
      notes: [
        note(1, 60, 2), // pitch 60 at beat 2 (repeat 0: 2..3, repeat 1: 18..19)
        note(2, 64, 6), // pitch 64 at beat 6 (repeat 0: 6..7, repeat 1: 22..23)
      ],
    };

    it("selects note on repeat 0", () => {
      const hits = findNotesInMarquee(testRegion.notes, testRegion, 1.5, 3.5, 59, 61);
      expect(hits).toEqual([1]);
    });

    it("selects note on repeat 1 when marquee is dragged on loop part", () => {
      // Marquee placed on the second loop iteration (17.5..19.5, pitch 60)
      const hits = findNotesInMarquee(testRegion.notes, testRegion, 17.5, 19.5, 59, 61);
      expect(hits).toEqual([1]);
    });

    it("does not select note if marquee pitch or beats miss on repeat 1", () => {
      // Correct beat range on repeat 1, but different pitch
      const hitsWrongPitch = findNotesInMarquee(testRegion.notes, testRegion, 17.5, 19.5, 62, 65);
      expect(hitsWrongPitch).toEqual([]);

      // Correct pitch, but between notes on repeat 1
      const hitsWrongBeats = findNotesInMarquee(testRegion.notes, testRegion, 12, 16, 59, 61);
      expect(hitsWrongBeats).toEqual([]);
    });

    it("selects multiple notes when marquee spans multiple occurrences or chords", () => {
      const hits = findNotesInMarquee(testRegion.notes, testRegion, 17, 24, 59, 65);
      expect(hits).toEqual([1, 2]);
    });

    it("works identically for non-looped regions with clip offset", () => {
      const unlooped: MidiRegionRow = {
        ...testRegion,
        loop: false,
        durationBeats: 16,
        clipOffsetBeats: 2, // note 1 (start 2) appears at 0, note 2 (start 6) appears at 4
      };
      const hitFirst = findNotesInMarquee(unlooped.notes, unlooped, -0.5, 1.5, 59, 61);
      expect(hitFirst).toEqual([1]);

      const hitSecond = findNotesInMarquee(unlooped.notes, unlooped, 3.5, 5.5, 63, 65);
      expect(hitSecond).toEqual([2]);
    });
  });
});

