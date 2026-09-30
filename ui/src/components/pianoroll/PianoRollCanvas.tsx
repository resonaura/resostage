import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationLaneRow, MidiNoteRow, MidiRegionRow, SongRow } from "../../lib/state/types";
import type { TimelineFollowMode } from "../timeline/TimelineToolbar";
import { RULER_HEIGHT } from "../timeline/constants";
import { Ruler } from "../timeline/Ruler";
import { CycleStrip } from "../timeline/cycle/components/CycleStrip";
import type { CycleLocators } from "../timeline/cycle/hooks/useCycleState";
import { triggerHaptic } from "../../lib/interaction/haptics";
import { useThemeVersion } from "../../hooks/useThemeVersion";
import { midiRegionSourceBeat } from "../../lib/midi/midiRegionTiming";
import {
  canvasYToPitch,
  editControllerPoint,
  generateNoteId,
  paintBrushNote,
  resolveDrawNoteDuration,
  sliceNote,
} from "./pianoRollModel";
import { snapPitchToScale } from "./scales";
import { SpatialNoteIndex } from "./spatialIndex";
import { drawPianoRollCanvas } from "./pianoRollRenderer";
import type {
  DraggingState,
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollTool,
  PianoRollViewport,
  ScaleMode,
} from "./types";

function isPrimaryModifier(event: Pick<PointerEvent, "metaKey" | "ctrlKey">) {
  const usesMetaKey = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  return usesMetaKey ? event.metaKey : event.ctrlKey;
}

function noteTextColor(fill: string, background: string, opacity: number): string {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^#([\da-f]{6})$/i.exec(value);
    if (!match) return null;
    return [0, 2, 4].map((offset) => parseInt(match[1].slice(offset, offset + 2), 16)) as [number, number, number];
  };
  const foreground = parse(fill);
  const behind = parse(background);
  if (!foreground || !behind) return "#fff";
  const mixed = foreground.map((component, index) =>
    (component * opacity + behind[index] * (1 - opacity)) / 255,
  );
  const linear = mixed.map((component) => component <= 0.04045
    ? component / 12.92
    : ((component + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return luminance > 0.179 ? "#111" : "#fff";
}

function controllerParameterId(lane: PianoRollBottomLane): string {
  if (lane === "pitchBend") return "pitchBend";
  return `cc:${lane.slice(2)}`;
}

function isControllerLane(lane: AutomationLaneRow, selected: PianoRollBottomLane): boolean {
  const parameterId = lane.target.parameterId;
  return parameterId === selected || parameterId === controllerParameterId(selected)
    || (selected !== "pitchBend" && parameterId === selected.slice(2));
}

function controllerValueFromY(y: number, gridBottom: number, height: number, pitchBend: boolean): number {
  const top = gridBottom + 18;
  const bottom = height - 6;
  const normalized = Math.max(0, Math.min(1, (bottom - y) / Math.max(1, bottom - top)));
  return pitchBend ? Math.round(normalized * 16383 - 8192) : Math.round(normalized * 127);
}

function controllerYFromValue(value: number, gridBottom: number, height: number, pitchBend: boolean): number {
  const top = gridBottom + 18;
  const bottom = height - 6;
  const normalized = pitchBend ? (value + 8192) / 16383 : value / 127;
  return bottom - normalized * (bottom - top);
}

const DEFAULT_NOTE_VELOCITY = 0.8;

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
  onCycleSetRange?: CycleStripProps["onSetRange"];
  onCycleToggleSkip?: () => void;
  onCycleDragEnd?: () => void;
}

type CycleStripProps = React.ComponentProps<typeof CycleStrip>;

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
  const projectPixelsPerSecond = viewport.pixelsPerBeat * (projectSong?.bpm || 120) / 60;
  const projectScrollPx = (region.startBeats + viewport.scrollBeats) * viewport.pixelsPerBeat;
  const projectContentWidth = projectSongLength * projectPixelsPerSecond;

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

  // Auto-scroll loop state while dragging notes near canvas edges
  const autoScrollRafRef = useRef<number | null>(null);
  const lastPointerPosRef = useRef<{ clientX: number; clientY: number }>({
    clientX: 0,
    clientY: 0,
  });
  const autoScrollTimeRef = useRef<number | null>(null);
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
  const prevPlayingRef = useRef<boolean>(isPlaying);

  // Sync spatial index whenever rendered notes change
  useEffect(() => {
    spatialIndex.current.rebuild(notesToRender);
  }, [notesToRender]);

  // Coordinate transforms
  const beatToX = useCallback(
    (beat: number) => {
      return (
        viewport.keyWidth +
        (beat - viewport.scrollBeats) * viewport.pixelsPerBeat
      );
    },
    [viewport.keyWidth, viewport.scrollBeats, viewport.pixelsPerBeat],
  );

  const xToBeat = useCallback(
    (x: number) => {
      return (
        viewport.scrollBeats + (x - viewport.keyWidth) / viewport.pixelsPerBeat
      );
    },
    [viewport.keyWidth, viewport.scrollBeats, viewport.pixelsPerBeat],
  );

  const pitchToY = useCallback(
    (pitch: number, height: number) => {
      const gridBottom = height - viewport.velocityLaneHeight;
      // High pitches at top, low pitches at bottom
      return (
        gridBottom -
        (pitch - viewport.scrollPitch + 1) * viewport.pixelsPerPitch
      );
    },
    [
      viewport.velocityLaneHeight,
      viewport.scrollPitch,
      viewport.pixelsPerPitch,
    ],
  );

  const yToPitch = useCallback(
    (y: number, height: number) => {
      const gridBottom = height - viewport.velocityLaneHeight;
      // scrollPitch is intentionally fractional during smooth wheel/trackpad
      // panning. Round the complete inverse transform, not just its delta;
      // otherwise a visible note can hit-test as the adjacent semitone.
      return canvasYToPitch(
        y,
        gridBottom,
        viewport.scrollPitch,
        viewport.pixelsPerPitch,
      );
    },
    [
      viewport.velocityLaneHeight,
      viewport.scrollPitch,
      viewport.pixelsPerPitch,
    ],
  );

  // Quantize beat to grid snap
  const snapBeat = useCallback(
    (beat: number): number => {
      if (snap <= 0) return Math.max(0, beat);
      return Math.max(0, Math.round(beat / snap) * snap);
    },
    [snap],
  );

  const sourceBeatAt = useCallback(
    (beat: number) => midiRegionSourceBeat(region, beat),
    [region],
  );

  // ── Edge Auto-Scroll Engine (time-based, bounded speed) ─────────────────
  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const startAutoScroll = useCallback(() => {
    stopAutoScroll();
    autoScrollTimeRef.current = null;
    const tick = (now: number) => {
      const dragging = draggingRef.current;
      const canvas = canvasRef.current;
      if (
        !dragging ||
        !canvas ||
        (dragging.type !== "move" && dragging.type !== "resize"
          && dragging.type !== "draw")
      ) {
        autoScrollRafRef.current = null;
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const { clientX, clientY } = lastPointerPosRef.current;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const width = rect.width;
      const gridBottom = rect.height - viewport.velocityLaneHeight;

      const dt = Math.min(
        0.05,
        Math.max(0, (now - (autoScrollTimeRef.current ?? now)) / 1000),
      );
      autoScrollTimeRef.current = now;
      const EDGE_X = 55;
      const MIN_SPEED_X = 35; // pixels / second
      const MAX_SPEED_X = 420;
      let speedX = 0;

      if (x > width - EDGE_X) {
        const prox = Math.max(0, Math.min(1, (x - (width - EDGE_X)) / EDGE_X));
        speedX = MIN_SPEED_X + (MAX_SPEED_X - MIN_SPEED_X) * (prox * prox);
      } else if (
        x < viewport.keyWidth + EDGE_X &&
        x >= viewport.keyWidth - 20
      ) {
        const prox = Math.max(
          0,
          Math.min(1, (viewport.keyWidth + EDGE_X - x) / EDGE_X),
        );
        speedX = -(MIN_SPEED_X + (MAX_SPEED_X - MIN_SPEED_X) * (prox * prox));
      }

      const EDGE_Y = 45;
      const MIN_SPEED_Y = 20; // pixels / second
      const MAX_SPEED_Y = 180;
      let speedY = 0;

      if (y > gridBottom - EDGE_Y && y <= gridBottom + 30) {
        const prox = Math.max(
          0,
          Math.min(1, (y - (gridBottom - EDGE_Y)) / EDGE_Y),
        );
        speedY = -(MIN_SPEED_Y + (MAX_SPEED_Y - MIN_SPEED_Y) * (prox * prox));
      } else if (y < RULER_HEIGHT + EDGE_Y && y >= RULER_HEIGHT - 20) {
        const prox = Math.max(
          0,
          Math.min(1, (RULER_HEIGHT + EDGE_Y - y) / EDGE_Y),
        );
        speedY = MIN_SPEED_Y + (MAX_SPEED_Y - MIN_SPEED_Y) * (prox * prox);
      }

      if (speedX !== 0 || speedY !== 0) {
        onViewportChange((v) => {
          const deltaBeats = (speedX * dt) / v.pixelsPerBeat;
          const nextBeats = Math.max(0, v.scrollBeats + deltaBeats);
          const deltaPitch = (speedY * dt) / v.pixelsPerPitch;
          const nextPitch = Math.max(
            0,
            Math.min(127 - 5, v.scrollPitch + deltaPitch),
          );
          return {
            ...v,
            scrollBeats: nextBeats,
            scrollPitch: nextPitch,
          };
        });

        if (dragging.type === "draw") {
          const liveViewport = viewportRef.current;
          const pointerBeat = liveViewport.scrollBeats
            + (x - liveViewport.keyWidth) / liveViewport.pixelsPerBeat;
          const initialNote = dragging.initialNotesSnapshot.values()
            .next().value as MidiNoteRow | undefined;
          if (initialNote) {
            const duration = resolveDrawNoteDuration(
              dragging.startBeat,
              pointerBeat,
              snap,
              initialNote.durationBeats,
              3 / liveViewport.pixelsPerBeat,
            );
            const startBeat = sourceBeatAt(snapBeat(
              Math.max(0, Math.min(dragging.startBeat, pointerBeat)),
            ));
            const baseNotes = pendingCommitRef.current ?? notesToRender;
            const updated = baseNotes.map((note) =>
              dragging.targetNoteIds?.has(note.id)
                ? { ...note, startBeats: startBeat, durationBeats: duration }
                : note,
            );
            pendingCommitRef.current = updated;
            setLocalNotes(updated);
          }
        }
      }

      autoScrollRafRef.current = requestAnimationFrame(tick);
    };

    autoScrollRafRef.current = requestAnimationFrame(tick);
  }, [
    onViewportChange,
    notesToRender,
    snap,
    snapBeat,
    sourceBeatAt,
    stopAutoScroll,
    viewport.keyWidth,
    viewport.velocityLaneHeight,
  ]);

  useEffect(() => {
    return () => stopAutoScroll();
  }, [stopAutoScroll]);

  // ── Playhead Autofollow Management ──────────────────────────────────────
  // Catch on playback start: reveal playhead and reset suspension
  useEffect(() => {
    if (isPlaying && !prevPlayingRef.current) {
      if (catchOnPlay) {
        isFollowSuspendedRef.current = false;
        if (playheadBeats !== undefined) {
          const canvas = canvasRef.current;
          if (canvas) {
            const width = canvas.width / (window.devicePixelRatio || 1);
            const viewBeats =
              (width - viewport.keyWidth) / viewport.pixelsPerBeat;
            onViewportChange((v) => ({
              ...v,
              scrollBeats: Math.max(0, playheadBeats - viewBeats * 0.25),
            }));
          }
        }
      }
    }
    prevPlayingRef.current = isPlaying;
  }, [
    isPlaying,
    catchOnPlay,
    playheadBeats,
    viewport.keyWidth,
    viewport.pixelsPerBeat,
    onViewportChange,
  ]);

  // Autofollow frame update during playback
  const followScrollBeats = followMode === "snap" ? viewport.scrollBeats : 0;
  useEffect(() => {
    if (!isPlaying || followMode === "off" || isFollowSuspendedRef.current) {
      return;
    }
    if (playheadBeats === undefined) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.width / (window.devicePixelRatio || 1);
    const viewBeats = (width - viewport.keyWidth) / viewport.pixelsPerBeat;
    if (followMode === "smooth") {
      // Telemetry is sampled below display refresh. Project from its latest
      // position for at most one short packet interval, then ease the viewport
      // on animation frames like the main timeline.
      const receivedAt = performance.now();
      const beatsPerMs = (projectSong?.bpm || 120) / 60_000;
      let frame = 0;
      const tick = (now: number) => {
        if (isFollowSuspendedRef.current) return;
        const projectedBeat = playheadBeats + Math.min(now - receivedAt, 120) * beatsPerMs;
        const target = Math.max(0, projectedBeat - viewBeats * 0.35);
        onViewportChange((current) => {
          const next = current.scrollBeats + (target - current.scrollBeats) * 0.28;
          return Math.abs(next - current.scrollBeats) < 0.001
            ? current
            : { ...current, scrollBeats: next };
        });
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    if (followMode === "snap") {
      const minBeat = followScrollBeats;
      const maxBeat = minBeat + viewBeats;
      // Snap mode: page turn when playhead reaches near right edge
      if (playheadBeats >= maxBeat - 0.75) {
        onViewportChange((v) => ({
          ...v,
          scrollBeats: Math.max(0, playheadBeats - viewBeats * 0.15),
        }));
      } else if (playheadBeats < minBeat) {
        // Rewind reveal
        onViewportChange((v) => ({
          ...v,
          scrollBeats: Math.max(0, playheadBeats - viewBeats * 0.2),
        }));
      }
    }
  }, [
    isPlaying,
    followMode,
    playheadBeats,
    viewport.keyWidth,
    viewport.pixelsPerBeat,
    followScrollBeats,
    projectSong?.bpm,
    onViewportChange,
  ]);

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

  // ── Non-Passive Wheel & Trackpad Gesture Listeners ────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.style.touchAction = "none";
    el.style.overscrollBehavior = "contain";

    let lastScale = 1.0;

    const handleNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey) {
        // Horizontal Zoom centered at cursor focus position
        const base = 2;
        const speed = e.deltaMode === 1 ? 0.14 : 0.005;
        let factor = Math.pow(base, -e.deltaY * speed * 4);
        factor = Math.max(0.3, Math.min(3.0, factor));

        onViewportChange((v) => {
          const oldPpb = v.pixelsPerBeat;
          const nextPpb = Math.max(20, Math.min(400, oldPpb * factor));
          if (Math.abs(nextPpb - oldPpb) < 0.01) return v;

          const focusX = Math.max(v.keyWidth, Math.min(rect.width, mouseX));
          const focusBeat = v.scrollBeats + (focusX - v.keyWidth) / oldPpb;
          const nextScrollBeats = Math.max(
            0,
            focusBeat - (focusX - v.keyWidth) / nextPpb,
          );

          return {
            ...v,
            pixelsPerBeat: nextPpb,
            scrollBeats: nextScrollBeats,
          };
        });
      } else if (e.altKey) {
        // Vertical Zoom centered at cursor focus pitch
        const base = 2;
        const speed = e.deltaMode === 1 ? 0.14 : 0.005;
        let factor = Math.pow(base, -e.deltaY * speed * 4);
        factor = Math.max(0.3, Math.min(3.0, factor));

        onViewportChange((v) => {
          const oldPpp = v.pixelsPerPitch;
          const nextPpp = Math.max(10, Math.min(40, oldPpp * factor));
          if (Math.abs(nextPpp - oldPpp) < 0.01) return v;

          const gridBottom = rect.height - v.velocityLaneHeight;
          const focusY = Math.max(RULER_HEIGHT, Math.min(gridBottom, mouseY));
          const focusPitch = v.scrollPitch + (gridBottom - focusY) / oldPpp;
          const nextScrollPitch = Math.max(
            0,
            Math.min(127 - 8, focusPitch - (gridBottom - focusY) / nextPpp),
          );

          return {
            ...v,
            pixelsPerPitch: nextPpp,
            scrollPitch: nextScrollPitch,
          };
        });
      } else {
        // Natural 2D scroll (trackpad pan or mouse wheel)
        if (isPlaying) {
          isFollowSuspendedRef.current = true;
        }

        if (e.shiftKey) {
          const delta = e.deltaY || e.deltaX;
          onViewportChange((v) => ({
            ...v,
            scrollBeats: Math.max(0, v.scrollBeats + delta / v.pixelsPerBeat),
          }));
        } else {
          const dX = e.deltaX;
          const dY = e.deltaY;
          onViewportChange((v) => {
            const nextBeats =
              dX !== 0
                ? Math.max(0, v.scrollBeats + dX / v.pixelsPerBeat)
                : v.scrollBeats;
            const nextPitch =
              dY !== 0
                ? Math.max(
                    0,
                    Math.min(
                      127 - 5,
                      v.scrollPitch - dY / (v.pixelsPerPitch * 1.5),
                    ),
                  )
                : v.scrollPitch;
            return {
              ...v,
              scrollBeats: nextBeats,
              scrollPitch: nextPitch,
            };
          });
        }
      }
    };

    const handleGestureStart = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      lastScale = 1.0;
    };

    const handleGestureChange = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.scale === "number" && e.scale > 0) {
        const deltaScale = e.scale / lastScale;
        lastScale = e.scale;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mouseX = Math.max(
          viewport.keyWidth,
          Math.min(rect.width, e.clientX - rect.left),
        );

        onViewportChange((v) => {
          const oldPpb = v.pixelsPerBeat;
          const nextPpb = Math.max(20, Math.min(400, oldPpb * deltaScale));
          if (Math.abs(nextPpb - oldPpb) < 0.01) return v;
          const focusBeat = v.scrollBeats + (mouseX - v.keyWidth) / oldPpb;
          const nextScrollBeats = Math.max(
            0,
            focusBeat - (mouseX - v.keyWidth) / nextPpb,
          );
          return {
            ...v,
            pixelsPerBeat: nextPpb,
            scrollBeats: nextScrollBeats,
          };
        });
      }
    };

    const handleGestureEnd = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      lastScale = 1.0;
    };

    el.addEventListener("wheel", handleNativeWheel, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturestart", handleGestureStart as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturechange", handleGestureChange as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gestureend", handleGestureEnd as any, {
      capture: true,
      passive: false,
    });

    return () => {
      el.removeEventListener("wheel", handleNativeWheel, { capture: true });
      el.removeEventListener("gesturestart", handleGestureStart as any, {
        capture: true,
      });
      el.removeEventListener("gesturechange", handleGestureChange as any, {
        capture: true,
      });
      el.removeEventListener("gestureend", handleGestureEnd as any, {
        capture: true,
      });
    };
  }, [isPlaying, onViewportChange, viewport.keyWidth]);

  // ── Pointer Down Interaction ───────────────────────────────────────────
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
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

  // ── Pointer Up Interaction ─────────────────────────────────────────────
  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    stopAutoScroll();

    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }

    const dragging = draggingRef.current;
    if (dragging) {
      const finalNotes = dragging.type === "velocity"
        ? velocityPaintRef.current?.notes ?? null
        : localNotes ?? pendingCommitRef.current;
      if (
        (dragging.type === "move" || dragging.type === "resize" || dragging.type === "draw" || dragging.type === "velocity" || dragging.type === "brush") &&
        finalNotes
      ) {
        pendingCommitRef.current = finalNotes;
        onNotesChange(finalNotes);
        triggerHaptic("generic");
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
        pendingCommitRef.current = null;
        setLocalNotes(null);
      } else {
        pendingCommitRef.current = null;
        setLocalNotes(null);
      }
    }
    draggingRef.current = null;
    controllerGestureRef.current = null;
    velocityPaintRef.current = null;
    setHoveredPitch(null);
    render();
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    stopAutoScroll();
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    // A cancelled gesture must not leave a speculative local preview or a
    // running RAF loop behind. The authoritative notes were not committed.
    setLocalNotes(null);
    pendingCommitRef.current = null;
    if (controllerGestureRef.current)
      setControllerPreview(controllerGestureRef.current.beforeLanes);
    controllerGestureRef.current = null;
    draggingRef.current = null;
    velocityPaintRef.current = null;
    lastDragDetentRef.current = null;
    render();
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
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

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden select-none bg-background"
    >
      {projectSong && projectCycle && projectSongLength > 0 && (
        <div
          className="pointer-events-none absolute top-0 z-20 h-9 overflow-hidden"
          style={{ left: viewport.keyWidth, right: 0 }}
        >
          <div className="relative h-full" style={{ left: -projectScrollPx, width: projectContentWidth }}>
            <Ruler
              layer="backdrop"
              pxPerSec={projectPixelsPerSecond}
              contentWidth={projectContentWidth}
              songLength={projectSongLength}
              bpm={projectSong.bpm || 120}
              tsNum={projectSong.tsNum || timeSignatureNumerator}
              scrollLeft={projectScrollPx}
              viewportWidth={Math.max(1, canvasSize.width - viewport.keyWidth)}
            />
            {onCycleToggleActive && onCycleSetRange && onCycleToggleSkip && (
              <CycleStrip
                song={projectSong}
                songIndex={projectSongIndex}
                songLength={projectSongLength}
                pxPerSec={projectPixelsPerSecond}
                cycle={projectCycle}
                ownsCycle={projectCycleOwner}
                bpm={projectSong.bpm || 120}
                tsNum={projectSong.tsNum || timeSignatureNumerator}
                snapToGrid={snap > 0}
                onToggleActive={onCycleToggleActive}
                onSetRange={onCycleSetRange}
                onToggleSkip={onCycleToggleSkip}
                onDragEnd={onCycleDragEnd}
              />
            )}
            <Ruler
              layer="labels"
              pxPerSec={projectPixelsPerSecond}
              contentWidth={projectContentWidth}
              songLength={projectSongLength}
              bpm={projectSong.bpm || 120}
              tsNum={projectSong.tsNum || timeSignatureNumerator}
              scrollLeft={projectScrollPx}
              viewportWidth={Math.max(1, canvasSize.width - viewport.keyWidth)}
            />
          </div>
        </div>
      )}
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
