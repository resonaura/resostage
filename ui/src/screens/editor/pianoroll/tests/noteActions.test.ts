/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MidiNoteRow, MidiRegionRow } from "@/lib/state/types";
import { usePianoRollNoteActions } from "@/screens/editor/pianoroll/hooks/usePianoRollNoteActions";
import { sameEditableNotes } from "@/screens/editor/pianoroll/components/PianoRoll";

function makeNote(
  partial: Partial<MidiNoteRow> & { id: number; pitch: number; startBeats: number; durationBeats: number },
): MidiNoteRow {
  return {
    velocity: 0.8,
    releaseVelocity: 0.5,
    probability: 1.0,
    ...partial,
  };
}

function createRegion(notes: MidiNoteRow[]): MidiRegionRow {
  return {
    id: "midi::region:1",
    trackId: "track:1",
    name: "Pattern 1",
    startBeats: 0,
    durationBeats: 16,
    clipOffsetBeats: 0,
    loop: false,
    loopLengthBeats: 16,
    loopStartBeats: 0,
    notes,
  };
}

describe("Piano Roll Note Actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("deletes only selected notes and resets selection", () => {
    let actions!: ReturnType<typeof usePianoRollNoteActions>;
    let selectedIds!: Set<number>;
    let committed: MidiNoteRow[] = [];
    const notes: MidiNoteRow[] = [
      makeNote({ id: 10, pitch: 60, startBeats: 0, durationBeats: 1 }),
      makeNote({ id: 20, pitch: 62, startBeats: 2, durationBeats: 1 }),
    ];

    function Harness() {
      const [sel, setSel] = useState(new Set([10]));
      selectedIds = sel;
      actions = usePianoRollNoteActions({
        selectedNoteIds: sel,
        setSelectedNoteIds: setSel,
        getEditableNotes: () => notes,
        commitNotes: (n) => { committed = n; },
        playheadBeats: 0,
        region: createRegion(notes),
        snap: 0.25,
        snapToScale: false,
        rootNote: 0,
        scaleMode: "minor",
      });
      return null;
    }

    act(() => root.render(createElement(Harness)));
    act(() => actions.handleDeleteSelected());

    expect(committed).toHaveLength(1);
    expect(committed[0].id).toBe(20);
    expect(selectedIds.size).toBe(0);
  });

  describe("Split at Playhead constraint: ONLY when exactly ONE note is selected", () => {
    it("does nothing when 0 notes are selected", () => {
      let actions!: ReturnType<typeof usePianoRollNoteActions>;
      const notes: MidiNoteRow[] = [
        makeNote({ id: 10, pitch: 60, startBeats: 0, durationBeats: 4 }),
      ];
      let committed: MidiNoteRow[] | null = null;

      function Harness() {
        actions = usePianoRollNoteActions({
          selectedNoteIds: new Set(),
          setSelectedNoteIds: vi.fn(),
          getEditableNotes: () => notes,
          commitNotes: (n) => { committed = n; },
          playheadBeats: 2,
          region: createRegion(notes),
          snap: 0.25,
          snapToScale: false,
          rootNote: 0,
          scaleMode: "minor",
        });
        return null;
      }

      act(() => root.render(createElement(Harness)));
      act(() => actions.handleSplitAtPlayhead());

      expect(committed).toBeNull();
    });

    it("does nothing when 2 or more notes are selected", () => {
      let actions!: ReturnType<typeof usePianoRollNoteActions>;
      const notes: MidiNoteRow[] = [
        makeNote({ id: 10, pitch: 60, startBeats: 0, durationBeats: 4 }),
        makeNote({ id: 20, pitch: 64, startBeats: 0, durationBeats: 4 }),
      ];
      let committed: MidiNoteRow[] | null = null;

      function Harness() {
        actions = usePianoRollNoteActions({
          selectedNoteIds: new Set([10, 20]),
          setSelectedNoteIds: vi.fn(),
          getEditableNotes: () => notes,
          commitNotes: (n) => { committed = n; },
          playheadBeats: 2,
          region: createRegion(notes),
          snap: 0.25,
          snapToScale: false,
          rootNote: 0,
          scaleMode: "minor",
        });
        return null;
      }

      act(() => root.render(createElement(Harness)));
      act(() => actions.handleSplitAtPlayhead());

      expect(committed).toBeNull();
    });

    it("splits the note at playhead when exactly ONE note is selected", () => {
      let actions!: ReturnType<typeof usePianoRollNoteActions>;
      let selectedIds!: Set<number>;
      const notes: MidiNoteRow[] = [
        makeNote({ id: 10, pitch: 60, startBeats: 0, durationBeats: 4 }),
      ];
      let committed: MidiNoteRow[] | null = null;

      function Harness() {
        const [sel, setSel] = useState(new Set([10]));
        selectedIds = sel;
        actions = usePianoRollNoteActions({
          selectedNoteIds: sel,
          setSelectedNoteIds: setSel,
          getEditableNotes: () => notes,
          commitNotes: (n) => { committed = n; },
          playheadBeats: 2,
          region: createRegion(notes),
          snap: 0.25,
          snapToScale: false,
          rootNote: 0,
          scaleMode: "minor",
        });
        return null;
      }

      act(() => root.render(createElement(Harness)));
      act(() => actions.handleSplitAtPlayhead());

      expect(committed).not.toBeNull();
      expect(committed).toHaveLength(2);
      const [noteA, noteB] = committed!;
      expect(noteA.id).toBe(10);
      expect(noteA.startBeats).toBe(0);
      expect(noteA.durationBeats).toBe(2);

      expect(noteB.startBeats).toBe(2);
      expect(noteB.durationBeats).toBe(2);
      expect(noteB.pitch).toBe(60);

      // Second note is selected and selection size remains 1
      expect(selectedIds.size).toBe(1);
      expect(selectedIds.has(noteB.id)).toBe(true);
    });

    it("splits note at midpoint when playhead is outside note bounds", () => {
      let actions!: ReturnType<typeof usePianoRollNoteActions>;
      let selectedIds!: Set<number>;
      const notes: MidiNoteRow[] = [
        makeNote({ id: 10, pitch: 60, startBeats: 2, durationBeats: 2 }),
      ];
      let committed: MidiNoteRow[] | null = null;

      function Harness() {
        const [sel, setSel] = useState(new Set([10]));
        selectedIds = sel;
        actions = usePianoRollNoteActions({
          selectedNoteIds: sel,
          setSelectedNoteIds: setSel,
          getEditableNotes: () => notes,
          commitNotes: (n) => { committed = n; },
          playheadBeats: 0, // playhead outside [2, 4]
          region: createRegion(notes),
          snap: 0.25,
          snapToScale: false,
          rootNote: 0,
          scaleMode: "minor",
        });
        return null;
      }

      act(() => root.render(createElement(Harness)));
      act(() => actions.handleSplitAtPlayhead());

      expect(committed).not.toBeNull();
      expect(committed).toHaveLength(2);
      const [noteA, noteB] = committed!;
      expect(noteA.startBeats).toBe(2);
      expect(noteA.durationBeats).toBe(1);
      expect(noteB.startBeats).toBe(3);
      expect(noteB.durationBeats).toBe(1);
      expect(selectedIds.has(noteB.id)).toBe(true);
    });
  });

  describe("sameEditableNotes reconciliation", () => {
    it("matches notes with C++ float 32-bit rounding differences", () => {
      const original: MidiNoteRow[] = [
        makeNote({ id: 1, pitch: 60, startBeats: 1.0, durationBeats: 0.5, velocity: 0.8 }),
      ];
      // Simulate C++ static_cast<float>(0.8) coming back via JSON as 0.800000011920929
      const fromEngine: MidiNoteRow[] = [
        makeNote({ id: 1, pitch: 60, startBeats: 1.00000002, durationBeats: 0.49999999, velocity: 0.800000011920929 }),
      ];
      expect(sameEditableNotes(original, fromEngine)).toBe(true);
    });

    it("detects actual changes in note properties", () => {
      const original: MidiNoteRow[] = [
        makeNote({ id: 1, pitch: 60, startBeats: 1.0, durationBeats: 0.5, velocity: 0.8 }),
      ];
      const pitchChanged: MidiNoteRow[] = [
        makeNote({ id: 1, pitch: 62, startBeats: 1.0, durationBeats: 0.5, velocity: 0.8 }),
      ];
      const beatChanged: MidiNoteRow[] = [
        makeNote({ id: 1, pitch: 60, startBeats: 1.25, durationBeats: 0.5, velocity: 0.8 }),
      ];
      const countChanged: MidiNoteRow[] = [];

      expect(sameEditableNotes(original, pitchChanged)).toBe(false);
      expect(sameEditableNotes(original, beatChanged)).toBe(false);
      expect(sameEditableNotes(original, countChanged)).toBe(false);
    });
  });

  describe("Quantize to grid", () => {
    it("quantizes selected notes to active grid division", () => {
      let actions!: ReturnType<typeof usePianoRollNoteActions>;
      let committed: MidiNoteRow[] | null = null;
      const notes: MidiNoteRow[] = [
        makeNote({ id: 10, pitch: 60, startBeats: 1.08, durationBeats: 0.95 }),
        makeNote({ id: 20, pitch: 62, startBeats: 2.12, durationBeats: 1.0 }),
      ];

      function Harness() {
        const [sel, setSel] = useState(new Set([10]));
        actions = usePianoRollNoteActions({
          selectedNoteIds: sel,
          setSelectedNoteIds: setSel,
          getEditableNotes: () => notes,
          commitNotes: (n) => { committed = n; },
          playheadBeats: 0,
          region: createRegion(notes),
          snap: 0.5,
          snapToScale: false,
          rootNote: 0,
          scaleMode: "minor",
        });
        return null;
      }

      act(() => root.render(createElement(Harness)));
      act(() => actions.handleQuantize());

      expect(committed).not.toBeNull();
      expect(committed![0].startBeats).toBe(1.0);
      expect(committed![0].durationBeats).toBe(1.0);
      // Unselected note remains unchanged
      expect(committed![1].startBeats).toBe(2.12);
    });

    it("quantizes to 0.25 beat fallback grid even when snap is 0 (magnet toggled off)", () => {
      let actions!: ReturnType<typeof usePianoRollNoteActions>;
      let committed: MidiNoteRow[] | null = null;
      const notes: MidiNoteRow[] = [
        makeNote({ id: 10, pitch: 60, startBeats: 0.29, durationBeats: 0.53 }),
      ];

      function Harness() {
        const [sel, setSel] = useState(new Set([10]));
        actions = usePianoRollNoteActions({
          selectedNoteIds: sel,
          setSelectedNoteIds: setSel,
          getEditableNotes: () => notes,
          commitNotes: (n) => { committed = n; },
          playheadBeats: 0,
          region: createRegion(notes),
          snap: 0, // magnet off
          snapToScale: false,
          rootNote: 0,
          scaleMode: "minor",
        });
        return null;
      }

      act(() => root.render(createElement(Harness)));
      act(() => actions.handleQuantize());

      expect(committed).not.toBeNull();
      expect(committed![0].startBeats).toBe(0.25);
      expect(committed![0].durationBeats).toBe(0.5);
    });

    it("quantizes all notes if no selection exists", () => {
      let actions!: ReturnType<typeof usePianoRollNoteActions>;
      let committed: MidiNoteRow[] | null = null;
      const notes: MidiNoteRow[] = [
        makeNote({ id: 10, pitch: 60, startBeats: 0.26, durationBeats: 0.24 }),
        makeNote({ id: 20, pitch: 62, startBeats: 0.52, durationBeats: 0.49 }),
      ];

      function Harness() {
        const [sel, setSel] = useState(new Set<number>());
        actions = usePianoRollNoteActions({
          selectedNoteIds: sel,
          setSelectedNoteIds: setSel,
          getEditableNotes: () => notes,
          commitNotes: (n) => { committed = n; },
          playheadBeats: 0,
          region: createRegion(notes),
          snap: 0.25,
          snapToScale: false,
          rootNote: 0,
          scaleMode: "minor",
        });
        return null;
      }

      act(() => root.render(createElement(Harness)));
      act(() => actions.handleQuantize());

      expect(committed).not.toBeNull();
      expect(committed![0].startBeats).toBe(0.25);
      expect(committed![0].durationBeats).toBe(0.25);
      expect(committed![1].startBeats).toBe(0.5);
      expect(committed![1].durationBeats).toBe(0.5);
    });
  });
});
