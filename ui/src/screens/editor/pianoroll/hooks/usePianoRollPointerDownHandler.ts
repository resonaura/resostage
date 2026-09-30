import type { PointerEvent as ReactPointerEvent } from "react";
import type { MutableRefObject } from "react";
import { RULER_HEIGHT } from "@/screens/editor/timeline/ruler/logic/constants";
import { triggerHaptic } from "@/lib/interaction/haptics";
import type { AutomationLaneRow, MidiNoteRow, MidiRegionRow } from "@/lib/state/types";
import {
  editControllerPoint,
  generateNoteId,
  paintBrushNote,
  sliceNote,
} from "@/screens/editor/pianoroll/logic/pianoRollModel";
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
  lastDragDetentRef: MutableRefObject<string | null>;
  lastSingleSelectedDurationRef: MutableRefObject<number | null>;
  isFollowSuspendedRef: MutableRefObject<boolean>;
  spatialIndex: MutableRefObject<SpatialNoteIndex>;
  viewport: PianoRollViewport;
  region: MidiRegionRow;
  bottomLane: PianoRollBottomLane;
  notesToRender: MidiNoteRow[];
  selectedNoteIds: Set<number>;
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
  onSeek?: (beats: number) => void;
  onSelectionChange: (ids: Set<number>) => void;
  onNotesChange: (notes: MidiNoteRow[]) => void;
  onRegionChange?: (region: MidiRegionRow) => void;
  startAutoScroll: () => void;
}

/** Starts a Piano Roll gesture based on the clicked editor lane or note. */
export function usePianoRollPointerDownHandler({
  canvasRef,
  lastPointerPosRef,
  draggingRef,
  pendingCommitRef,
  velocityPaintRef,
  localAutomationLanesRef,
  controllerGestureRef,
  lastDragDetentRef,
  lastSingleSelectedDurationRef,
  isFollowSuspendedRef,
  spatialIndex,
  viewport,
  region,
  bottomLane,
  notesToRender,
  selectedNoteIds,
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
  onSeek,
  onSelectionChange,
  onNotesChange,
  onRegionChange,
  startAutoScroll,
}: PianoRollPointerDownHandlerOptions) {
  // ── Pointer Down Interaction ───────────────────────────────────────────
  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
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

    // ── B. Click in Bottom Lane (Velocity or CC Automation) ───────────────
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
      } else if (onRegionChange) {
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
        initialNotesSnapshot: new Map(region.notes.map((n) => [n.id, n])),
        marqueeBox: {
          startBeat: beat,
          startPitch: pitch,
          currentBeat: beat,
          currentPitch: pitch,
        },
      };
    }
  };

  return handlePointerDown;
}
