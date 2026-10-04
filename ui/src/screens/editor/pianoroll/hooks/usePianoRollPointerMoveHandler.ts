/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { PointerEvent as ReactPointerEvent } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { RULER_HEIGHT } from "@/screens/editor/timeline/ruler/logic/constants";
import { triggerHaptic } from "@/lib/interaction/haptics";
import type { AutomationLaneRow, MidiClipEventRow, MidiNoteRow, MidiRegionRow, MidiUmpEventRow } from "@/lib/state/types";
import {
  editControllerPoint,
  resolveDrawNoteDuration,
} from "@/screens/editor/pianoroll/logic/pianoRollModel";
import { snapPitchToScale } from "@/screens/editor/pianoroll/logic/scales";
import type { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";
import { controllerValueFromY } from "@/screens/editor/pianoroll/logic/canvasUtils";
import {
  clampControllerDisplayBeat,
  editControllerEvent,
  MAX_CONTROLLER_PAINT_EVENTS_PER_GESTURE,
  MAX_EDITABLE_CONTROLLER_EVENTS,
  moveControllerEvents,
  paintControllerEventPoints,
  sampleControllerPaintSegment,
} from "@/screens/editor/pianoroll/logic/controllerLane";
import {
  editPianoRollUmpControllerPoints,
  pianoRollUmpValueFromY,
} from "@/screens/editor/pianoroll/logic/umpControllerEditing";
import {
  samePianoRollUmpControllerSelection,
  selectPianoRollUmpMarqueeCandidates,
} from "@/screens/editor/pianoroll/logic/umpControllerMarquee";
import {
  boundedNoteMove,
  boundedNoteResize,
  findNotesInMarquee,
  marqueeSelection,
  sweepBrushNotes,
} from "@/screens/editor/pianoroll/logic/gestures";
import type {
  DraggingState,
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollControllerGesture,
  PianoRollMidiEventGesture,
  PianoRollUmpControllerGesture,
  PianoRollControllerLaneMode,
  PianoRollTool,
  PianoRollViewport,
  PianoRollVelocityPaintState,
  ScaleMode,
} from "@/screens/editor/pianoroll/logic/types";

interface PianoRollPointerMoveHandlerOptions {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  lastPointerPosRef: MutableRefObject<{ clientX: number; clientY: number }>;
  draggingRef: MutableRefObject<DraggingState | null>;
  pendingCommitRef: MutableRefObject<MidiNoteRow[] | null>;
  velocityPaintRef: MutableRefObject<PianoRollVelocityPaintState | null>;
  controllerGestureRef: MutableRefObject<PianoRollControllerGesture | null>;
  midiEventGestureRef: MutableRefObject<PianoRollMidiEventGesture | null>;
  umpControllerGestureRef: MutableRefObject<PianoRollUmpControllerGesture | null>;
  lastDragDetentRef: MutableRefObject<string | null>;
  spatialIndex: MutableRefObject<SpatialNoteIndex>;
  viewport: PianoRollViewport;
  region: MidiRegionRow;
  bottomLane: PianoRollBottomLane;
  controllerLaneMode: PianoRollControllerLaneMode;
  notesToRender: MidiNoteRow[];
  tool: PianoRollTool;
  snap: GridSnapValue;
  snapToScale: boolean;
  rootNote: number;
  scaleMode: ScaleMode;
  xToBeat: (x: number) => number;
  yToPitch: (y: number, height: number) => number;
  snapBeat: (beat: number) => number;
  sourceBeatAt: (beat: number) => number;
  setLocalNotes: Dispatch<SetStateAction<MidiNoteRow[] | null>>;
  setControllerPreview: (lanes: AutomationLaneRow[] | null) => void;
  setLocalEvents: (events: MidiClipEventRow[] | null) => void;
  setLocalUmpEvents: (events: MidiUmpEventRow[] | null) => void;
  onSelectionChange: (ids: Set<number>) => void;
  onControllerEventSelectionChange: (indices: Set<number>) => void;
  onUmpControllerEventSelectionChange: (indices: Set<number>) => void;
  onSeek?: (beats: number) => void;
  onRegionChange?: (region: MidiRegionRow) => void;
  onEventsChange?: (events: MidiClipEventRow[]) => void | Promise<void>;
  onUmpEventsChange?: (events: MidiUmpEventRow[]) => void | Promise<void>;
  render: () => void;
}

/** Updates the active Piano Roll drag, hover cursor, and local preview state. */
export function createPianoRollPointerMoveHandler({
  canvasRef,
  lastPointerPosRef,
  draggingRef,
  pendingCommitRef,
  velocityPaintRef,
  controllerGestureRef,
  midiEventGestureRef,
  umpControllerGestureRef,
  lastDragDetentRef,
  spatialIndex,
  viewport,
  region,
  bottomLane,
  controllerLaneMode,
  notesToRender,
  tool,
  snap,
  snapToScale,
  rootNote,
  scaleMode,
  xToBeat,
  yToPitch,
  snapBeat,
  sourceBeatAt,
  setLocalNotes,
  setControllerPreview,
  setLocalEvents,
  setLocalUmpEvents,
  onSelectionChange,
  onControllerEventSelectionChange,
  onUmpControllerEventSelectionChange,
  onSeek,
  onRegionChange,
  onEventsChange,
  onUmpEventsChange,
  render,
}: PianoRollPointerMoveHandlerOptions) {
  // ── Pointer Move Interaction ───────────────────────────────────────────
  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;

    lastPointerPosRef.current = { clientX: e.clientX, clientY: e.clientY };

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const height = rect.height;
    const gridBottom = height - viewport.velocityLaneHeight;
    const dragging = draggingRef.current;

    // Hover cursor styling when not dragging
    if (!dragging) {
      if (y < RULER_HEIGHT && x >= viewport.keyWidth) {
        canvas.style.cursor = "col-resize";
      } else if (x < viewport.keyWidth) {
        canvas.style.cursor = "pointer";
      } else if (y >= gridBottom) {
        canvas.style.cursor = "crosshair";
      } else {
        const beat = sourceBeatAt(xToBeat(x));
        const pitch = yToPitch(y, height);
        const handleTol = Math.max(0.08, 8 / viewport.pixelsPerBeat);
        const pointTol = 4 / viewport.pixelsPerBeat;
        const hit = spatialIndex.current.hitTest(beat, pitch, handleTol, pointTol);
        if (hit) {
          canvas.style.cursor = hit.isResizeHandle ? "ew-resize" : "grab";
        } else {
          canvas.style.cursor =
            tool === "draw" || tool === "brush"
              ? "crosshair"
              : tool === "slice"
                ? "vertical-text"
                : "default";
        }
      }
      return;
    }

    // ── Dragging: Playhead Scrub ─────────────────────────────────────────
    if (dragging.type === "playhead") {
      canvas.style.cursor = "col-resize";
      const beat = Math.max(0, xToBeat(x));
      const targetBeat = snap > 0 && !e.shiftKey ? snapBeat(beat) : beat;
      if (onSeek) onSeek(targetBeat);
      return;
    }

    if (dragging.type === "umpMarquee" && dragging.umpMarqueeBox) {
      const box = dragging.umpMarqueeBox;
      box.currentX = x;
      box.currentY = y;
      const selection = selectPianoRollUmpMarqueeCandidates(
        box.candidates,
        box.startX,
        box.startY,
        box.currentX,
        box.currentY,
        dragging.additiveSelection,
      );
      if (!samePianoRollUmpControllerSelection(box.currentSelection, selection)) {
        box.currentSelection = selection;
        onUmpControllerEventSelectionChange(selection);
      }
      canvas.style.cursor = "crosshair";
      render();
      return;
    }

    // ── Dragging: Velocity ───────────────────────────────────────────────
    if (dragging.type === "velocity") {
      const vel = Math.max(
        0.01,
        Math.min(1.0, (height - y) / (viewport.velocityLaneHeight - 20)),
      );
      const beat = sourceBeatAt(xToBeat(x));
      const paint = velocityPaintRef.current;
      if (paint) {
        // Sweep the interval, not just the current pointer sample: fast mouse
        // movement must not skip notes between two pointer events.
        const tolerance = Math.max(0.08, 8 / viewport.pixelsPerBeat);
        const lo = Math.min(paint.lastBeat, beat) - tolerance;
        const hi = Math.max(paint.lastBeat, beat) + tolerance;
        let changed = false;
        for (const candidate of spatialIndex.current.queryRange(lo, hi, 0, 127)) {
          const note = paint.noteById.get(candidate.id);
          if (!note) continue;
          if (note.startBeats >= lo && note.startBeats <= hi && note.velocity !== vel) {
            note.velocity = vel;
            changed = true;
          }
        }
        paint.lastBeat = beat;
        if (changed) setLocalNotes(paint.notes.map((note) => ({ ...note })));
      }
      return;
    }

    // ── Dragging: MIDI 2.0 UMP Controller Points ─────────────────────────
    if (dragging.type === "umpEvent" && controllerLaneMode === "events"
        && onUmpEventsChange) {
      const gesture = umpControllerGestureRef.current;
      if (!gesture) return;
      const displayBeat = clampControllerDisplayBeat(
        xToBeat(x), region.durationBeats, snap,
      );
      const pointerValue = pianoRollUmpValueFromY(y, gridBottom, height);
      const deltaBeat = displayBeat - gesture.anchorBeat;
      const deltaValue = pointerValue - gesture.anchorRawValue;
      const edits = gesture.selectedPoints.flatMap((point) => {
        const targetBeat = clampControllerDisplayBeat(
          point.displayBeat + deltaBeat, region.durationBeats, snap,
        );
        const value = Math.max(0, Math.min(0xffff_ffff, point.rawValue + deltaValue));
        return [{
          sourceIndex: point.sourceIndex,
          beat: sourceBeatAt(targetBeat),
          value,
        }];
      });
      // The latest draft is the source for the next move so a point created on
      // pointer-down can be dragged before it has an authoritative source index.
      const updated = editPianoRollUmpControllerPoints(gesture.latestEvents, edits);
      if (!updated) return;
      gesture.latestEvents = updated;
      // Only selected packets can change in this gesture. Compare those stable
      // source indexes instead of sorting the whole bounded collection at
      // pointer-event frequency.
      gesture.changed = updated.length !== gesture.beforeEvents.length
        || gesture.selectedPoints.some(({ sourceIndex }) => {
          const before = gesture.beforeEvents[sourceIndex];
          const after = updated[sourceIndex];
          return !before || !after || before.beat !== after.beat
            || before.words[1] !== after.words[1];
        });
      setLocalUmpEvents(updated);
      return;
    }

    // ── Dragging: Raw MIDI Controller Event ──────────────────────────────
    if (dragging.type === "midiEvent" && controllerLaneMode === "events" && onEventsChange) {
      const gesture = midiEventGestureRef.current;
      if (!gesture) return;
      const displayBeat = clampControllerDisplayBeat(
        xToBeat(x), region.durationBeats, snap,
      );
      const beat = sourceBeatAt(displayBeat);
      const value = controllerValueFromY(
        y, gridBottom, height, bottomLane === "pitchBend",
      );
      if (gesture.lastBeat === displayBeat && gesture.lastValue === value) return;
      if (gesture.painting) {
        const sampled = sampleControllerPaintSegment(
          gesture.lastBeat,
          displayBeat,
          gesture.lastValue,
          value,
          snap,
        );
        if (!sampled || sampled.length === 0) return;
        const points = sampled.map((point) => ({
          ...point,
          beat: sourceBeatAt(clampControllerDisplayBeat(
            point.beat, region.durationBeats, snap,
          )),
        }));
        const previousEvents = gesture.baseEvents;
        const painted = paintControllerEventPoints(
          previousEvents,
          bottomLane,
          gesture.channel,
          points,
          {
            maxEventCount: Math.min(
              MAX_EDITABLE_CONTROLLER_EVENTS,
              gesture.beforeEvents.length + MAX_CONTROLLER_PAINT_EVENTS_PER_GESTURE,
            ),
            maxTouchedEventCount: MAX_CONTROLLER_PAINT_EVENTS_PER_GESTURE,
            alreadyTouchedEventIndices: new Set(gesture.sourceEventIndices),
            sourceEventIndexByBeat: gesture.sourceEventIndexByBeat ?? undefined,
          },
        );
        if (!painted) return;
        gesture.sourceEventIndices = [...new Set([
          ...gesture.sourceEventIndices,
          ...painted.sourceEventIndices,
        ])];
        gesture.baseEvents = painted.events;
        gesture.lastBeat = displayBeat;
        gesture.lastValue = value;
        // A segment was accepted; the pointer-up path performs the single full
        // equality check before committing the one region-history transaction.
        gesture.changed = true;
        setLocalEvents(painted.events);
        onControllerEventSelectionChange(new Set(gesture.sourceEventIndices));
        return;
      }
      const updated = gesture.sourceEventIndices.length > 1
        ? moveControllerEvents(
          gesture.baseEvents,
          gesture.sourceEventIndices,
          bottomLane,
          region,
          displayBeat - gesture.anchorBeat,
          value - gesture.anchorValue,
        )
        : editControllerEvent(
          gesture.baseEvents,
          gesture.sourceEventIndex,
          bottomLane,
          beat,
          value,
        );
      if (!updated) return;
      gesture.lastBeat = displayBeat;
      gesture.lastValue = value;
      gesture.changed = true;
      setLocalEvents(updated);
      return;
    }

    if (dragging.type === "cc" && controllerLaneMode === "automation" && onRegionChange) {
      const gesture = controllerGestureRef.current;
      if (!gesture) return;
      const beat = Math.max(0, snapBeat(sourceBeatAt(xToBeat(x))));
      const value = controllerValueFromY(y, gridBottom, height, bottomLane === "pitchBend");
      if (gesture.lastBeat === beat && gesture.lastValue === value) return;
      gesture.lastBeat = beat;
      gesture.lastValue = value;

      const lane = gesture.baseLanes[gesture.laneIndex];
      const startedNewRamp = gesture.added &&
        Math.hypot(x - dragging.startPointerX, y - dragging.startPointerY) > 3 &&
        beat !== gesture.anchorBeat;
      const points = editControllerPoint(
        lane.points,
        startedNewRamp ? null : gesture.pointIndex,
        beat,
        value,
      );
      if (!points) return;
      gesture.changed = true;
      const lanes = [...gesture.baseLanes];
      lanes[gesture.laneIndex] = { ...lane, points };
      setControllerPreview(lanes);
      return;
    }

    // ── Dragging: Brush ──────────────────────────────────────────────────
    if (dragging.type === "brush") {
      const curBeat = snapBeat(sourceBeatAt(xToBeat(x)));
      let curPitch = yToPitch(y, height);
      if (snapToScale) {
        curPitch = snapPitchToScale(curPitch, rootNote, scaleMode);
      }
      const dur = snap > 0 ? snap : 0.25;
      const prevBeat = dragging.lastBeat ?? dragging.startBeat;
      const swept = sweepBrushNotes(notesToRender, prevBeat, curBeat, curPitch, dur);
      dragging.lastBeat = curBeat;
      if (swept) {
        setLocalNotes(swept.updatedNotes);
        pendingCommitRef.current = swept.updatedNotes;
        onSelectionChange(new Set(swept.addedNotes.map((n) => n.id)));
      }
      return;
    }

    // ── Dragging: Move Notes (Accurate, Non-Accumulating) ─────────────────
    if (dragging.type === "move") {
      canvas.style.cursor = "grabbing";
      const deltaBeats = xToBeat(x) - dragging.startBeat;
      // MIDI pitch increases upward; yToPitch already performs the inverse
      // screen transform, so subtracting here inverted vertical dragging.
      const deltaPitch = yToPitch(y, height) - dragging.startPitch;

      const snappedDeltaBeats =
        snap > 0 ? Math.round(deltaBeats / snap) * snap : deltaBeats;
      const boundedDelta = boundedNoteMove(
        dragging.initialNotesSnapshot.values(),
        snappedDeltaBeats,
        deltaPitch,
      );
      const anchorNote = dragging.initialNotesSnapshot
        .values()
        .next().value as MidiNoteRow | undefined;
      const pitchDetent = anchorNote ? anchorNote.pitch + deltaPitch : deltaPitch;
      const beatDetent = snap > 0 ? Math.round(snappedDeltaBeats / snap) : "free";
      const detent = `${beatDetent}:${pitchDetent}`;
      if (detent !== lastDragDetentRef.current) {
        if (lastDragDetentRef.current !== null) triggerHaptic("alignment");
        lastDragDetentRef.current = detent;
      }

      // Update local working state relative to initial snapshot
      const updated = notesToRender.map((note) => {
        if (!dragging.targetNoteIds?.has(note.id)) return note;
        const initial = dragging.initialNotesSnapshot.get(note.id);
        if (!initial) return note;
        const newBeat = initial.startBeats + boundedDelta.deltaBeats;
        const newPitch = initial.pitch + boundedDelta.deltaPitch;
        return { ...note, startBeats: newBeat, pitch: newPitch };
      });

      setLocalNotes(updated);
      render();
    } else if (dragging.type === "draw") {
      const pointerBeat = xToBeat(x);
      const initialNote = dragging.initialNotesSnapshot.values().next().value as MidiNoteRow | undefined;
      if (!initialNote) return;
      const duration = resolveDrawNoteDuration(
        dragging.startBeat,
        pointerBeat,
        snap,
        initialNote.durationBeats,
        3 / viewport.pixelsPerBeat,
      );
      const startBeat = sourceBeatAt(snapBeat(
        Math.max(0, Math.min(dragging.startBeat, pointerBeat)),
      ));
      const updated = notesToRender.map((note) =>
        dragging.targetNoteIds?.has(note.id)
          ? { ...note, startBeats: startBeat, durationBeats: duration }
          : note,
      );
      setLocalNotes(updated);
      render();
    } else if (dragging.type === "resize") {
      canvas.style.cursor = "ew-resize";
      const deltaBeats = xToBeat(x) - dragging.startBeat;
      const boundedDelta = boundedNoteResize(
        dragging.initialNotesSnapshot.values(),
        deltaBeats,
        snap,
      );
      const anchorNote = dragging.initialNotesSnapshot
        .values()
        .next().value as MidiNoteRow | undefined;
      if (anchorNote) {
        const duration = anchorNote.durationBeats + boundedDelta;
        const detent = snap > 0
          ? Math.round(duration / snap)
          : Math.round(duration * 100);
        const key = `resize:${detent}`;
        if (key !== lastDragDetentRef.current) {
          if (lastDragDetentRef.current !== null) triggerHaptic("alignment");
          lastDragDetentRef.current = key;
        }
      }

      const updated = notesToRender.map((note) => {
        if (!dragging.targetNoteIds?.has(note.id)) return note;
        const initial = dragging.initialNotesSnapshot.get(note.id);
        if (!initial) return note;
        return { ...note, durationBeats: initial.durationBeats + boundedDelta };
      });

      setLocalNotes(updated);
      render();
    } else if (dragging.type === "marquee" && dragging.marqueeBox) {
      const currentBeat = xToBeat(x);
      const currentPitch = yToPitch(y, height);
      dragging.marqueeBox.currentBeat = currentBeat;
      dragging.marqueeBox.currentPitch = currentPitch;

      const minB = Math.min(dragging.marqueeBox.startBeat, currentBeat);
      const maxB = Math.max(dragging.marqueeBox.startBeat, currentBeat);
      const minP = Math.min(dragging.marqueeBox.startPitch, currentPitch);
      const maxP = Math.max(dragging.marqueeBox.startPitch, currentPitch);

      const enclosedNotes = findNotesInMarquee(
        notesToRender,
        region,
        minB,
        maxB,
        minP,
        maxP,
      );
      onSelectionChange(marqueeSelection(
        enclosedNotes,
        dragging.additiveSelection,
      ));
      render();
    }
  };

  return handlePointerMove;
}
