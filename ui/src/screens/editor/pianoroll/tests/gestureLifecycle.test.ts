/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import type { MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationLaneRow, MidiClipEventRow, MidiNoteRow } from "@/lib/state/types";
import { activeDragCount } from "@/lib/interaction/dragCancel";
import { usePianoRollGestureLifecycle } from "@/screens/editor/pianoroll/hooks/usePianoRollGestureLifecycle";
import type {
  DraggingState, PianoRollControllerGesture,
  PianoRollMidiEventGesture, PianoRollPendingAutomationCommit, PianoRollVelocityPaintState,
} from "@/screens/editor/pianoroll/logic/types";

const ref = <T,>(current: T): MutableRefObject<T> => ({ current });
const notes: MidiNoteRow[] = [{
  id: 1, pitch: 60, startBeats: 1, durationBeats: 1, velocity: 0.8,
  releaseVelocity: 0.5, probability: 1,
}];
const drag = (): DraggingState => ({
  type: "move", startPointerX: 100, startPointerY: 100,
  startBeat: 1, startPitch: 60, initialNotesSnapshot: new Map(),
});

describe("Piano Roll gesture lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let lifecycle: ReturnType<typeof usePianoRollGestureLifecycle>;
  let options: Parameters<typeof usePianoRollGestureLifecycle>[0];
  let lanes: AutomationLaneRow[] | null;
  let localNotes: MidiNoteRow[] | null;
  let localEvents: MidiClipEventRow[] | null;
  let selection: Set<number>;
  let controllerEventSelection: Set<number>;
  let capture: Set<number>;

  function Harness({ regionId }: { regionId: string }) {
    lifecycle = usePianoRollGestureLifecycle({ ...options, regionId });
    return null;
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    capture = new Set();
    lanes = null;
    localNotes = null;
    localEvents = null;
    selection = new Set();
    controllerEventSelection = new Set();
    const canvas = {
      hasPointerCapture: (id: number) => capture.has(id),
      releasePointerCapture: vi.fn((id: number) => capture.delete(id)),
    } as unknown as HTMLCanvasElement;
    options = {
      regionId: "a",
      canvasRef: ref(canvas),
      draggingRef: ref<DraggingState | null>(null),
      pendingCommitRef: ref<MidiNoteRow[] | null>(null),
      pendingAutomationCommitRef: ref<PianoRollPendingAutomationCommit | null>(null),
      controllerGestureRef: ref<PianoRollControllerGesture | null>(null),
      midiEventGestureRef: ref<PianoRollMidiEventGesture | null>(null),
      velocityPaintRef: ref<PianoRollVelocityPaintState | null>(null),
      lastDragDetentRef: ref<string | null>(null),
      stopAutoScroll: vi.fn(),
      setLocalNotes: (next) => { localNotes = next; },
      setControllerPreview: (next) => { lanes = next; },
      setLocalEvents: (next) => { localEvents = next; },
      setHoveredPitch: vi.fn(),
      onSelectionChange: (next) => { selection = next; },
      setControllerEventSelection: (next) => { controllerEventSelection = next; },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(Harness, { regionId: "a" })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    expect(activeDragCount()).toBe(0);
  });

  it("cancels capture, auto-scroll and speculative notes when the region changes", () => {
    capture.add(7);
    options.draggingRef.current = drag();
    options.pendingCommitRef.current = notes;
    options.pendingAutomationCommitRef.current = { parameterId: "cc:1", points: [] };
    localNotes = notes;
    lanes = [];
    localEvents = [{ beat: 1, status: 0xb0, data: [64, 127] }];
    lifecycle.beginGesture(7, {
      notes: null, pendingNotes: null, lanes: null, events: null,
      selection: new Set(), controllerEventSelection: new Set(),
    });
    expect(activeDragCount()).toBe(1);

    act(() => root.render(createElement(Harness, { regionId: "b" })));

    expect(options.draggingRef.current).toBeNull();
    expect(options.pendingCommitRef.current).toBeNull();
    expect(options.pendingAutomationCommitRef.current).toBeNull();
    expect(localNotes).toBeNull();
    expect(lanes).toBeNull();
    expect(localEvents).toBeNull();
    expect(capture.size).toBe(0);
    expect(options.stopAutoScroll).toHaveBeenCalled();
    expect(activeDragCount()).toBe(0);
  });

  it("Escape restores the pre-gesture draft without discarding a previous in-flight edit", () => {
    capture.add(8);
    options.draggingRef.current = drag();
    lifecycle.beginGesture(8, {
      notes, pendingNotes: notes, lanes: null, selection: new Set([1]),
      controllerEventSelection: new Set([2, 3]),
    });
    options.pendingCommitRef.current = [{ ...notes[0], startBeats: 4 }];
    localNotes = options.pendingCommitRef.current;

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    })));

    expect(localNotes).toBe(notes);
    expect(options.pendingCommitRef.current).toBe(notes);
    expect([...selection]).toEqual([1]);
    expect([...controllerEventSelection]).toEqual([2, 3]);
    expect(options.draggingRef.current).toBeNull();
    expect(capture.size).toBe(0);
    expect(activeDragCount()).toBe(0);
  });

  it("only unexpected capture loss cancels; normal pointer-up does not revert", () => {
    capture.add(9);
    options.draggingRef.current = drag();
    lifecycle.beginGesture(9, {
      notes: null, pendingNotes: null, lanes: null, selection: new Set(),
      controllerEventSelection: new Set(),
    });
    localNotes = notes;
    lifecycle.endGesture();
    lifecycle.lostPointerCapture(9);
    expect(localNotes).toBe(notes);

    lifecycle.beginGesture(10, {
      notes: null, pendingNotes: null, lanes: null, selection: new Set(),
      controllerEventSelection: new Set(),
    });
    lifecycle.lostPointerCapture(10);
    expect(localNotes).toBeNull();
    expect(options.draggingRef.current).toBeNull();
  });
});
