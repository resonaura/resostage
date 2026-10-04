/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { PointerEvent as ReactPointerEvent } from "react";
import type { MutableRefObject } from "react";
import { RULER_HEIGHT } from "@/screens/editor/timeline/ruler/logic/constants";
import { triggerHaptic } from "@/lib/interaction/haptics";
import type { AutomationLaneRow, MidiClipEventRow, MidiNoteRow, MidiRegionRow, MidiUmpEventRow } from "@/lib/state/types";
import {
  editControllerPoint,
  generateNoteId,
  paintBrushNote,
  sliceNote,
} from "@/screens/editor/pianoroll/logic/pianoRollModel";
import {
  buildPianoRollControllerProjection,
  clampControllerDisplayBeat,
  collectControllerEventSourceIndices,
  createControllerEvent,
  defaultControllerChannel,
  indexControllerEventSourcesByBeat,
  MAX_EDITABLE_CONTROLLER_EVENTS,
} from "@/screens/editor/pianoroll/logic/controllerLane";
import {
  buildPianoRollUmpControllerProjection,
  isPianoRollUmpControllerLane,
  MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS,
} from "@/screens/editor/pianoroll/logic/umpControllerLane";
import {
  copyPianoRollUmpEvents,
  createPianoRollUmpControllerEvent,
  pianoRollUmpValueFromY,
  removePianoRollUmpControllerEvents,
} from "@/screens/editor/pianoroll/logic/umpControllerEditing";
import { snapPitchToScale } from "@/screens/editor/pianoroll/logic/scales";
import type { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";
import {
  controllerParameterId,
  controllerValueFromY,
  controllerYFromValue,
  DEFAULT_NOTE_VELOCITY,
  isControllerLane,
  isPrimaryModifier,
} from "@/screens/editor/pianoroll/logic/canvasUtils";
import type {
  DraggingState,
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollControllerGesture,
  PianoRollMidiEventGesture,
  PianoRollUmpControllerGesture,
  PianoRollUmpMarqueeCandidate,
  PianoRollControllerLaneMode,
  PianoRollTool,
  ScaleMode,
  PianoRollViewport,
  PianoRollVelocityPaintState,
} from "@/screens/editor/pianoroll/logic/types";

interface PianoRollPointerDownHandlerOptions {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  lastPointerPosRef: MutableRefObject<{ clientX: number; clientY: number }>;
  draggingRef: MutableRefObject<DraggingState | null>;
  pendingCommitRef: MutableRefObject<MidiNoteRow[] | null>;
  velocityPaintRef: MutableRefObject<PianoRollVelocityPaintState | null>;
  localAutomationLanesRef: MutableRefObject<AutomationLaneRow[] | null>;
  controllerGestureRef: MutableRefObject<PianoRollControllerGesture | null>;
  midiEventGestureRef: MutableRefObject<PianoRollMidiEventGesture | null>;
  umpControllerGestureRef: MutableRefObject<PianoRollUmpControllerGesture | null>;
  lastDragDetentRef: MutableRefObject<string | null>;
  lastSingleSelectedDurationRef: MutableRefObject<number | null>;
  isFollowSuspendedRef: MutableRefObject<boolean>;
  spatialIndex: MutableRefObject<SpatialNoteIndex>;
  viewport: PianoRollViewport;
  region: MidiRegionRow;
  bottomLane: PianoRollBottomLane;
  controllerLaneMode: PianoRollControllerLaneMode;
  notesToRender: MidiNoteRow[];
  selectedNoteIds: Set<number>;
  selectedControllerEventIndices: Set<number>;
  onControllerEventSelectionChange: (indices: Set<number>) => void;
  selectedUmpControllerEventIndices: Set<number>;
  onUmpControllerEventSelectionChange: (indices: Set<number>) => void;
  tool: PianoRollTool;
  snap: GridSnapValue;
  snapToScale: boolean;
  rootNote: number;
  scaleMode: ScaleMode;
  catchOnSeek: boolean;
  xToBeat: (x: number) => number;
  yToPitch: (y: number, height: number) => number;
  snapBeat: (beat: number) => number;
  sourceBeatAt: (beat: number) => number;
  setLocalNotes: (notes: MidiNoteRow[] | null) => void;
  setHoveredPitch: (pitch: number | null) => void;
  setControllerPreview: (lanes: AutomationLaneRow[] | null) => void;
  setLocalEvents: (events: MidiClipEventRow[] | null) => void;
  setLocalUmpEvents: (events: MidiUmpEventRow[] | null) => void;
  onSeek?: (beats: number) => void;
  onSelectionChange: (ids: Set<number>) => void;
  onNotesChange: (notes: MidiNoteRow[]) => void;
  onRegionChange?: (region: MidiRegionRow) => void;
  onEventsChange?: (events: MidiClipEventRow[]) => void | Promise<void>;
  onUmpEventsChange?: (events: MidiUmpEventRow[]) => void | Promise<void>;
  umpGroupFilter?: number | null;
  umpChannelFilter?: number | null;
  startAutoScroll: () => void;
}

/** Starts a Piano Roll gesture based on the clicked editor lane or note. */
export function createPianoRollPointerDownHandler({
  canvasRef,
  lastPointerPosRef,
  draggingRef,
  pendingCommitRef,
  velocityPaintRef,
  localAutomationLanesRef,
  controllerGestureRef,
  midiEventGestureRef,
  umpControllerGestureRef,
  lastDragDetentRef,
  lastSingleSelectedDurationRef,
  isFollowSuspendedRef,
  spatialIndex,
  viewport,
  region,
  bottomLane,
  controllerLaneMode,
  notesToRender,
  selectedNoteIds,
  selectedControllerEventIndices,
  onControllerEventSelectionChange,
  selectedUmpControllerEventIndices,
  onUmpControllerEventSelectionChange,
  tool,
  snap,
  snapToScale,
  rootNote,
  scaleMode,
  catchOnSeek,
  xToBeat,
  yToPitch,
  snapBeat,
  sourceBeatAt,
  setLocalNotes,
  setHoveredPitch,
  setControllerPreview,
  setLocalEvents,
  setLocalUmpEvents,
  onSeek,
  onSelectionChange,
  onNotesChange,
  onRegionChange,
  onEventsChange,
  onUmpEventsChange,
  umpGroupFilter = null,
  umpChannelFilter = null,
  startAutoScroll,
}: PianoRollPointerDownHandlerOptions) {
  // ── Pointer Down Interaction ───────────────────────────────────────────
  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    // Native context menus and trackpad/middle-button navigation must never
    // create notes or begin an edit capture.
    if (e.button !== 0) return;
    e.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const height = rect.height;
    const gridBottom = height - viewport.velocityLaneHeight;

    canvas.setPointerCapture(e.pointerId);
    lastPointerPosRef.current = { clientX: e.clientX, clientY: e.clientY };

    // ── A. Click in Ruler Header (Scrub Playhead) ─────────────────────────
    if (y < RULER_HEIGHT && x >= viewport.keyWidth) {
      const beat = Math.max(0, xToBeat(x));
      const targetBeat = snap > 0 && !e.shiftKey ? snapBeat(beat) : beat;
      if (onSeek) onSeek(targetBeat);
      if (catchOnSeek) isFollowSuspendedRef.current = false;

      draggingRef.current = {
        type: "playhead",
        startPointerX: x,
        startPointerY: y,
        startBeat: targetBeat,
        startPitch: 0,
        initialNotesSnapshot: new Map(),
      };
      return;
    }

    if (y < gridBottom && selectedControllerEventIndices.size > 0)
      onControllerEventSelectionChange(new Set());

    // ── B. Click in the Velocity, MIDI Event, or Automation lane ─────────
    if (y >= gridBottom) {
      if (bottomLane === "velocity") {
        const beat = sourceBeatAt(xToBeat(x));
        const hit = spatialIndex.current.hitTestStart(
          beat,
          Math.max(0.08, 8 / viewport.pixelsPerBeat),
        );
        const workingNotes = notesToRender.map((note) => ({ ...note }));
        if (hit) {
          const vel = Math.max(
            0.01,
            Math.min(1.0, (height - y) / (viewport.velocityLaneHeight - 20)),
          );
          const target = workingNotes.find((note) => note.id === hit.id);
          if (target) target.velocity = vel;
          setLocalNotes(workingNotes);
        }
        velocityPaintRef.current = {
          lastBeat: beat,
          notes: workingNotes,
          noteById: new Map(workingNotes.map((note) => [note.id, note])),
        };
        draggingRef.current = {
          type: "velocity",
          startPointerX: x,
          startPointerY: y,
          startBeat: beat,
          startPitch: 0,
          initialNotesSnapshot: new Map(region.notes.map((n) => [n.id, n])),
        };
      } else if (controllerLaneMode === "events") {
        if (isPianoRollUmpControllerLane(bottomLane)) {
          const sourceEvents = region.umpEvents ?? [];
          if (!onUmpEventsChange || x < viewport.keyWidth
              || sourceEvents.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS) {
            canvas.releasePointerCapture(e.pointerId);
            return;
          }
          const displayBeat = clampControllerDisplayBeat(
            xToBeat(x), region.durationBeats, snap,
          );
          const firstVisibleBeat = Math.max(0, xToBeat(viewport.keyWidth));
          const lastVisibleBeat = Math.min(region.durationBeats, xToBeat(rect.width));
          const projection = buildPianoRollUmpControllerProjection(
            region, bottomLane, firstVisibleBeat, lastVisibleBeat,
            umpGroupFilter, umpChannelFilter,
          );
          if (projection.truncated) {
            canvas.releasePointerCapture(e.pointerId);
            return;
          }
          const pitchBend = bottomLane === "umpPitchBend";
          let hit: typeof projection.events[number] | null = null;
          let nearestDistance = 8;
          for (const projected of projection.events) {
            const px = viewport.keyWidth
              + (projected.beat - viewport.scrollBeats) * viewport.pixelsPerBeat;
            const py = controllerYFromValue(projected.value, gridBottom, height, pitchBend);
            const distance = Math.hypot(px - x, py - y);
            if (distance <= nearestDistance) {
              nearestDistance = distance;
              hit = projected;
            }
          }

          const visibleIndices = new Set(projection.events.map((event) => event.sourceEventIndex));
          const currentSelection = new Set(
            [...selectedUmpControllerEventIndices].filter((index) => visibleIndices.has(index)),
          );
          onSelectionChange(new Set());
          onControllerEventSelectionChange(new Set());
          if (tool === "erase" && hit) {
            const removed = removePianoRollUmpControllerEvents(
              sourceEvents, [hit.sourceEventIndex],
            );
            if (removed) {
              onUmpControllerEventSelectionChange(new Set());
              void onUmpEventsChange(removed);
              triggerHaptic("generic");
            }
            canvas.releasePointerCapture(e.pointerId);
            return;
          }

          if (!hit && tool !== "draw") {
            if (tool === "select") {
              const additive = e.shiftKey || isPrimaryModifier(e);
              const candidates: PianoRollUmpMarqueeCandidate[] = projection.events.map((event) => ({
                sourceEventIndex: event.sourceEventIndex,
                x: viewport.keyWidth
                  + (event.beat - viewport.scrollBeats) * viewport.pixelsPerBeat,
                y: controllerYFromValue(event.value, gridBottom, height, pitchBend),
              }));
              const retainedSelection = additive ? currentSelection : new Set<number>();
              onUmpControllerEventSelectionChange(retainedSelection);
              draggingRef.current = {
                type: "umpMarquee",
                startPointerX: x,
                startPointerY: y,
                startBeat: displayBeat,
                startPitch: 0,
                additiveSelection: retainedSelection,
                initialNotesSnapshot: new Map(),
                umpMarqueeBox: {
                  startX: x,
                  startY: y,
                  currentX: x,
                  currentY: y,
                  candidates,
                  currentSelection: retainedSelection,
                },
              };
            } else {
              onUmpControllerEventSelectionChange(new Set());
            }
            if (tool !== "select") canvas.releasePointerCapture(e.pointerId);
            return;
          }

          if (hit && (e.shiftKey || isPrimaryModifier(e))) {
            if (currentSelection.has(hit.sourceEventIndex))
              currentSelection.delete(hit.sourceEventIndex);
            else currentSelection.add(hit.sourceEventIndex);
            onUmpControllerEventSelectionChange(currentSelection);
            canvas.releasePointerCapture(e.pointerId);
            return;
          }

          const beforeEvents = copyPianoRollUmpEvents(sourceEvents);
          let latestEvents = beforeEvents;
          let selectedPoints: PianoRollUmpControllerGesture["selectedPoints"] = [];
          let anchorBeat = displayBeat;
          const anchorValue = pianoRollUmpValueFromY(y, gridBottom, height);
          let changed = false;
          if (!hit) {
            latestEvents = createPianoRollUmpControllerEvent(
              beforeEvents,
              bottomLane,
              sourceBeatAt(displayBeat),
              anchorValue,
              umpGroupFilter ?? 0,
              umpChannelFilter ?? 0,
            ) ?? beforeEvents;
            if (latestEvents === beforeEvents) {
              canvas.releasePointerCapture(e.pointerId);
              return;
            }
            const sourceIndex = latestEvents.length - 1;
            selectedPoints = [{
              sourceIndex,
              displayBeat,
              rawValue: latestEvents[sourceIndex].words[1],
            }];
            onUmpControllerEventSelectionChange(new Set([sourceIndex]));
            setLocalUmpEvents(latestEvents);
            changed = true;
          } else {
            anchorBeat = displayBeat;
            const selection = currentSelection.has(hit.sourceEventIndex)
              ? currentSelection
              : new Set([hit.sourceEventIndex]);
            onUmpControllerEventSelectionChange(selection);
            const closestBySource = new Map<number, typeof hit>();
            for (const projected of projection.events) {
              if (!selection.has(projected.sourceEventIndex)) continue;
              const previous = closestBySource.get(projected.sourceEventIndex);
              if (!previous || Math.abs(projected.beat - hit.beat)
                  < Math.abs(previous.beat - hit.beat))
                closestBySource.set(projected.sourceEventIndex, projected);
            }
            selectedPoints = [...selection].flatMap((sourceIndex) => {
              const projected = closestBySource.get(sourceIndex);
              return projected ? [{
                sourceIndex,
                displayBeat: projected.beat,
                rawValue: beforeEvents[sourceIndex].words[1],
              }] : [];
            });
          }

          if (selectedPoints.length === 0) {
            canvas.releasePointerCapture(e.pointerId);
            return;
          }
          umpControllerGestureRef.current = {
            beforeEvents,
            latestEvents,
            selectedPoints,
            anchorBeat,
            anchorRawValue: anchorValue,
            changed,
          };
          draggingRef.current = {
            type: "umpEvent",
            startPointerX: x,
            startPointerY: y,
            startBeat: anchorBeat,
            startPitch: 0,
            initialNotesSnapshot: new Map(),
          };
          return;
        }
        if (!onEventsChange || x < viewport.keyWidth) {
          canvas.releasePointerCapture(e.pointerId);
          return;
        }
        const beforeEvents = (region.events ?? []).map((event) => ({
          ...event,
          data: [...event.data],
        }));
        if (beforeEvents.length > MAX_EDITABLE_CONTROLLER_EVENTS) {
          canvas.releasePointerCapture(e.pointerId);
          return;
        }
        const displayBeat = clampControllerDisplayBeat(
          xToBeat(x), region.durationBeats, snap,
        );
        const sourceBeat = sourceBeatAt(displayBeat);
        const isPB = bottomLane === "pitchBend";
        const value = controllerValueFromY(y, gridBottom, height, isPB);
        const projection = buildPianoRollControllerProjection(
          { ...region, events: beforeEvents }, bottomLane, 0, region.durationBeats,
        );
        if (projection.truncated) {
          canvas.releasePointerCapture(e.pointerId);
          return;
        }
        const activeLaneIndices = collectControllerEventSourceIndices(beforeEvents, bottomLane);
        if (!activeLaneIndices) {
          canvas.releasePointerCapture(e.pointerId);
          return;
        }
        const activeLaneIndexSet = new Set(activeLaneIndices);
        const activeSelection = new Set(
          [...selectedControllerEventIndices].filter((index) => activeLaneIndexSet.has(index)),
        );
        let hitIndex = -1;
        let nearestDistance = 8;
        for (const projected of projection.events) {
          const px = viewport.keyWidth + (projected.beat - viewport.scrollBeats) * viewport.pixelsPerBeat;
          const py = controllerYFromValue(projected.value, gridBottom, height, isPB);
          const distance = Math.hypot(px - x, py - y);
          if (distance <= nearestDistance) {
            nearestDistance = distance;
            hitIndex = projected.sourceEventIndex;
          }
        }
        if (hitIndex >= 0 && (e.shiftKey || isPrimaryModifier(e))) {
          const toggled = new Set(activeSelection);
          if (toggled.has(hitIndex)) toggled.delete(hitIndex);
          else toggled.add(hitIndex);
          onSelectionChange(new Set());
          onControllerEventSelectionChange(toggled);
          canvas.releasePointerCapture(e.pointerId);
          return;
        }
        let gestureEvents = beforeEvents;
        let sourceEventIndex = hitIndex;
        let sourceEventIndices = hitIndex >= 0 && activeSelection.has(hitIndex)
          ? [...activeSelection]
          : hitIndex >= 0 ? [hitIndex] : [];
        let added = false;
        let sourceEventIndexByBeat: Map<number, number> | null = null;
        let channel = hitIndex >= 0 ? beforeEvents[hitIndex].status & 0x0f
          : defaultControllerChannel(beforeEvents, bottomLane);
        if (hitIndex < 0) {
          if (beforeEvents.length >= MAX_EDITABLE_CONTROLLER_EVENTS) {
            canvas.releasePointerCapture(e.pointerId);
            return;
          }
          const event = createControllerEvent(
            bottomLane,
            sourceBeat,
            value,
            channel,
          );
          if (!event) {
            canvas.releasePointerCapture(e.pointerId);
            return;
          }
          gestureEvents = [...beforeEvents, event];
          sourceEventIndex = gestureEvents.length - 1;
          sourceEventIndices = [sourceEventIndex];
          added = true;
          channel = event.status & 0x0f;
        }
        const painting = tool === "draw" && hitIndex < 0;
        if (painting) {
          sourceEventIndexByBeat = indexControllerEventSourcesByBeat(
            gestureEvents, bottomLane, channel,
          );
          if (!sourceEventIndexByBeat) {
            canvas.releasePointerCapture(e.pointerId);
            return;
          }
        }
        if (added) setLocalEvents(gestureEvents);
        onSelectionChange(new Set());
        onControllerEventSelectionChange(new Set(sourceEventIndices));
        midiEventGestureRef.current = {
          beforeEvents,
          baseEvents: gestureEvents,
          sourceEventIndex,
          sourceEventIndices,
          sourceEventIndexByBeat,
          channel,
          painting,
          added,
          anchorBeat: displayBeat,
          anchorValue: value,
          changed: added,
          lastBeat: displayBeat,
          lastValue: value,
        };
        draggingRef.current = {
          type: "midiEvent",
          startPointerX: x,
          startPointerY: y,
          startBeat: displayBeat,
          startPitch: 0,
          initialNotesSnapshot: new Map(region.notes.map((note) => [note.id, note])),
        };
      } else if (onRegionChange && !isPianoRollUmpControllerLane(bottomLane)) {
        const beat = Math.max(0, snapBeat(sourceBeatAt(xToBeat(x))));
        const isPB = bottomLane === "pitchBend";
        const val = controllerValueFromY(y, gridBottom, height, isPB);
        const beforeLanes = localAutomationLanesRef.current;
        const lanes = [...(beforeLanes ?? region.automationLanes ?? [])];
        let laneIdx = lanes.findIndex((candidate) => isControllerLane(candidate, bottomLane));
        if (laneIdx < 0) {
          lanes.push({
            id: `lane_${region.id}_${bottomLane}`,
            target: {
              domain: "midiCC",
              entityId: region.id,
              parameterId: controllerParameterId(bottomLane),
              valueType: "integer",
              defaultValue: 0,
              minValue: isPB ? -8192 : 0,
              maxValue: isPB ? 8191 : 127,
            },
            scope: "region",
            enabled: true,
            writeMode: "read",
            points: [],
          });
          laneIdx = lanes.length - 1;
        }
        const sourcePoints = lanes[laneIdx].points;
        const hitIndex = sourcePoints.findIndex((point) =>
          Math.abs(point.timeBeats - beat) * viewport.pixelsPerBeat <= 7 &&
          Math.abs(controllerYFromValue(point.value, gridBottom, height, isPB) - y) <= 7,
        );
        let pointIndex = hitIndex;
        if (hitIndex < 0) {
          const points = editControllerPoint(sourcePoints, null, beat, val);
          if (!points) {
            canvas.releasePointerCapture(e.pointerId);
            return;
          }
          pointIndex = points.findIndex((point) => point.timeBeats === beat);
          lanes[laneIdx] = { ...lanes[laneIdx], points };
          setControllerPreview(lanes);
        }
        controllerGestureRef.current = {
          beforeLanes,
          baseLanes: lanes,
          laneIndex: laneIdx,
          pointIndex,
          added: hitIndex < 0,
          anchorBeat: beat,
          changed: hitIndex < 0,
          lastBeat: beat,
          lastValue: val,
        };
        draggingRef.current = {
          type: "cc",
          startPointerX: x,
          startPointerY: y,
          startBeat: beat,
          startPitch: 0,
          initialNotesSnapshot: new Map(region.notes.map((n) => [n.id, n])),
        };
      } else {
        canvas.releasePointerCapture(e.pointerId);
      }
      return;
    }

    // ── C. Click in Piano Keyboard Margin (Audition Key) ──────────────────
    if (x < viewport.keyWidth) {
      const pitch = yToPitch(y, height);
      setHoveredPitch(pitch);
      return;
    }

    // ── D. Note Grid Interaction ─────────────────────────────────────────
    const timelineBeat = xToBeat(x);
    const beat = sourceBeatAt(timelineBeat);
    const pitch = yToPitch(y, height);
    const drawGesture =
      tool === "draw" || (tool === "select" && isPrimaryModifier(e));

    // Dynamic handle tolerance (8px converted to beats)
    const handleTol = Math.max(0.08, 8 / viewport.pixelsPerBeat);
    const hit = spatialIndex.current.hitTest(beat, pitch, handleTol);

    const beginExistingNoteInteraction = (noteHit: NonNullable<typeof hit>) => {
      let newSelection = new Set(selectedNoteIds);
      if (e.shiftKey) {
        if (newSelection.has(noteHit.note.id)) {
          newSelection.delete(noteHit.note.id);
        } else {
          newSelection.add(noteHit.note.id);
        }
      } else if (!newSelection.has(noteHit.note.id)) {
        newSelection = new Set([noteHit.note.id]);
      }
      onSelectionChange(newSelection);

      // Shift-clicking the only selected note is a pure deselect operation.
      if (!newSelection.has(noteHit.note.id)) return;

      const initialMap = new Map<number, MidiNoteRow>();
      for (const note of notesToRender) {
        if (newSelection.has(note.id)) initialMap.set(note.id, { ...note });
      }

      draggingRef.current = {
        type: noteHit.isResizeHandle ? "resize" : "move",
        startPointerX: x,
        startPointerY: y,
        // Musical-coordinate anchor makes the gesture stable while the
        // viewport auto-scrolls underneath a stationary pointer.
        startBeat: timelineBeat,
        startPitch: pitch,
        targetNoteIds: newSelection,
        initialNotesSnapshot: initialMap,
      };
      lastDragDetentRef.current = null;
      triggerHaptic("generic");
      startAutoScroll();
    };

    if (tool === "erase") {
      if (hit) {
        const updated = notesToRender.filter((note) => note.id !== hit.note.id);
        setLocalNotes(updated);
        pendingCommitRef.current = updated;
        onNotesChange(updated);
        onSelectionChange(new Set([...selectedNoteIds].filter((id) => id !== hit.note.id)));
      }
      return;
    }

    if (tool === "slice") {
      if (hit) {
        const cutBeat = snap > 0 ? snapBeat(beat) : beat;
        const sliced = sliceNote(hit.note, cutBeat);
        if (sliced) {
          const [noteA, noteB] = sliced;
          const updated = notesToRender
            .map((n) => (n.id === hit.note.id ? noteA : n))
            .concat(noteB);
          setLocalNotes(updated);
          pendingCommitRef.current = updated;
          onNotesChange(updated);
          onSelectionChange(new Set([noteB.id]));
        }
      }
      return;
    }

    if (tool === "brush") {
      const snappedBeat = snapBeat(beat);
      let snappedPitch = Math.max(0, Math.min(127, pitch));
      if (snapToScale) {
        snappedPitch = snapPitchToScale(snappedPitch, rootNote, scaleMode);
      }
      const dur = snap > 0 ? snap : 0.25;
      const painted = paintBrushNote(
        notesToRender,
        snappedBeat,
        snappedPitch,
        dur,
      );
      if (painted) {
        setLocalNotes(painted.updatedNotes);
        pendingCommitRef.current = painted.updatedNotes;
        onSelectionChange(new Set([painted.newNote.id]));
      }
      draggingRef.current = {
        type: "brush",
        startPointerX: x,
        startPointerY: y,
        startBeat: snappedBeat,
        lastBeat: snappedBeat,
        startPitch: snappedPitch,
        initialNotesSnapshot: new Map(notesToRender.map((n) => [n.id, n])),
      };
      return;
    }

    if (drawGesture) {
      if (hit) {
        // On existing material Pencil behaves exactly like Select, including
        // Shift multi-selection and the right-edge resize handle.
        beginExistingNoteInteraction(hit);
      } else {
        // Create new note
        const snappedBeat = snapBeat(beat);
        let snappedPitch = Math.max(0, Math.min(127, pitch));
        if (snapToScale) {
          snappedPitch = snapPitchToScale(snappedPitch, rootNote, scaleMode);
        }
        const duration = Math.max(
          0.125,
          lastSingleSelectedDurationRef.current ?? (snap > 0 ? snap : 1.0),
        );
        const newNote: MidiNoteRow = {
          id: generateNoteId(),
          pitch: snappedPitch,
          startBeats: snappedBeat,
          durationBeats: duration,
          velocity: DEFAULT_NOTE_VELOCITY,
          releaseVelocity: 0.5,
          probability: 1.0,
        };

        const updated = [...notesToRender, newNote];
        setLocalNotes(updated);
        // Keep the first click authoritative even if React has not committed
        // the optimistic render before the matching pointer-up event.
        pendingCommitRef.current = updated;
        const targetIds = new Set([newNote.id]);
        onSelectionChange(targetIds);

        const initialMap = new Map<number, MidiNoteRow>();
        initialMap.set(newNote.id, { ...newNote });

        draggingRef.current = {
          type: "draw",
          startPointerX: x,
          startPointerY: y,
          startBeat: timelineBeat,
          startPitch: pitch,
          targetNoteIds: targetIds,
          initialNotesSnapshot: initialMap,
        };
        lastDragDetentRef.current = null;
        triggerHaptic("generic");
        startAutoScroll();
      }
      return;
    }

    // ── Select Tool ───────────────────────────────────────────────────────
    if (hit) {
      beginExistingNoteInteraction(hit);
    } else {
      // Click on background: start marquee selection
      if (!e.shiftKey) {
        onSelectionChange(new Set());
      }
      draggingRef.current = {
        type: "marquee",
        startPointerX: x,
        startPointerY: y,
        startBeat: timelineBeat,
        startPitch: pitch,
        additiveSelection: e.shiftKey ? new Set(selectedNoteIds) : undefined,
        initialNotesSnapshot: new Map(region.notes.map((n) => [n.id, n])),
        marqueeBox: {
          startBeat: timelineBeat,
          startPitch: pitch,
          currentBeat: timelineBeat,
          currentPitch: pitch,
        },
      };
    }
  };

  return handlePointerDown;
}
