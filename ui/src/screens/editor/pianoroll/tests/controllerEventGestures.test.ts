/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/interaction/haptics", () => ({ triggerHaptic: vi.fn() }));
import type { MidiClipEventRow, MidiRegionRow } from "@/lib/state/types";
import { midiRegionSourceBeat } from "@/lib/midi/midiRegionTiming";
import { createPianoRollPointerDownHandler } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerDownHandler";
import { createPianoRollPointerMoveHandler } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerMoveHandler";
import { createPianoRollPointerEndHandlers } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerEndHandlers";
import { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";
import { controllerYFromValue } from "@/screens/editor/pianoroll/logic/canvasUtils";
import type {
  DraggingState,
  PianoRollControllerGesture,
  PianoRollMidiEventGesture,
  PianoRollPendingAutomationCommit,
  PianoRollBottomLane,
  GridSnapValue,
  PianoRollTool,
  PianoRollVelocityPaintState,
  PianoRollViewport,
} from "@/screens/editor/pianoroll/logic/types";

const ref = <T,>(current: T) => ({ current });
const viewport: PianoRollViewport = {
  pixelsPerBeat: 80,
  pixelsPerPitch: 12,
  scrollBeats: 0,
  scrollPitch: 48,
  keyWidth: 54,
  velocityLaneHeight: 90,
};

function region(events: MidiClipEventRow[] = []): MidiRegionRow {
  return {
    id: "midi-region",
    trackId: "track-1",
    name: "MIDI",
    startBeats: 0,
    durationBeats: 8,
    clipOffsetBeats: 0,
    loop: false,
    loopLengthBeats: 0,
    notes: [],
    events,
  };
}

function harness(
  source: MidiRegionRow,
  options: {
    tool?: PianoRollTool;
    bottomLane?: PianoRollBottomLane;
    snap?: GridSnapValue;
  } = {},
) {
  const tool = options.tool ?? "select";
  const bottomLane = options.bottomLane ?? "cc74";
  const snap = options.snap ?? 0.25;
  const capture = new Set<number>();
  const canvas = {
    style: { cursor: "" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    setPointerCapture: (pointerId: number) => capture.add(pointerId),
    hasPointerCapture: (pointerId: number) => capture.has(pointerId),
    releasePointerCapture: (pointerId: number) => capture.delete(pointerId),
  } as unknown as HTMLCanvasElement;
  const draggingRef = ref<DraggingState | null>(null);
  const controllerGestureRef = ref<PianoRollControllerGesture | null>(null);
  const midiEventGestureRef = ref<PianoRollMidiEventGesture | null>(null);
  const localEventsRef = ref<MidiClipEventRow[] | null>(null);
  const setLocalEvents = vi.fn((events: MidiClipEventRow[] | null) => {
    localEventsRef.current = events;
  });
  const selectedControllerEventIndices = new Set<number>();
  const onControllerEventSelectionChange = vi.fn((indices: Set<number>) => {
    selectedControllerEventIndices.clear();
    for (const index of indices) selectedControllerEventIndices.add(index);
  });
  const onEventsChange = vi.fn();
  const snapBeat = (beat: number) => Math.max(0, Math.round(beat * 4) / 4);
  const xToBeat = (x: number) => (x - viewport.keyWidth) / viewport.pixelsPerBeat;
  const sourceBeatAt = (beat: number) => midiRegionSourceBeat(source, beat);
  const canvasRef = ref<HTMLCanvasElement | null>(canvas);
  const spatialIndex = ref(new SpatialNoteIndex(4, 12));
  const noOp = vi.fn();
  const setLocalNotes = vi.fn();
  const setControllerPreview = vi.fn();
  const pendingCommitRef = ref(null as unknown as MidiRegionRow["notes"] | null);
  const velocityPaintRef = ref<PianoRollVelocityPaintState | null>(null);
  const localAutomationLanesRef = ref(null);
  const pendingAutomationCommitRef = ref<PianoRollPendingAutomationCommit | null>(null);
  const lastDragDetentRef = ref<string | null>(null);

  const pointerDown = createPianoRollPointerDownHandler({
    canvasRef,
    lastPointerPosRef: ref({ clientX: 0, clientY: 0 }),
    draggingRef,
    pendingCommitRef,
    velocityPaintRef,
    localAutomationLanesRef,
    controllerGestureRef,
    midiEventGestureRef,
    lastDragDetentRef,
    lastSingleSelectedDurationRef: ref(null),
    isFollowSuspendedRef: ref(false),
    spatialIndex,
    viewport,
    region: source,
    bottomLane,
    controllerLaneMode: "events",
    notesToRender: source.notes,
    selectedNoteIds: new Set(),
    selectedControllerEventIndices,
    onControllerEventSelectionChange,
    tool,
    snap,
    snapToScale: false,
    rootNote: 0,
    scaleMode: "chromatic",
    catchOnSeek: true,
    xToBeat,
    yToPitch: () => 60,
    snapBeat,
    sourceBeatAt,
    setLocalNotes,
    setHoveredPitch: noOp,
    setControllerPreview,
    setLocalEvents,
    onSeek: noOp,
    onSelectionChange: noOp,
    onNotesChange: noOp,
    onRegionChange: noOp,
    onEventsChange,
    startAutoScroll: noOp,
  });

  const pointerMove = createPianoRollPointerMoveHandler({
    canvasRef,
    lastPointerPosRef: ref({ clientX: 0, clientY: 0 }),
    draggingRef,
    pendingCommitRef,
    velocityPaintRef,
    controllerGestureRef,
    midiEventGestureRef,
    lastDragDetentRef,
    spatialIndex,
    viewport,
    region: source,
    bottomLane,
    controllerLaneMode: "events",
    notesToRender: source.notes,
    tool,
    snap,
    snapToScale: false,
    rootNote: 0,
    scaleMode: "chromatic",
    xToBeat,
    yToPitch: () => 60,
    snapBeat,
    sourceBeatAt,
    setLocalNotes,
    setControllerPreview,
    setLocalEvents,
    onSelectionChange: noOp,
    onControllerEventSelectionChange,
    onSeek: noOp,
    onRegionChange: noOp,
    onEventsChange,
    render: noOp,
  });

  const pointerEnd = createPianoRollPointerEndHandlers({
    canvasRef,
    draggingRef,
    pendingCommitRef,
    pendingAutomationCommitRef,
    controllerGestureRef,
    midiEventGestureRef,
    localEventsRef,
    localAutomationLanesRef,
    velocityPaintRef,
    lastDragDetentRef,
    localNotes: null,
    notesToRender: source.notes,
    region: source,
    viewport,
    bottomLane,
    controllerLaneMode: "events",
    spatialIndex,
    stopAutoScroll: noOp,
    render: noOp,
    sourceBeatAt,
    xToBeat,
    setLocalNotes,
    setHoveredPitch: noOp,
    setControllerPreview,
    setLocalEvents,
    onNotesChange: noOp,
    onSelectionChange: noOp,
    onRegionChange: noOp,
    onEventsChange,
  });
  return {
    pointerDown, pointerMove, pointerEnd, onEventsChange, localEventsRef, draggingRef,
    midiEventGestureRef, selectedControllerEventIndices, onControllerEventSelectionChange,
  };
}

function pointer(clientX: number, clientY: number, pointerId = 1, shiftKey = false) {
  return {
    button: 0,
    pointerId,
    clientX,
    clientY,
    metaKey: false,
    ctrlKey: false,
    shiftKey,
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
  } as unknown as ReactPointerEvent<HTMLCanvasElement>;
}

describe("Piano Roll raw MIDI event gestures", () => {
  it("creates a channel event on an empty lane and commits it as MIDI data", () => {
    const h = harness(region());
    h.pointerDown(pointer(214, 350));
    expect(h.draggingRef.current?.type).toBe("midiEvent");
    expect(h.localEventsRef.current).toHaveLength(1);

    h.pointerEnd.handlePointerUp(pointer(214, 350));
    expect(h.onEventsChange).toHaveBeenCalledOnce();
    const committed = h.onEventsChange.mock.calls[0][0];
    expect(committed[0].beat).toBe(2);
    expect(committed[0].status).toBe(0xb0);
    expect(committed[0].data[0]).toBe(74);
  });

  it("keeps a snapped event at the end of a looped region inside its visible range", () => {
    const source = region();
    source.loop = true;
    source.loopLengthBeats = 4;
    const h = harness(source);
    h.pointerDown(pointer(694, 350)); // beat 8, the exclusive region end
    h.pointerEnd.handlePointerUp(pointer(694, 350));

    expect(h.onEventsChange).toHaveBeenCalledOnce();
    expect(h.onEventsChange.mock.calls[0][0][0].beat).toBe(3.75);
  });

  it("paints an interpolated snapped controller line as one region transaction", () => {
    const h = harness(region(), { tool: "draw" });
    const startY = controllerYFromValue(32, 310, 400, false);
    const endY = controllerYFromValue(96, 310, 400, false);
    h.pointerDown(pointer(214, startY));
    expect(h.midiEventGestureRef.current?.painting).toBe(true);
    h.pointerMove(pointer(374, endY));
    h.pointerEnd.handlePointerUp(pointer(374, endY));

    expect(h.onEventsChange).toHaveBeenCalledOnce();
    const painted = h.onEventsChange.mock.calls[0][0] as MidiClipEventRow[];
    expect(painted.map((event) => event.beat)).toEqual([
      2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4,
    ]);
    expect(painted.every((event) => event.status === 0xb0 && event.data[0] === 74)).toBe(true);
    expect(painted[0].data[1]).toBe(32);
    expect(painted.at(-1)?.data[1]).toBe(96);
    expect(h.selectedControllerEventIndices.size).toBe(painted.length);
  });

  it("maps a painted loop-wrap back to source beats without duplicate events", () => {
    const source = region();
    source.loop = true;
    source.loopStartBeats = 2;
    source.loopLengthBeats = 2;
    source.clipOffsetBeats = 2;
    const h = harness(source, { tool: "draw" });
    h.pointerDown(pointer(134, controllerYFromValue(20, 310, 400, false)));
    h.pointerMove(pointer(294, controllerYFromValue(100, 310, 400, false)));
    h.pointerEnd.handlePointerUp(pointer(294, controllerYFromValue(100, 310, 400, false)));

    expect(h.onEventsChange).toHaveBeenCalledOnce();
    const painted = h.onEventsChange.mock.calls[0][0] as MidiClipEventRow[];
    expect(painted).toHaveLength(8);
    expect(painted.map((event) => event.beat).sort((left, right) => left - right))
      .toEqual([2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75]);
    expect(painted.every((event) => event.beat >= 2 && event.beat < 4)).toBe(true);
  });

  it("cancels a freehand controller paint without committing its draft", () => {
    const h = harness(region(), { tool: "draw" });
    h.pointerDown(pointer(214, controllerYFromValue(32, 310, 400, false)));
    h.pointerMove(pointer(374, controllerYFromValue(96, 310, 400, false)));
    expect(h.localEventsRef.current).toHaveLength(9);

    h.pointerEnd.handlePointerCancel(pointer(374, 333));
    expect(h.onEventsChange).not.toHaveBeenCalled();
    expect(h.localEventsRef.current).toBeNull();
  });

  it("moves and changes the source event while preserving its channel", () => {
    const source = region([{ beat: 2, status: 0xb3, data: [74, 64] }]);
    const h = harness(source);
    const startY = controllerYFromValue(64, 310, 400, false);
    h.pointerDown(pointer(214, startY));
    expect(h.draggingRef.current?.type).toBe("midiEvent");
    h.pointerMove(pointer(294, controllerYFromValue(110, 310, 400, false)));
    h.pointerEnd.handlePointerUp(pointer(294, controllerYFromValue(110, 310, 400, false)));

    expect(h.onEventsChange).toHaveBeenCalledOnce();
    expect(h.onEventsChange.mock.calls[0][0]).toEqual([
      { beat: 3, status: 0xb3, data: [74, 110] },
    ]);
  });

  it("shift-selects and rigidly moves multiple events without changing their spacing", () => {
    const source = region([
      { beat: 2, status: 0xb2, data: [74, 30] },
      { beat: 4, status: 0xb3, data: [74, 90] },
    ]);
    const h = harness(source);
    const firstY = controllerYFromValue(30, 310, 400, false);
    const secondY = controllerYFromValue(90, 310, 400, false);
    h.pointerDown(pointer(214, firstY, 1, true));
    h.pointerDown(pointer(374, secondY, 2, true));
    expect([...h.selectedControllerEventIndices]).toEqual([0, 1]);

    h.pointerDown(pointer(214, firstY, 3));
    expect(h.draggingRef.current?.type).toBe("midiEvent");
    h.pointerMove(pointer(234, controllerYFromValue(40, 310, 400, false), 3));
    h.pointerEnd.handlePointerUp(pointer(234, controllerYFromValue(40, 310, 400, false), 3));

    expect(h.onEventsChange).toHaveBeenCalledOnce();
    expect(h.onEventsChange.mock.calls[0][0]).toEqual([
      { beat: 2.25, status: 0xb2, data: [74, 40] },
      { beat: 4.25, status: 0xb3, data: [74, 100] },
    ]);
  });

  it("double-click deletes only the event under the cursor", () => {
    const source = region([
      { beat: 2, status: 0xb2, data: [74, 64] },
      { beat: 4, status: 0x92, data: [60, 100] },
    ]);
    const h = harness(source);
    const y = controllerYFromValue(64, 310, 400, false);
    h.pointerEnd.handleDoubleClick({
      clientX: 214,
      clientY: y,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as ReactMouseEvent<HTMLCanvasElement>);

    expect(h.onEventsChange).toHaveBeenCalledOnce();
    expect(h.onEventsChange.mock.calls[0][0]).toEqual([source.events![1]]);
  });
});
