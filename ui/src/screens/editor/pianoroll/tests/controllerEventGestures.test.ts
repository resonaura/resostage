/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/interaction/haptics", () => ({ triggerHaptic: vi.fn() }));
import type { MidiClipEventRow, MidiRegionRow, MidiUmpEventRow } from "@/lib/state/types";
import { midiRegionSourceBeat } from "@/lib/midi/midiRegionTiming";
import { createPianoRollPointerDownHandler } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerDownHandler";
import { createPianoRollPointerMoveHandler } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerMoveHandler";
import { createPianoRollPointerEndHandlers } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerEndHandlers";
import { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";
import { controllerYFromValue } from "@/screens/editor/pianoroll/logic/canvasUtils";
import { MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS } from "@/screens/editor/pianoroll/logic/umpControllerLane";
import {
  pianoRollUmpValueFromDisplayValue,
  pianoRollUmpValueFromY,
} from "@/screens/editor/pianoroll/logic/umpControllerEditing";
import type {
  DraggingState,
  PianoRollControllerGesture,
  PianoRollMidiEventGesture,
  PianoRollUmpControllerGesture,
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

function umpCc(
  beat: number,
  controller: number,
  value: number,
  group = 0,
  channel = 0,
): MidiUmpEventRow {
  return {
    beat,
    wordCount: 2,
    words: [((0x4 << 28) | (group << 24) | (0x0b << 20)
      | (channel << 16) | (controller << 8)) >>> 0, value >>> 0],
  };
}

function harness(
  source: MidiRegionRow,
  options: {
    tool?: PianoRollTool;
    bottomLane?: PianoRollBottomLane;
    snap?: GridSnapValue;
    umpGroupFilter?: number | null;
    umpChannelFilter?: number | null;
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
  const umpControllerGestureRef = ref<PianoRollUmpControllerGesture | null>(null);
  const localEventsRef = ref<MidiClipEventRow[] | null>(null);
  const setLocalEvents = vi.fn((events: MidiClipEventRow[] | null) => {
    localEventsRef.current = events;
  });
  const localUmpEventsRef = ref<MidiUmpEventRow[] | null>(null);
  const setLocalUmpEvents = vi.fn((events: MidiUmpEventRow[] | null) => {
    localUmpEventsRef.current = events;
  });
  const selectedControllerEventIndices = new Set<number>();
  const onControllerEventSelectionChange = vi.fn((indices: Set<number>) => {
    selectedControllerEventIndices.clear();
    for (const index of indices) selectedControllerEventIndices.add(index);
  });
  const selectedUmpControllerEventIndices = new Set<number>();
  const onUmpControllerEventSelectionChange = vi.fn((indices: Set<number>) => {
    selectedUmpControllerEventIndices.clear();
    for (const index of indices) selectedUmpControllerEventIndices.add(index);
  });
  const onEventsChange = vi.fn();
  const onUmpEventsChange = vi.fn();
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
    umpControllerGestureRef,
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
    selectedUmpControllerEventIndices,
    onUmpControllerEventSelectionChange,
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
    setLocalUmpEvents,
    onSeek: noOp,
    onSelectionChange: noOp,
    onNotesChange: noOp,
    onRegionChange: noOp,
    onEventsChange,
    onUmpEventsChange,
    umpGroupFilter: options.umpGroupFilter,
    umpChannelFilter: options.umpChannelFilter,
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
    umpControllerGestureRef,
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
    setLocalUmpEvents,
    onSelectionChange: noOp,
    onControllerEventSelectionChange,
    onSeek: noOp,
    onRegionChange: noOp,
    onEventsChange,
    onUmpEventsChange,
    render: noOp,
  });

  const pointerEnd = createPianoRollPointerEndHandlers({
    canvasRef,
    draggingRef,
    pendingCommitRef,
    pendingAutomationCommitRef,
    controllerGestureRef,
    midiEventGestureRef,
    umpControllerGestureRef,
    localEventsRef,
    setLocalUmpEvents,
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
    onUmpEventsChange,
    umpGroupFilter: options.umpGroupFilter,
    umpChannelFilter: options.umpChannelFilter,
    onUmpControllerEventSelectionChange,
  });
  return {
    pointerDown, pointerMove, pointerEnd, onEventsChange, onUmpEventsChange,
    localEventsRef, localUmpEventsRef, draggingRef, midiEventGestureRef, umpControllerGestureRef,
    selectedControllerEventIndices, onControllerEventSelectionChange,
    selectedUmpControllerEventIndices, onUmpControllerEventSelectionChange,
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

  it("draws a 32-bit UMP point with the selected group/channel and commits once", () => {
    const source = region();
    const opaque: MidiUmpEventRow = { beat: 0.5, wordCount: 1, words: [0x1000_0000] };
    source.umpEvents = [opaque];
    const h = harness(source, {
      tool: "draw", bottomLane: "umpCc74", umpGroupFilter: 3, umpChannelFilter: 7,
    });
    const y = controllerYFromValue(127, 310, 400, false);
    h.pointerDown(pointer(214, y));
    expect(h.draggingRef.current?.type).toBe("umpEvent");
    expect(h.localUmpEventsRef.current).toHaveLength(2);

    h.pointerEnd.handlePointerUp(pointer(214, y));
    expect(h.onUmpEventsChange).toHaveBeenCalledOnce();
    const committed = h.onUmpEventsChange.mock.calls[0][0] as MidiUmpEventRow[];
    expect(committed[0]).toEqual(opaque);
    expect(committed[1]).toEqual({
      beat: 2,
      wordCount: 2,
      words: [((0x4 << 28) | (3 << 24) | (0x0b << 20)
        | (7 << 16) | (74 << 8)) >>> 0, 0xffff_ffff],
    });
  });

  it("moves a newly drawn UMP point before committing its first draft", () => {
    const h = harness(region(), { tool: "draw", bottomLane: "umpCc74", snap: 0 });
    const startY = controllerYFromValue(32, 310, 400, false);
    const endY = controllerYFromValue(96, 310, 400, false);
    h.pointerDown(pointer(214, startY));
    h.pointerMove(pointer(294, endY));
    h.pointerEnd.handlePointerUp(pointer(294, endY));

    expect(h.onUmpEventsChange).toHaveBeenCalledOnce();
    const [created] = h.onUmpEventsChange.mock.calls[0][0] as MidiUmpEventRow[];
    expect(created.beat).toBe(3);
    expect(created.words[1]).toBe(pianoRollUmpValueFromY(endY, 310, 400));
  });

  it("rejects oversized UMP collections before copying the source packets", () => {
    const source = region();
    const event = umpCc(1, 74, 0x8000_0000);
    source.umpEvents = Array(MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS + 1).fill(event);
    const map = vi.spyOn(source.umpEvents, "map");
    const h = harness(source, { bottomLane: "umpCc74" });
    h.pointerDown(pointer(214, controllerYFromValue(64, 310, 400, false)));

    expect(map).not.toHaveBeenCalled();
    expect(h.draggingRef.current).toBeNull();
    expect(h.onUmpEventsChange).not.toHaveBeenCalled();
  });

  it("preserves all 32-bit value bits when a point is moved only in time", () => {
    const original = umpCc(2, 74, 0x8123_4567);
    const source = region();
    source.umpEvents = [original];
    const displayValue = Math.round(original.words[1] / 0xffff_ffff * 127);
    const y = controllerYFromValue(displayValue, 310, 400, false);
    const h = harness(source, { bottomLane: "umpCc74" });
    h.pointerDown(pointer(214, y));
    h.pointerMove(pointer(294, y));
    h.pointerEnd.handlePointerUp(pointer(294, y));

    const [edited] = h.onUmpEventsChange.mock.calls[0][0] as MidiUmpEventRow[];
    expect(edited.beat).toBe(3);
    expect(edited.words[1]).toBe(original.words[1]);
  });

  it("does not commit a UMP edit when the pointer returns to the source state", () => {
    const source = region();
    source.umpEvents = [umpCc(2, 74, 0x8123_4567)];
    const displayValue = Math.round(source.umpEvents[0].words[1] / 0xffff_ffff * 127);
    const startY = controllerYFromValue(displayValue, 310, 400, false);
    const h = harness(source, { bottomLane: "umpCc74" });
    h.pointerDown(pointer(214, startY));
    h.pointerMove(pointer(294, controllerYFromValue(100, 310, 400, false)));
    h.pointerMove(pointer(214, startY));
    h.pointerEnd.handlePointerUp(pointer(214, startY));

    expect(h.onUmpEventsChange).not.toHaveBeenCalled();
  });

  it("drags selected UMP points in source time and changes only their 32-bit values", () => {
    const source = region();
    const original = umpCc(2, 74, 0x8000_0000, 4, 11);
    original.words.push(0xaabb_ccdd);
    const opaque: MidiUmpEventRow = { beat: 3, wordCount: 1, words: [0x1000_0000] };
    source.umpEvents = [original, opaque];
    const h = harness(source, { bottomLane: "umpCc74", umpGroupFilter: 4, umpChannelFilter: 11 });
    const startY = controllerYFromValue(64, 310, 400, false);
    const endY = controllerYFromValue(100, 310, 400, false);
    h.pointerDown(pointer(214, startY));
    h.pointerMove(pointer(294, endY));
    h.pointerEnd.handlePointerUp(pointer(294, endY));

    expect(h.onUmpEventsChange).toHaveBeenCalledOnce();
    const edited = h.onUmpEventsChange.mock.calls[0][0] as MidiUmpEventRow[];
    expect(edited[0]).toEqual({
      ...original,
      beat: 3,
      words: [original.words[0], Math.min(0xffff_ffff,
        original.words[1] + pianoRollUmpValueFromY(endY, 310, 400)
          - pianoRollUmpValueFromY(startY, 310, 400)), 0xaabb_ccdd],
    });
    expect(edited[1]).toEqual(opaque);
  });

  it("moves a multi-selection rigidly while retaining each packet group and channel", () => {
    const source = region();
    source.umpEvents = [
      umpCc(2, 74, pianoRollUmpValueFromDisplayValue("umpCc74", 32)!, 1, 3),
      umpCc(4, 74, pianoRollUmpValueFromDisplayValue("umpCc74", 96)!, 2, 9),
    ];
    const h = harness(source, { bottomLane: "umpCc74" });
    const firstY = controllerYFromValue(32, 310, 400, false);
    const secondY = controllerYFromValue(96, 310, 400, false);
    h.pointerDown(pointer(214, firstY, 1, true));
    h.pointerDown(pointer(374, secondY, 2, true));
    expect([...h.selectedUmpControllerEventIndices]).toEqual([0, 1]);

    h.pointerDown(pointer(214, firstY, 3));
    h.pointerMove(pointer(234, controllerYFromValue(40, 310, 400, false), 3));
    h.pointerEnd.handlePointerUp(pointer(234, controllerYFromValue(40, 310, 400, false), 3));

    const moved = h.onUmpEventsChange.mock.calls[0][0] as MidiUmpEventRow[];
    expect(moved.map((event) => event.beat)).toEqual([2.25, 4.25]);
    expect(moved.map((event) => event.words[0])).toEqual(source.umpEvents?.map((event) => event.words[0]));
    const valueDelta = pianoRollUmpValueFromY(controllerYFromValue(40, 310, 400, false), 310, 400)
      - pianoRollUmpValueFromY(firstY, 310, 400);
    expect(moved.map((event) => event.words[1])).toEqual([
      source.umpEvents![0].words[1] + valueDelta,
      source.umpEvents![1].words[1] + valueDelta,
    ]);
  });

  it("maps a UMP point drag on a loop occurrence back to its source beat", () => {
    const source = region();
    source.loop = true;
    source.loopStartBeats = 4;
    source.loopLengthBeats = 2;
    source.clipOffsetBeats = 4;
    source.umpEvents = [umpCc(4.25, 74, pianoRollUmpValueFromDisplayValue("umpCc74", 64)!)];
    const h = harness(source, { bottomLane: "umpCc74", snap: 0 });
    const y = controllerYFromValue(64, 310, 400, false);
    h.pointerDown(pointer(74, y));
    h.pointerMove(pointer(94, controllerYFromValue(80, 310, 400, false)));
    h.pointerEnd.handlePointerUp(pointer(94, controllerYFromValue(80, 310, 400, false)));

    const edited = h.onUmpEventsChange.mock.calls[0][0] as MidiUmpEventRow[];
    expect(edited[0].beat).toBe(4.5);
    expect(edited[0].words[1]).toBe(source.umpEvents![0].words[1]
      + pianoRollUmpValueFromY(controllerYFromValue(80, 310, 400, false), 310, 400)
      - pianoRollUmpValueFromY(y, 310, 400));
  });

  it("supports modifier selection, erase, and double-click removal for UMP points", () => {
    const source = region();
    const first = umpCc(2, 74, 0x8000_0000, 1, 2);
    const second = umpCc(4, 74, 0x4000_0000, 1, 2);
    const opaque: MidiUmpEventRow = { beat: 5, wordCount: 1, words: [0x1000_0000] };
    source.umpEvents = [first, second, opaque];
    const h = harness(source, { bottomLane: "umpCc74" });
    h.pointerDown(pointer(214, controllerYFromValue(64, 310, 400, false), 1, true));
    h.pointerDown(pointer(374, controllerYFromValue(32, 310, 400, false), 2, true));
    expect([...h.selectedUmpControllerEventIndices]).toEqual([0, 1]);

    h.pointerEnd.handleDoubleClick({
      clientX: 214,
      clientY: controllerYFromValue(64, 310, 400, false),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as ReactMouseEvent<HTMLCanvasElement>);
    expect(h.onUmpEventsChange).toHaveBeenCalledOnce();
    expect(h.onUmpEventsChange.mock.calls[0][0]).toEqual([second, opaque]);

    const erase = harness(source, { tool: "erase", bottomLane: "umpCc74" });
    erase.pointerDown(pointer(214, controllerYFromValue(64, 310, 400, false)));
    expect(erase.onUmpEventsChange).toHaveBeenCalledOnce();
    expect(erase.onUmpEventsChange.mock.calls[0][0]).toEqual([second, opaque]);
  });

  it("cancels a direct UMP gesture without committing the local packet draft", () => {
    const source = region();
    source.umpEvents = [umpCc(2, 74, 0x8000_0000)];
    const h = harness(source, { bottomLane: "umpCc74" });
    const startY = controllerYFromValue(64, 310, 400, false);
    const endY = controllerYFromValue(100, 310, 400, false);
    h.pointerDown(pointer(214, startY));
    h.pointerMove(pointer(294, endY));
    expect(h.localUmpEventsRef.current?.[0].beat).toBe(3);
    h.pointerEnd.handlePointerCancel(pointer(294, endY));
    expect(h.onUmpEventsChange).not.toHaveBeenCalled();
    expect(h.localUmpEventsRef.current).toBeNull();
  });
});
