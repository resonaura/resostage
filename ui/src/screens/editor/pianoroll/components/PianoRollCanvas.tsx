/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationLaneRow, MidiClipEventRow, MidiNoteRow, MidiRegionRow, SongRow } from "@/lib/state/types";
import type { TimelineFollowMode } from "@/screens/editor/timeline/toolbar/logic/types";
import type { CycleLocators } from "@/screens/editor/timeline/cycle/hooks/useCycleState";
import {
  PianoRollProjectHeader,
  type PianoRollCycleSetRange,
} from "@/screens/editor/pianoroll/components/PianoRollProjectHeader";
import { usePianoRollAutoScroll } from "@/screens/editor/pianoroll/hooks/usePianoRollAutoScroll";
import { usePianoRollCanvasRenderer } from "@/screens/editor/pianoroll/hooks/usePianoRollCanvasRenderer";
import { usePianoRollCoordinates } from "@/screens/editor/pianoroll/hooks/usePianoRollCoordinates";
import { usePianoRollPlayheadFollow } from "@/screens/editor/pianoroll/hooks/usePianoRollPlayheadFollow";
import { createPianoRollPointerEndHandlers } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerEndHandlers";
import { createPianoRollPointerDownHandler } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerDownHandler";
import { createPianoRollPointerMoveHandler } from "@/screens/editor/pianoroll/hooks/usePianoRollPointerMoveHandler";
import { usePianoRollViewportGestures } from "@/screens/editor/pianoroll/hooks/usePianoRollViewportGestures";
import { usePianoRollGestureLifecycle } from "@/screens/editor/pianoroll/hooks/usePianoRollGestureLifecycle";
import { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";
import { sameEditableMidiEvents } from "@/screens/editor/pianoroll/logic/controllerLane";
import type {
  DraggingState,
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollControllerGesture,
  PianoRollMidiEventGesture,
  PianoRollControllerLaneMode,
  PianoRollPendingAutomationCommit,
  PianoRollTool,
  PianoRollViewport,
  PianoRollVelocityPaintState,
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
  selectedControllerEventIndices: Set<number>;
  onControllerEventSelectionChange: (indices: Set<number>) => void;
  onNotesChange: (notes: MidiNoteRow[]) => void;
  onRegionChange?: (region: MidiRegionRow) => void;
  onEventsChange?: (events: MidiClipEventRow[]) => void | Promise<void>;
  bottomLane?: PianoRollBottomLane;
  controllerLaneMode?: PianoRollControllerLaneMode;
  eventEditStatus?: string;
  playheadBeats?: number;
  getLivePlayheadBeats?: () => number;
  activeMidiPitches?: Set<number>;
  timeSignatureNumerator?: number;
  isPlaying?: boolean;
  onSeek?: (beats: number) => void;
  viewport: PianoRollViewport;
  onViewportChange: React.Dispatch<React.SetStateAction<PianoRollViewport>>;
  followMode?: TimelineFollowMode;
  catchOnPlay?: boolean;
  catchOnSeek?: boolean;
  onSuspendFollow?: () => void;
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
  selectedControllerEventIndices,
  onControllerEventSelectionChange,
  onNotesChange,
  onRegionChange,
  onEventsChange,
  bottomLane = "velocity",
  controllerLaneMode = "events",
  eventEditStatus = "idle",
  playheadBeats,
  getLivePlayheadBeats,
  activeMidiPitches = new Set<number>(),
  timeSignatureNumerator = 4,
  isPlaying = false,
  onSeek,
  viewport,
  onViewportChange,
  followMode = "snap",
  catchOnPlay = true,
  catchOnSeek = true,
  onSuspendFollow,
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const spatialIndex = useRef(new SpatialNoteIndex(4.0, 12));
  const draggingRef = useRef<DraggingState | null>(null);
  const [hoveredPitch, setHoveredPitch] = useState<number | null>(null);
  // Local working copy of notes during interactive drag to provide 120 FPS feedback
  // with zero network roundtrip latency or runaway accumulation.
  const [localNotes, setLocalNotes] = useState<MidiNoteRow[] | null>(null);
  const [localEvents, setLocalEventsState] = useState<MidiClipEventRow[] | null>(null);
  const localEventsRef = useRef<MidiClipEventRow[] | null>(null);
  const setLocalEvents = useCallback((events: MidiClipEventRow[] | null) => {
    localEventsRef.current = events;
    setLocalEventsState(events);
  }, []);
  const renderedRegion = localEvents
    ? { ...region, events: localEvents }
    : region;
  const notesToRender = localNotes || region.notes;
  const pendingCommitRef = useRef<MidiNoteRow[] | null>(null);
  const lastSingleSelectedDurationRef = useRef<number | null>(null);
  const [localAutomationLanes, setLocalAutomationLanes] = useState<AutomationLaneRow[] | null>(null);
  const localAutomationLanesRef = useRef<AutomationLaneRow[] | null>(null);
  const setControllerPreview = useCallback((lanes: AutomationLaneRow[] | null) => {
    localAutomationLanesRef.current = lanes;
    setLocalAutomationLanes(lanes);
  }, []);
  const pendingAutomationCommitRef = useRef<PianoRollPendingAutomationCommit | null>(null);
  const controllerGestureRef = useRef<PianoRollControllerGesture | null>(null);
  const midiEventGestureRef = useRef<PianoRollMidiEventGesture | null>(null);
  const velocityPaintRef = useRef<PianoRollVelocityPaintState | null>(null);

  // When authoritative region.notes updates from parent (e.g. edit commit, undo, delete),
  // always clear local working draft so the canvas renders the authoritative notes.
  useEffect(() => {
    setLocalNotes(null);
    pendingCommitRef.current = null;
  }, [region.notes, region.id]);

  useEffect(() => {
    const local = localEventsRef.current;
    if (local && (eventEditStatus === "idle"
        || sameEditableMidiEvents(local, region.events ?? [])))
      setLocalEvents(null);
  }, [region.events, eventEditStatus, setLocalEvents]);

  useEffect(() => setLocalEvents(null), [region.id, setLocalEvents]);

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

  const { beginGesture, endGesture, cancelGesture, lostPointerCapture } =
    usePianoRollGestureLifecycle({
      regionId: region.id,
      canvasRef,
      draggingRef,
      pendingCommitRef,
      pendingAutomationCommitRef,
      controllerGestureRef,
      midiEventGestureRef,
      velocityPaintRef,
      lastDragDetentRef,
      stopAutoScroll,
      setLocalNotes,
      setControllerPreview,
      setLocalEvents,
      setHoveredPitch,
      onSelectionChange,
      setControllerEventSelection: onControllerEventSelectionChange,
    });

  usePianoRollPlayheadFollow({
    canvasRef,
    containerRef,
    playheadRef,
    isFollowSuspendedRef,
    isPlaying,
    followMode,
    catchOnPlay,
    catchOnSeek,
    playheadBeats,
    getLivePlayheadBeats,
    viewport,
    projectBpm: projectSong?.bpm,
    onViewportChange,
    draggingRef,
  });

  // ── Render Loop ────────────────────────────────────────────────────────
  const { canvasSize, render } = usePianoRollCanvasRenderer({
    canvasRef,
    containerRef,
    spatialIndex,
    draggingRef,
    notesToRender,
    viewport,
    bottomLane,
    controllerLaneMode,
    region: renderedRegion,
    localAutomationLanes,
    rootNote,
    scaleMode,
    showGhostNotes,
    companionRegions,
    selectedNoteIds,
    selectedControllerEventIndices,
    activeMidiPitches,
    timeSignatureNumerator,
    hoveredPitch,
    trackColor,
    beatToX,
    xToBeat,
    pitchToY,
  });

  usePianoRollViewportGestures({
    canvasRef,
    containerRef,
    isPlaying,
    isFollowSuspendedRef,
    keyWidth: viewport.keyWidth,
    onViewportChange,
    onSuspendFollow,
  });

  const handlePointerDown = createPianoRollPointerDownHandler({
    canvasRef,
    lastPointerPosRef,
    draggingRef,
    pendingCommitRef,
    velocityPaintRef,
    localAutomationLanesRef,
    controllerGestureRef,
    midiEventGestureRef,
    lastDragDetentRef,
    lastSingleSelectedDurationRef,
    isFollowSuspendedRef,
    spatialIndex,
    viewport,
    region: renderedRegion,
    bottomLane,
    controllerLaneMode,
    notesToRender,
    selectedNoteIds,
    selectedControllerEventIndices,
    onControllerEventSelectionChange,
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
    onSeek,
    onSelectionChange,
    onNotesChange,
    onRegionChange,
    onEventsChange,
    startAutoScroll,
  });

  const handlePointerMove = createPianoRollPointerMoveHandler({
    canvasRef,
    lastPointerPosRef,
    draggingRef,
    pendingCommitRef,
    velocityPaintRef,
    controllerGestureRef,
    midiEventGestureRef,
    lastDragDetentRef,
    spatialIndex,
    viewport,
    region: renderedRegion,
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
    onSelectionChange,
    onControllerEventSelectionChange,
    onSeek,
    onRegionChange,
    onEventsChange,
    render,
  });

  const {
    handlePointerUp,
    handleDoubleClick,
  } = createPianoRollPointerEndHandlers({
    canvasRef,
    draggingRef,
    pendingCommitRef,
    pendingAutomationCommitRef,
    controllerGestureRef,
    midiEventGestureRef,
    localAutomationLanesRef,
    localEventsRef,
    velocityPaintRef,
    lastDragDetentRef,
    localNotes,
    notesToRender,
    region: renderedRegion,
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
        onPointerDown={(event) => {
          const snapshot = {
            notes: localNotes,
            pendingNotes: pendingCommitRef.current,
            lanes: localAutomationLanesRef.current,
            events: localEvents,
            selection: new Set(selectedNoteIds),
            controllerEventSelection: new Set(selectedControllerEventIndices),
          };
          handlePointerDown(event);
          if (event.button === 0 && draggingRef.current)
            beginGesture(event.pointerId, snapshot);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => {
          endGesture();
          handlePointerUp(event);
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          cancelGesture();
        }}
        onLostPointerCapture={(event) => lostPointerCapture(event.pointerId)}
        onDoubleClick={handleDoubleClick}
        className="block h-full w-full touch-none"
      />
      {playheadBeats !== undefined && (
        <div
          className="pointer-events-none absolute inset-y-0 inset-x-0 z-50 overflow-hidden"
          style={{ clipPath: `inset(0 0 0 ${viewport.keyWidth}px)` }}
        >
          <div
            ref={playheadRef}
            className="absolute inset-y-0 w-0"
          >
            <div className="absolute inset-y-0 left-0 w-[1.5px] -translate-x-1/2 bg-white shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
            <div className="absolute left-0 top-0 -translate-x-1/2">
              <div className="h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-white" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
