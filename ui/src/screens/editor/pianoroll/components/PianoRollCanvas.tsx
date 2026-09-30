import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationLaneRow, MidiNoteRow, MidiRegionRow, SongRow } from "@/lib/state/types";
import type { TimelineFollowMode } from "@/screens/editor/timeline/toolbar/logic/types";
import { RULER_HEIGHT } from "@/screens/editor/timeline/ruler/logic/constants";
import type { CycleLocators } from "@/screens/editor/timeline/cycle/hooks/useCycleState";
import {
  PianoRollProjectHeader,
  type PianoRollCycleSetRange,
} from "@/screens/editor/pianoroll/components/PianoRollProjectHeader";
import { usePianoRollAutoScroll } from "@/screens/editor/pianoroll/hooks/usePianoRollAutoScroll";
import { usePianoRollCoordinates } from "@/screens/editor/pianoroll/hooks/usePianoRollCoordinates";
import { usePianoRollPlayheadFollow } from "@/screens/editor/pianoroll/hooks/usePianoRollPlayheadFollow";
import { usePianoRollPointerEndHandlers } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerEndHandlers";
import { usePianoRollPointerDownHandler } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerDownHandler";
import { usePianoRollViewportGestures } from "@/screens/editor/pianoroll/hooks/usePianoRollViewportGestures";
import { triggerHaptic } from "@/lib/interaction/haptics";
import { useThemeVersion } from "@/hooks/useThemeVersion";
import {
  editControllerPoint,
  paintBrushNote,
  resolveDrawNoteDuration,
} from "@/screens/editor/pianoroll/logic/pianoRollModel";
import { snapPitchToScale } from "@/screens/editor/pianoroll/logic/scales";
import { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";
import { drawPianoRollCanvas } from "@/screens/editor/pianoroll/logic/pianoRollRenderer";
import {
  controllerValueFromY,
  controllerYFromValue,
  isControllerLane,
  noteTextColor,
} from "@/screens/editor/pianoroll/logic/canvasUtils";
import type {
  DraggingState,
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollTool,
  PianoRollViewport,
  ScaleMode,
} from "@/screens/editor/pianoroll/logic/types";

interface PianoRollCanvasProps {
  region: MidiRegionRow;
  companionRegions?: MidiRegionRow[];
  trackColor?: string;
  tool: PianoRollTool;
  snap: GridSnapValue;
  rootNote: number;
  scaleMode: ScaleMode;
  snapToScale: boolean;
  showGhostNotes: boolean;
  selectedNoteIds: Set<number>;
  onSelectionChange: (ids: Set<number>) => void;
  onNotesChange: (notes: MidiNoteRow[]) => void;
  onRegionChange?: (region: MidiRegionRow) => void;
  bottomLane?: PianoRollBottomLane;
  playheadBeats?: number;
  activeMidiPitches?: Set<number>;
  timeSignatureNumerator?: number;
  isPlaying?: boolean;
  onSeek?: (beats: number) => void;
  viewport: PianoRollViewport;
  onViewportChange: React.Dispatch<React.SetStateAction<PianoRollViewport>>;
  followMode?: TimelineFollowMode;
  catchOnPlay?: boolean;
  catchOnSeek?: boolean;
  projectCycle?: CycleLocators;
  projectSong?: SongRow;
  projectSongIndex?: number;
  projectSongLength?: number;
  projectCycleOwner?: boolean;
  onCycleToggleActive?: () => void;
  onCycleSetRange?: PianoRollCycleSetRange;
  onCycleToggleSkip?: () => void;
  onCycleDragEnd?: () => void;
}

export function PianoRollCanvas({
  region,
  companionRegions = [],
  trackColor,
  tool,
  snap,
  rootNote,
  scaleMode,
  snapToScale,
  showGhostNotes,
  selectedNoteIds,
  onSelectionChange,
  onNotesChange,
  onRegionChange,
  bottomLane = "velocity",
  playheadBeats,
  activeMidiPitches = new Set<number>(),
  timeSignatureNumerator = 4,
  isPlaying = false,
  onSeek,
  viewport,
  onViewportChange,
  followMode = "snap",
  catchOnPlay = true,
  catchOnSeek = true,
  projectCycle,
  projectSong,
  projectSongIndex = 0,
  projectSongLength = 0,
  projectCycleOwner = false,
  onCycleToggleActive,
  onCycleSetRange,
  onCycleToggleSkip,
  onCycleDragEnd,
}: PianoRollCanvasProps) {
  const currentThemeVersion = useThemeVersion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const spatialIndex = useRef(new SpatialNoteIndex(4.0, 12));
  const draggingRef = useRef<DraggingState | null>(null);
  const [hoveredPitch, setHoveredPitch] = useState<number | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  // Local working copy of notes during interactive drag to provide 120 FPS feedback
  // with zero network roundtrip latency or runaway accumulation.
  const [localNotes, setLocalNotes] = useState<MidiNoteRow[] | null>(null);
  const notesToRender = localNotes || region.notes;
  const pendingCommitRef = useRef<MidiNoteRow[] | null>(null);
  const lastSingleSelectedDurationRef = useRef<number | null>(null);
  const [localAutomationLanes, setLocalAutomationLanes] = useState<AutomationLaneRow[] | null>(null);
  const localAutomationLanesRef = useRef<AutomationLaneRow[] | null>(null);
  const setControllerPreview = useCallback((lanes: AutomationLaneRow[] | null) => {
    localAutomationLanesRef.current = lanes;
    setLocalAutomationLanes(lanes);
  }, []);
  const pendingAutomationCommitRef = useRef<{ parameterId: string; points: AutomationLaneRow["points"] } | null>(null);
  const controllerGestureRef = useRef<{
    beforeLanes: AutomationLaneRow[] | null;
    baseLanes: AutomationLaneRow[];
    laneIndex: number;
    pointIndex: number;
    added: boolean;
    anchorBeat: number;
    changed: boolean;
    lastBeat: number;
    lastValue: number;
  } | null>(null);
  const velocityPaintRef = useRef<{
    lastBeat: number;
    notes: MidiNoteRow[];
    noteById: Map<number, MidiNoteRow>;
  } | null>(null);

  // Keep the optimistic canvas image until Core's authoritative region catches
  // up. Clearing it on pointer-up used to flash the old note positions while
  // the asynchronous HTTP command was still in flight.
  useEffect(() => {
    const pending = pendingCommitRef.current;
    if (!pending || pending.length !== region.notes.length) return;
    const committed = new Map(region.notes.map((note) => [note.id, note]));
    const matches = pending.every((note) => {
      const actual = committed.get(note.id);
      return actual && actual.pitch === note.pitch &&
        actual.startBeats === note.startBeats &&
        actual.durationBeats === note.durationBeats &&
        actual.velocity === note.velocity;
    });
    if (matches) {
      pendingCommitRef.current = null;
      setLocalNotes(null);
    }
  }, [region.notes]);

  useEffect(() => {
    const pending = pendingAutomationCommitRef.current;
    if (!pending || controllerGestureRef.current) return;
    const accepted = region.automationLanes?.find((lane) => lane.target.parameterId === pending.parameterId);
    if (!accepted || accepted.points.length !== pending.points.length) return;
    if (accepted.points.every((point, index) =>
      Math.abs(point.timeBeats - pending.points[index].timeBeats) < 1e-6 &&
      Math.abs(point.value - pending.points[index].value) < 1e-6 &&
      Math.abs(point.curve - pending.points[index].curve) < 1e-6,
    )) {
      pendingAutomationCommitRef.current = null;
      setControllerPreview(null);
    }
  }, [region.automationLanes, setControllerPreview]);

  useEffect(() => {
    pendingAutomationCommitRef.current = null;
    controllerGestureRef.current = null;
    setControllerPreview(null);
  }, [region.id, setControllerPreview]);

  const lastDragDetentRef = useRef<string | null>(null);

  // Pencil's one-click note length follows the last note the user selected
  // alone. A later multi-selection must not erase that useful preference.
  useEffect(() => {
    if (selectedNoteIds.size !== 1) return;
    const selectedId = selectedNoteIds.values().next().value;
    const selected = notesToRender.find((note) => note.id === selectedId);
    if (selected && Number.isFinite(selected.durationBeats) && selected.durationBeats > 0)
      lastSingleSelectedDurationRef.current = selected.durationBeats;
  }, [notesToRender, selectedNoteIds]);

  // Playhead autofollow suspension flag (suspended by manual scroll / pan gestures)
  const isFollowSuspendedRef = useRef<boolean>(false);

  // Sync spatial index whenever rendered notes change
  useEffect(() => {
    spatialIndex.current.rebuild(notesToRender);
  }, [notesToRender]);

  const {
    beatToX,
    xToBeat,
    pitchToY,
    yToPitch,
    snapBeat,
    sourceBeatAt,
  } = usePianoRollCoordinates({ viewport, snap, region });

  // Edge auto-scroll RAF and its pointer/clock refs are owned by one hook.
  const { lastPointerPosRef, startAutoScroll, stopAutoScroll } =
    usePianoRollAutoScroll({
      canvasRef,
      viewportRef,
      draggingRef,
      pendingCommitRef,
      notesToRender,
      keyWidth: viewport.keyWidth,
      velocityLaneHeight: viewport.velocityLaneHeight,
      snap,
      snapBeat,
      sourceBeatAt,
      onViewportChange,
      setLocalNotes,
    });

  usePianoRollPlayheadFollow({
    canvasRef,
    isFollowSuspendedRef,
    isPlaying,
    followMode,
    catchOnPlay,
    playheadBeats,
    viewport,
    projectBpm: projectSong?.bpm,
    onViewportChange,
  });

  // ── Render Loop ────────────────────────────────────────────────────────
  const render = useCallback(() => {
    drawPianoRollCanvas({
      canvasElement: canvasRef.current,
      viewport,
      bottomLane,
      region,
      localAutomationLanes,
      rootNote,
      scaleMode,
      showGhostNotes,
      companionRegions,
      selectedNoteIds,
      activeMidiPitches,
      timeSignatureNumerator,
      hoveredPitch,
      trackColor,
      beatToX,
      xToBeat,
      pitchToY,
      spatialIndex: spatialIndex.current,
      draggingState: draggingRef.current,
      noteTextColor,
      isControllerLane,
      controllerYFromValue,
    });
  }, [
    viewport,
    bottomLane,
    region,
    notesToRender,
    localAutomationLanes,
    rootNote,
    scaleMode,
    showGhostNotes,
    companionRegions,
    selectedNoteIds,
    activeMidiPitches,
    timeSignatureNumerator,
    hoveredPitch,
    trackColor,
    currentThemeVersion,
    beatToX,
    xToBeat,
    pitchToY,
  ]);

  // Sync canvas size with device pixel ratio
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      setCanvasSize({ width: rect.width, height: rect.height });
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      render();
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [render]);

  useEffect(() => {
    render();
  }, [render]);

  usePianoRollViewportGestures({
    canvasRef,
    containerRef,
    isPlaying,
    isFollowSuspendedRef,
    keyWidth: viewport.keyWidth,
    onViewportChange,
  });

  const handlePointerDown = usePianoRollPointerDownHandler({
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
  });

  // ── Pointer Move Interaction ───────────────────────────────────────────
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
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
        const hit = spatialIndex.current.hitTest(beat, pitch, handleTol);
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

    // ── Dragging: CC Automation ──────────────────────────────────────────
    if (dragging.type === "cc" && onRegionChange) {
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
      const painted = paintBrushNote(notesToRender, curBeat, curPitch, dur);
      if (painted) {
        setLocalNotes(painted.updatedNotes);
        pendingCommitRef.current = painted.updatedNotes;
        onSelectionChange(new Set([painted.newNote.id]));
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
        const newBeat = Math.max(0, initial.startBeats + snappedDeltaBeats);
        const newPitch = Math.max(0, Math.min(127, initial.pitch + deltaPitch));
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
      const anchorNote = dragging.initialNotesSnapshot
        .values()
        .next().value as MidiNoteRow | undefined;
      if (anchorNote) {
        const duration = anchorNote.durationBeats + deltaBeats;
        const detent = snap > 0
          ? Math.round(Math.max(snap, duration) / snap)
          : Math.round(Math.max(0.125, duration) * 100);
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
        const rawDuration = initial.durationBeats + deltaBeats;
        const snappedDuration =
          snap > 0
            ? Math.max(snap, Math.round(rawDuration / snap) * snap)
            : Math.max(0.125, rawDuration);
        return { ...note, durationBeats: snappedDuration };
      });

      setLocalNotes(updated);
      render();
    } else if (dragging.type === "marquee" && dragging.marqueeBox) {
      const currentBeat = sourceBeatAt(xToBeat(x));
      const currentPitch = yToPitch(y, height);
      dragging.marqueeBox.currentBeat = currentBeat;
      dragging.marqueeBox.currentPitch = currentPitch;

      const minB = Math.min(dragging.marqueeBox.startBeat, currentBeat);
      const maxB = Math.max(dragging.marqueeBox.startBeat, currentBeat);
      const minP = Math.min(dragging.marqueeBox.startPitch, currentPitch);
      const maxP = Math.max(dragging.marqueeBox.startPitch, currentPitch);

      const enclosedNotes = spatialIndex.current.queryRange(
        minB,
        maxB,
        minP,
        maxP,
      );
      onSelectionChange(new Set(enclosedNotes.map((n) => n.id)));
      render();
    }
  };

  const {
    handlePointerUp,
    handlePointerCancel,
    handleDoubleClick,
  } = usePianoRollPointerEndHandlers({
    canvasRef,
    draggingRef,
    pendingCommitRef,
    pendingAutomationCommitRef,
    controllerGestureRef,
    localAutomationLanesRef,
    velocityPaintRef,
    lastDragDetentRef,
    localNotes,
    notesToRender,
    region,
    viewport,
    bottomLane,
    spatialIndex,
    stopAutoScroll,
    render,
    sourceBeatAt,
    xToBeat,
    setLocalNotes,
    setHoveredPitch,
    setControllerPreview,
    onNotesChange,
    onSelectionChange,
    onRegionChange,
  });

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden select-none bg-background"
    >
      <PianoRollProjectHeader
        song={projectSong}
        cycle={projectCycle}
        songLength={projectSongLength}
        songIndex={projectSongIndex}
        cycleOwner={projectCycleOwner}
        regionStartBeats={region.startBeats}
        viewport={viewport}
        canvasWidth={canvasSize.width}
        timeSignatureNumerator={timeSignatureNumerator}
        snap={snap}
        onCycleToggleActive={onCycleToggleActive}
        onCycleSetRange={onCycleSetRange}
        onCycleToggleSkip={onCycleToggleSkip}
        onCycleDragEnd={onCycleDragEnd}
      />
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onDoubleClick={handleDoubleClick}
        className="block h-full w-full touch-none"
      />
      {playheadBeats !== undefined && (
        <div
          className="pointer-events-none absolute inset-y-0 z-50 w-0"
          style={{ left: beatToX(playheadBeats) }}
        >
          <div className="absolute inset-y-0 left-0 w-[1.5px] -translate-x-1/2 bg-white shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
          <div className="absolute left-0 top-0 -translate-x-1/2">
            <div className="h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-white" />
          </div>
        </div>
      )}
    </div>
  );
}
