/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { triggerHaptic } from "@/lib/interaction/haptics";
import type { AutomationLaneRow, MidiClipEventRow, MidiNoteRow, MidiRegionRow, MidiUmpEventRow } from "@/lib/state/types";
import { DEFAULT_NOTE_VELOCITY } from "@/screens/editor/pianoroll/logic/canvasUtils";
import {
  buildPianoRollControllerProjection,
  MAX_EDITABLE_CONTROLLER_EVENTS,
  removeControllerEvent,
  sameEditableMidiEvents,
} from "@/screens/editor/pianoroll/logic/controllerLane";
import {
  buildPianoRollUmpControllerProjection,
  isPianoRollUmpControllerLane,
  MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS,
} from "@/screens/editor/pianoroll/logic/umpControllerLane";
import {
  removePianoRollUmpControllerEvents,
  sameEditablePianoRollUmpEvents,
} from "@/screens/editor/pianoroll/logic/umpControllerEditing";
import { controllerYFromValue } from "@/screens/editor/pianoroll/logic/canvasUtils";
import type { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";
import type {
  DraggingState,
  PianoRollBottomLane,
  PianoRollControllerGesture,
  PianoRollMidiEventGesture,
  PianoRollUmpControllerGesture,
  PianoRollControllerLaneMode,
  PianoRollPendingAutomationCommit,
  PianoRollViewport,
  PianoRollVelocityPaintState,
} from "@/screens/editor/pianoroll/logic/types";

interface PianoRollPointerEndHandlerOptions {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  draggingRef: MutableRefObject<DraggingState | null>;
  pendingCommitRef: MutableRefObject<MidiNoteRow[] | null>;
  pendingAutomationCommitRef: MutableRefObject<PianoRollPendingAutomationCommit | null>;
  controllerGestureRef: MutableRefObject<PianoRollControllerGesture | null>;
  midiEventGestureRef: MutableRefObject<PianoRollMidiEventGesture | null>;
  umpControllerGestureRef: MutableRefObject<PianoRollUmpControllerGesture | null>;
  localEventsRef: MutableRefObject<MidiClipEventRow[] | null>;
  setLocalUmpEvents: (events: MidiUmpEventRow[] | null) => void;
  localAutomationLanesRef: MutableRefObject<AutomationLaneRow[] | null>;
  velocityPaintRef: MutableRefObject<PianoRollVelocityPaintState | null>;
  lastDragDetentRef: MutableRefObject<string | null>;
  localNotes: MidiNoteRow[] | null;
  notesToRender: MidiNoteRow[];
  region: MidiRegionRow;
  viewport: PianoRollViewport;
  bottomLane: PianoRollBottomLane;
  controllerLaneMode: PianoRollControllerLaneMode;
  spatialIndex: MutableRefObject<SpatialNoteIndex>;
  stopAutoScroll: () => void;
  render: () => void;
  sourceBeatAt: (beat: number) => number;
  xToBeat: (x: number) => number;
  setLocalNotes: Dispatch<SetStateAction<MidiNoteRow[] | null>>;
  setHoveredPitch: Dispatch<SetStateAction<number | null>>;
  setControllerPreview: (lanes: AutomationLaneRow[] | null) => void;
  setLocalEvents: (events: MidiClipEventRow[] | null) => void;
  onNotesChange: (notes: MidiNoteRow[]) => void;
  onSelectionChange: (ids: Set<number>) => void;
  onRegionChange?: (region: MidiRegionRow) => void;
  onEventsChange?: (events: MidiClipEventRow[]) => void | Promise<void>;
  onUmpEventsChange?: (events: MidiUmpEventRow[]) => void | Promise<void>;
  umpGroupFilter?: number | null;
  umpChannelFilter?: number | null;
  onUmpControllerEventSelectionChange: (indices: Set<number>) => void;
}

/** Commits, cancels, or finalizes a Piano Roll pointer gesture. */
export function createPianoRollPointerEndHandlers({
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
  localNotes,
  notesToRender,
  region,
  viewport,
  bottomLane,
  controllerLaneMode,
  spatialIndex,
  stopAutoScroll,
  render,
  sourceBeatAt,
  xToBeat,
  setLocalNotes,
  setHoveredPitch,
  setControllerPreview,
  setLocalEvents,
  onNotesChange,
  onSelectionChange,
  onRegionChange,
  onEventsChange,
  onUmpEventsChange,
  umpGroupFilter = null,
  umpChannelFilter = null,
  onUmpControllerEventSelectionChange,
}: PianoRollPointerEndHandlerOptions) {
  // ── Pointer Up Interaction ─────────────────────────────────────────────
  const handlePointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    stopAutoScroll();

    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }

    const dragging = draggingRef.current;
    if (dragging) {
      const isNoteGesture =
        dragging.type === "move" ||
        dragging.type === "resize" ||
        dragging.type === "draw" ||
        dragging.type === "velocity" ||
        dragging.type === "brush";

      const finalNotes = dragging.type === "velocity"
        ? velocityPaintRef.current?.notes ?? localNotes
        : localNotes;

      if (isNoteGesture && finalNotes) {
        onNotesChange(finalNotes);
        triggerHaptic("generic");
      } else if (dragging.type === "midiEvent" && midiEventGestureRef.current?.changed
                 && onEventsChange) {
        const nextEvents = localEventsRef.current;
        const previousEvents = midiEventGestureRef.current.beforeEvents;
        if (nextEvents && !sameEditableMidiEvents(nextEvents, previousEvents)) {
          void onEventsChange(nextEvents);
          triggerHaptic("generic");
        } else if (midiEventGestureRef.current.added) {
          setLocalEvents(null);
        }
      } else if (dragging.type === "umpEvent" && umpControllerGestureRef.current?.changed
                 && onUmpEventsChange) {
        const gesture = umpControllerGestureRef.current;
        if (gesture && !sameEditablePianoRollUmpEvents(
          gesture.latestEvents, gesture.beforeEvents,
        )) {
          void onUmpEventsChange(gesture.latestEvents);
          triggerHaptic("generic");
        }
      } else if (dragging.type === "cc" && controllerGestureRef.current?.changed &&
                 localAutomationLanesRef.current && onRegionChange) {
        const lanes = localAutomationLanesRef.current;
        const lane = controllerGestureRef.current && lanes[controllerGestureRef.current.laneIndex];
        if (lane) {
          pendingAutomationCommitRef.current = {
            parameterId: lane.target.parameterId,
            points: lane.points,
          };
          onRegionChange({ ...region, automationLanes: lanes });
          triggerHaptic("generic");
        }
      }
      pendingCommitRef.current = null;
      setLocalNotes(null);
      setLocalUmpEvents(null);
    }
    draggingRef.current = null;
    controllerGestureRef.current = null;
    midiEventGestureRef.current = null;
    umpControllerGestureRef.current = null;
    velocityPaintRef.current = null;
    setHoveredPitch(null);
    render();
  };

  const handlePointerCancel = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    stopAutoScroll();
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    // A cancelled gesture must not leave a speculative local preview or a
    // running RAF loop behind. The authoritative notes were not committed.
    setLocalNotes(null);
    setLocalEvents(null);
    setLocalUmpEvents(null);
    pendingCommitRef.current = null;
    if (controllerGestureRef.current)
      setControllerPreview(controllerGestureRef.current.beforeLanes);
    controllerGestureRef.current = null;
    midiEventGestureRef.current = null;
    umpControllerGestureRef.current = null;
    draggingRef.current = null;
    velocityPaintRef.current = null;
    lastDragDetentRef.current = null;
    render();
  };

  const handleDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (isPianoRollUmpControllerLane(bottomLane) && onUmpEventsChange) {
      const canvas = canvasRef.current;
      const source = region.umpEvents ?? [];
      if (!canvas || source.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const gridBottom = rect.height - viewport.velocityLaneHeight;
      if (y < gridBottom || x < viewport.keyWidth) return;
      e.preventDefault();
      e.stopPropagation();
      const projection = buildPianoRollUmpControllerProjection(
        region, bottomLane, 0, region.durationBeats, umpGroupFilter, umpChannelFilter,
      );
      if (projection.truncated) return;
      const isPitchBend = bottomLane === "umpPitchBend";
      let hitIndex = -1;
      let nearestDistance = 8;
      for (const projected of projection.events) {
        const px = viewport.keyWidth
          + (projected.beat - viewport.scrollBeats) * viewport.pixelsPerBeat;
        const py = controllerYFromValue(projected.value, gridBottom, rect.height, isPitchBend);
        const distance = Math.hypot(px - x, py - y);
        if (distance <= nearestDistance) {
          nearestDistance = distance;
          hitIndex = projected.sourceEventIndex;
        }
      }
      if (hitIndex < 0) return;
      const updated = removePianoRollUmpControllerEvents(source, [hitIndex]);
      if (updated) {
        onUmpControllerEventSelectionChange(new Set());
        void onUmpEventsChange(updated);
        triggerHaptic("generic");
      }
      return;
    }
    if (bottomLane !== "velocity" && controllerLaneMode === "events" && onEventsChange) {
      const canvas = canvasRef.current;
      if (!canvas || (region.events?.length ?? 0) > MAX_EDITABLE_CONTROLLER_EVENTS) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const gridBottom = rect.height - viewport.velocityLaneHeight;
      if (y < gridBottom || x < viewport.keyWidth) return;
      e.preventDefault();
      e.stopPropagation();
      const projection = buildPianoRollControllerProjection(
        region, bottomLane, 0, region.durationBeats,
      );
      if (projection.truncated) return;
      const isPB = bottomLane === "pitchBend";
      let hitIndex = -1;
      let nearestDistance = 8;
      for (const projected of projection.events) {
        const px = viewport.keyWidth + (projected.beat - viewport.scrollBeats) * viewport.pixelsPerBeat;
        const py = controllerYFromValue(projected.value, gridBottom, rect.height, isPB);
        const distance = Math.hypot(px - x, py - y);
        if (distance <= nearestDistance) {
          nearestDistance = distance;
          hitIndex = projected.sourceEventIndex;
        }
      }
      if (hitIndex < 0) return;
      const updated = removeControllerEvent(region.events ?? [], hitIndex, bottomLane);
      if (updated) {
        void onEventsChange(updated);
        triggerHaptic("generic");
      }
      return;
    }
    if (bottomLane !== "velocity") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < rect.height - viewport.velocityLaneHeight) return;

    e.preventDefault();
    e.stopPropagation();
    const hit = spatialIndex.current.hitTestStart(
      sourceBeatAt(xToBeat(x)),
      Math.max(0.08, 8 / viewport.pixelsPerBeat),
    );
    if (!hit) return;
    const updated = notesToRender.map((note) =>
      note.id === hit.id ? { ...note, velocity: DEFAULT_NOTE_VELOCITY } : note,
    );
    setLocalNotes(updated);
    pendingCommitRef.current = updated;
    onNotesChange(updated);
    onSelectionChange(new Set([hit.id]));
    velocityPaintRef.current = null;
    draggingRef.current = null;
    render();
  };

  return {
    handlePointerUp,
    handlePointerCancel,
    handleDoubleClick,
  };
}
