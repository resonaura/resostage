import { useCallback, useEffect, useRef, useState } from "react";
import type { MidiNoteRow, MidiRegionRow } from "../../lib/state/types";
import type { TimelineFollowMode } from "../timeline/TimelineToolbar";
import { triggerHaptic } from "../../lib/interaction/haptics";
import {
  canvasYToPitch,
  generateNoteId,
  paintBrushNote,
  sliceNote,
} from "./pianoRollModel";
import {
  isBlackKey,
  isPitchInScale,
  pitchToName,
  snapPitchToScale,
} from "./scales";
import { SpatialNoteIndex } from "./spatialIndex";
import type {
  DraggingState,
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollTool,
  PianoRollViewport,
  ScaleMode,
} from "./types";

const RULER_HEIGHT = 26;

function isPrimaryModifier(event: Pick<PointerEvent, "metaKey" | "ctrlKey">) {
  const usesMetaKey = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  return usesMetaKey ? event.metaKey : event.ctrlKey;
}

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
}

function parseRgb(color?: string): [number, number, number] {
  if (!color) return [59, 130, 246];
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length >= 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  } else if (color.startsWith("rgb")) {
    const m = color.match(/\d+/g);
    if (m && m.length >= 3) {
      return [parseInt(m[0], 10), parseInt(m[1], 10), parseInt(m[2], 10)];
    }
  }
  return [59, 130, 246];
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
}: PianoRollCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const spatialIndex = useRef(new SpatialNoteIndex(4.0, 12));
  const draggingRef = useRef<DraggingState | null>(null);
  const [hoveredPitch, setHoveredPitch] = useState<number | null>(null);

  // Local working copy of notes during interactive drag to provide 120 FPS feedback
  // with zero network roundtrip latency or runaway accumulation.
  const [localNotes, setLocalNotes] = useState<MidiNoteRow[] | null>(null);
  const notesToRender = localNotes || region.notes;

  // Auto-scroll loop state while dragging notes near canvas edges
  const autoScrollRafRef = useRef<number | null>(null);
  const lastPointerPosRef = useRef<{ clientX: number; clientY: number }>({
    clientX: 0,
    clientY: 0,
  });
  const autoScrollTimeRef = useRef<number | null>(null);
  const lastDragDetentRef = useRef<string | null>(null);

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
    (beat: number) => {
      if (!region.loop || region.loopLengthBeats <= 0) return beat;
      const shifted = beat + region.clipOffsetBeats;
      return ((shifted % region.loopLengthBeats) + region.loopLengthBeats) % region.loopLengthBeats;
    },
    [region.loop, region.loopLengthBeats, region.clipOffsetBeats],
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
        (dragging.type !== "move" && dragging.type !== "resize")
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
      }

      autoScrollRafRef.current = requestAnimationFrame(tick);
    };

    autoScrollRafRef.current = requestAnimationFrame(tick);
  }, [
    onViewportChange,
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
  useEffect(() => {
    if (!isPlaying || followMode === "off" || isFollowSuspendedRef.current) {
      return;
    }
    if (playheadBeats === undefined) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.width / (window.devicePixelRatio || 1);
    const viewBeats = (width - viewport.keyWidth) / viewport.pixelsPerBeat;
    const minBeat = viewport.scrollBeats;
    const maxBeat = minBeat + viewBeats;

    if (followMode === "smooth") {
      // Smooth continuous follow: keep playhead around ~35% of the visible window
      const targetScroll = Math.max(0, playheadBeats - viewBeats * 0.35);
      if (Math.abs(viewport.scrollBeats - targetScroll) > 0.05) {
        onViewportChange((v) => ({
          ...v,
          scrollBeats: targetScroll,
        }));
      }
    } else if (followMode === "snap") {
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
    viewport.scrollBeats,
    onViewportChange,
  ]);

  // ── Render Loop ────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const gridTop = RULER_HEIGHT;
    const gridBottom = height - viewport.velocityLaneHeight;
    const gridHeight = gridBottom - gridTop;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // ── 1. Background Grid & Semitones (Clipped to Note Grid) ──────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(viewport.keyWidth, gridTop, width - viewport.keyWidth, gridHeight);
    ctx.clip();

    const minPitch = Math.max(0, Math.floor(viewport.scrollPitch));
    const maxPitch = Math.min(
      127,
      Math.ceil(viewport.scrollPitch + gridHeight / viewport.pixelsPerPitch),
    );

    for (let p = minPitch; p <= maxPitch; ++p) {
      const y = pitchToY(p, height);
      const isBlack = isBlackKey(p);
      const inScale = isPitchInScale(p, rootNote, scaleMode);

      if (isBlack) {
        ctx.fillStyle = inScale
          ? "rgba(25, 27, 33, 0.95)"
          : "rgba(16, 17, 21, 0.95)";
      } else {
        ctx.fillStyle = inScale
          ? "rgba(35, 38, 47, 0.85)"
          : "rgba(24, 26, 31, 0.85)";
      }
      ctx.fillRect(
        viewport.keyWidth,
        y,
        width - viewport.keyWidth,
        viewport.pixelsPerPitch,
      );

      // Pitch horizontal divider line
      ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(viewport.keyWidth, y + viewport.pixelsPerPitch);
      ctx.lineTo(width, y + viewport.pixelsPerPitch);
      ctx.stroke();
    }

    // ── 2. Vertical Beat & Bar Dividers ──────────────────────────────────
    const minBeat = Math.max(0, xToBeat(viewport.keyWidth));
    const maxBeat = xToBeat(width);
    const beatsPerBar = Math.max(1, Math.round(timeSignatureNumerator));
    const startBar = Math.floor(minBeat / beatsPerBar);
    const endBar = Math.ceil(maxBeat / beatsPerBar);

    for (let bar = startBar; bar <= endBar; ++bar) {
      for (let b = 0; b < beatsPerBar; ++b) {
        const beatNum = bar * beatsPerBar + b;
        const x = beatToX(beatNum);
        if (x < viewport.keyWidth || x > width) continue;

        const isBarLine = b === 0;
        ctx.beginPath();
        ctx.moveTo(x, gridTop);
        ctx.lineTo(x, gridBottom);
        ctx.strokeStyle = isBarLine
          ? "rgba(255, 255, 255, 0.18)"
          : "rgba(255, 255, 255, 0.06)";
        ctx.lineWidth = isBarLine ? 1.5 : 1;
        ctx.stroke();
      }
    }

    // A looping MIDI region repeats its source pattern up to its arrangement
    // duration. Draw repeat ticks from the live region values so changing the
    // loop length immediately updates the ruler/grid instead of leaving stale
    // decorative marks behind.
    if (region.loop && region.loopLengthBeats > 0 && region.durationBeats > region.loopLengthBeats) {
      const firstRepeat = Math.max(1, Math.floor(minBeat / region.loopLengthBeats));
      const lastRepeat = Math.ceil(Math.min(maxBeat, region.durationBeats) / region.loopLengthBeats);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(59, 130, 246, 0.55)";
      ctx.lineWidth = 1;
      for (let repeat = firstRepeat; repeat <= lastRepeat; repeat += 1) {
        const x = beatToX(repeat * region.loopLengthBeats);
        if (x < viewport.keyWidth || x > width) continue;
        ctx.beginPath();
        ctx.moveTo(x, gridTop);
        ctx.lineTo(x, gridBottom);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── 3. Ghost Notes (from companion tracks) ────────────────────────────
    if (showGhostNotes && companionRegions.length > 0) {
      ctx.fillStyle = "rgba(160, 174, 192, 0.18)";
      ctx.strokeStyle = "rgba(160, 174, 192, 0.35)";
      ctx.lineWidth = 1;

      for (const comp of companionRegions) {
        for (const note of comp.notes) {
          if (note.pitch < minPitch || note.pitch > maxPitch) continue;
          const relativeBeat =
            comp.startBeats - region.startBeats + note.startBeats;
          const x = beatToX(relativeBeat);
          const y = pitchToY(note.pitch, height);
          const w = Math.max(2, note.durationBeats * viewport.pixelsPerBeat);
          const h = viewport.pixelsPerPitch - 1;

          if (x + w < viewport.keyWidth || x > width) continue;

          ctx.fillRect(x, y + 1, w, h);
          ctx.strokeRect(x, y + 1, w, h);
        }
      }
    }

    // ── 4. Active MIDI Notes (from notesToRender) ──────────────────────────
    const sourceVisibleNotes = spatialIndex.current.queryRange(
      region.loop && region.loopLengthBeats > 0 ? 0 : minBeat,
      region.loop && region.loopLengthBeats > 0 ? region.loopLengthBeats : maxBeat,
      minPitch,
      maxPitch,
    );
    // Velocity is a time-domain lane. It must not inherit the pitch window
    // used to virtualize note bodies, otherwise its stalks disappear as soon
    // as the user scrolls those notes out of the vertical viewport.
    const sourceTimeVisibleNotes = spatialIndex.current.queryRange(
      region.loop && region.loopLengthBeats > 0 ? 0 : minBeat,
      region.loop && region.loopLengthBeats > 0 ? region.loopLengthBeats : maxBeat,
      0,
      127,
    );
    const expandLoopViews = (notes: MidiNoteRow[]) => {
      const views: Array<{ note: MidiNoteRow; beat: number }> = [];
      const length = region.loopLengthBeats;
      const repeats = region.loop && length > 0
        ? Math.max(1, Math.ceil(region.durationBeats / length) + 1)
        : 1;
      for (let repeat = 0; repeat < repeats && views.length < 20_000; repeat += 1) {
        const offset = region.loop && length > 0 ? repeat * length - region.clipOffsetBeats : 0;
        for (const note of notes) {
          const beat = note.startBeats + offset;
          if (
            beat + note.durationBeats > minBeat &&
            beat < maxBeat &&
            beat < region.durationBeats &&
            views.length < 20_000
          ) {
            views.push({ note, beat });
          }
        }
      }
      return views;
    };
    const visibleNotes = expandLoopViews(sourceVisibleNotes);
    const timeVisibleNotes = expandLoopViews(sourceTimeVisibleNotes);
    const [baseR, baseG, baseB] = parseRgb(trackColor);

    for (const { note, beat: noteBeat } of visibleNotes) {
      const isSelected = selectedNoteIds.has(note.id);
      const x = beatToX(noteBeat);
      const y = pitchToY(note.pitch, height);
      const w = Math.max(4, note.durationBeats * viewport.pixelsPerBeat);
      const h = Math.max(4, viewport.pixelsPerPitch - 2);

      const vel = Math.max(0.1, Math.min(1.0, note.velocity));
      const factor = 0.5 + 0.5 * vel;
      const nr = Math.min(255, Math.round(baseR * factor));
      const ng = Math.min(255, Math.round(baseG * factor));
      const nb = Math.min(255, Math.round(baseB * factor));

      ctx.fillStyle = isSelected
        ? "#ffd60a" // Logic Pro warm amber/gold for selected notes
        : `rgb(${nr}, ${ng}, ${nb})`;

      // Rounded rect note body
      ctx.beginPath();
      ctx.roundRect(x, y + 1, w, h, 3);
      ctx.fill();

      // Border styling
      ctx.strokeStyle = isSelected
        ? "rgba(255, 255, 255, 0.95)"
        : "rgba(0, 0, 0, 0.45)";
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      // Dynamic LOD: note pitch name and velocity
      if (w >= 24 && viewport.pixelsPerPitch >= 12) {
        ctx.fillStyle = isSelected ? "#000000" : "#ffffff";
        ctx.font = "bold 9px sans-serif";
        const name = pitchToName(note.pitch);
        if (w >= 54 && viewport.pixelsPerPitch >= 15) {
          const velVal = Math.round(note.velocity * 127);
          ctx.fillText(`${name} · ${velVal}`, x + 4, y + h - 2);
        } else {
          ctx.fillText(name, x + 4, y + h - 2);
        }
      }
    }

    // ── 5. Marquee Selection Box ─────────────────────────────────────────
    if (
      draggingRef.current?.type === "marquee" &&
      draggingRef.current.marqueeBox
    ) {
      const { startBeat, startPitch, currentBeat, currentPitch } =
        draggingRef.current.marqueeBox;
      const x1 = beatToX(Math.min(startBeat, currentBeat));
      const x2 = beatToX(Math.max(startBeat, currentBeat));
      const y1 = pitchToY(Math.max(startPitch, currentPitch), height);
      const y2 =
        pitchToY(Math.min(startPitch, currentPitch), height) +
        viewport.pixelsPerPitch;

      ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
      ctx.strokeStyle = "rgba(59, 130, 246, 0.85)";
      ctx.lineWidth = 1;
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

    ctx.restore(); // Restore grid clipping

    // ── 6. Piano Keyboard Margin (Left, Clipped to Keys) ─────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, gridTop, viewport.keyWidth, gridHeight);
    ctx.clip();

    ctx.fillStyle = "#121418";
    ctx.fillRect(0, gridTop, viewport.keyWidth, gridHeight);

    for (let p = minPitch; p <= maxPitch; ++p) {
      const y = pitchToY(p, height);
      const isBlack = isBlackKey(p);
      const isC = p % 12 === 0;

      if (p === hoveredPitch) {
        ctx.fillStyle = "#3b82f6";
      } else if (activeMidiPitches.has(p)) {
        ctx.fillStyle = isBlack ? "#9a5b00" : "#ffd166";
      } else {
        ctx.fillStyle = isBlack ? "#1e2128" : "#f1f3f5";
      }
      ctx.fillRect(0, y, viewport.keyWidth - 1, viewport.pixelsPerPitch);

      ctx.strokeStyle = "#0b0c0e";
      ctx.lineWidth = 1;
      ctx.strokeRect(0, y, viewport.keyWidth - 1, viewport.pixelsPerPitch);

      if (isC) {
        ctx.fillStyle = "#1e2128";
        ctx.font = "bold 9px sans-serif";
        ctx.fillText(pitchToName(p), 4, y + viewport.pixelsPerPitch - 4);
      }
    }

    ctx.restore(); // Restore keyboard clipping

    // Key / Grid vertical separator
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(viewport.keyWidth - 0.5, 0);
    ctx.lineTo(viewport.keyWidth - 0.5, gridBottom);
    ctx.stroke();

    // ── 7. Timeline Ruler Header (Top Bar: 0 .. RULER_HEIGHT) ─────────────
    ctx.fillStyle = "#14161c";
    ctx.fillRect(viewport.keyWidth, 0, width - viewport.keyWidth, RULER_HEIGHT);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(viewport.keyWidth, RULER_HEIGHT - 0.5);
    ctx.lineTo(width, RULER_HEIGHT - 0.5);
    ctx.stroke();

    // Loop range indicator if region loops
    if (region.loop && region.loopLengthBeats > 0) {
      const loopStartX = Math.max(viewport.keyWidth, beatToX(0));
      const loopEndX = Math.min(
        width,
        beatToX(Math.max(region.loopLengthBeats, region.durationBeats)),
      );
      if (loopEndX > loopStartX) {
        ctx.fillStyle = "rgba(59, 130, 246, 0.14)";
        ctx.fillRect(loopStartX, 0, loopEndX - loopStartX, RULER_HEIGHT - 1);
        ctx.fillStyle = "#3b82f6";
        ctx.fillRect(loopStartX, 0, loopEndX - loopStartX, 2);
      }
    }

    // Ruler bar and beat markings
    for (let bar = startBar; bar <= endBar; ++bar) {
      for (let b = 0; b < beatsPerBar; ++b) {
        const beatNum = bar * beatsPerBar + b;
        const x = beatToX(beatNum);
        if (x < viewport.keyWidth || x > width) continue;

        const isBar = b === 0;
        if (isBar) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, RULER_HEIGHT);
          ctx.stroke();

          ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
          ctx.font = "bold 10px sans-serif";
          ctx.fillText(`${bar + 1}`, x + 5, 14);
        } else {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, RULER_HEIGHT - 7);
          ctx.lineTo(x, RULER_HEIGHT);
          ctx.stroke();

          if (viewport.pixelsPerBeat >= 70) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
            ctx.font = "9px sans-serif";
            ctx.fillText(`${bar + 1}.${b + 1}`, x + 3, 13);
          }
        }
      }
    }

    // Top-left corner cell (above piano keys)
    ctx.fillStyle = "#101216";
    ctx.fillRect(0, 0, viewport.keyWidth, RULER_HEIGHT);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(viewport.keyWidth, RULER_HEIGHT - 0.5);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.font = "bold 9px sans-serif";
    ctx.fillText("KEYS", 8, 16);

    // ── 8. Bottom Lane (Velocity or CC Automation) ─────────────────────────
    const laneY = gridBottom;
    ctx.fillStyle = "#0e1014";
    ctx.fillRect(0, laneY, width, viewport.velocityLaneHeight);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, laneY);
    ctx.lineTo(width, laneY);
    ctx.stroke();

    if (bottomLane === "velocity") {
      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "9px sans-serif";
      ctx.fillText("VELOCITY", 8, laneY + 14);

      for (const { note, beat: noteBeat } of timeVisibleNotes) {
        const isSelected = selectedNoteIds.has(note.id);
        const x = beatToX(noteBeat);
        const vel = Math.max(0.01, Math.min(1.0, note.velocity));
        const stalkHeight = vel * (viewport.velocityLaneHeight - 20);
        const stalkBottom = height - 4;
        const stalkTop = stalkBottom - stalkHeight;

        const velColor = trackColor || "#3b82f6";
        ctx.strokeStyle = isSelected ? "#ffd60a" : velColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, stalkBottom);
        ctx.lineTo(x, stalkTop);
        ctx.stroke();

        ctx.fillStyle = isSelected ? "#ffd60a" : velColor;
        ctx.beginPath();
        ctx.arc(x, stalkTop, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      const laneLabels: Record<string, string> = {
        cc1: "CC 1 · MODULATION",
        cc11: "CC 11 · EXPRESSION",
        cc64: "CC 64 · SUSTAIN",
        pitchBend: "PITCH BEND",
      };
      const title = laneLabels[bottomLane] || bottomLane.toUpperCase();

      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "9px sans-serif";
      ctx.fillText(title, 8, laneY + 14);

      const isPB = bottomLane === "pitchBend";
      const topY = laneY + 18;
      const botY = height - 6;
      const midY = (topY + botY) / 2;

      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(viewport.keyWidth, topY);
      ctx.lineTo(width, topY);
      ctx.moveTo(viewport.keyWidth, botY);
      ctx.lineTo(width, botY);
      ctx.stroke();

      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(viewport.keyWidth, midY);
      ctx.lineTo(width, midY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "8px sans-serif";
      ctx.fillText(isPB ? "+8191" : "127", 6, topY + 4);
      ctx.fillText(isPB ? "0" : "64", 6, midY + 3);
      ctx.fillText(isPB ? "-8192" : "0", 6, botY - 1);

      const lane = region.automationLanes?.find(
        (l) =>
          l.target.parameterId === bottomLane ||
          (bottomLane === "cc1" && l.target.parameterId === "1") ||
          (bottomLane === "cc11" && l.target.parameterId === "11") ||
          (bottomLane === "cc64" && l.target.parameterId === "64"),
      );

      if (lane && lane.points && lane.points.length > 0) {
        const sorted = [...lane.points].sort(
          (a, b) => a.timeBeats - b.timeBeats,
        );
        const valToY = (v: number) => {
          const norm = isPB ? (v + 8192) / 16383 : v / 127;
          return botY - norm * (botY - topY);
        };

        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2;
        ctx.beginPath();
        sorted.forEach((pt, idx) => {
          const px = beatToX(pt.timeBeats);
          const py = valToY(pt.value);
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();

        if (sorted.length > 1) {
          ctx.fillStyle = "rgba(56, 189, 248, 0.12)";
          ctx.beginPath();
          const firstX = beatToX(sorted[0].timeBeats);
          const lastX = beatToX(sorted[sorted.length - 1].timeBeats);
          ctx.moveTo(firstX, botY);
          sorted.forEach((pt) => {
            ctx.lineTo(beatToX(pt.timeBeats), valToY(pt.value));
          });
          ctx.lineTo(lastX, botY);
          ctx.closePath();
          ctx.fill();
        }

        for (const pt of sorted) {
          const px = beatToX(pt.timeBeats);
          const py = valToY(pt.value);
          if (px >= viewport.keyWidth - 4 && px <= width + 4) {
            ctx.fillStyle = "#38bdf8";
            ctx.beginPath();
            ctx.arc(px, py, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
    }

    // ── 9. Playhead Line & Ruler Triangle Badge ────────────────────────────
    if (playheadBeats !== undefined) {
      const px = beatToX(playheadBeats);
      if (px >= viewport.keyWidth - 6 && px <= width + 6) {
        // Red vertical playhead line through grid and bottom lane
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, RULER_HEIGHT);
        ctx.lineTo(px, height);
        ctx.stroke();

        // Ruler downward playhead badge
        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.moveTo(px - 6, 2);
        ctx.lineTo(px + 6, 2);
        ctx.lineTo(px + 6, RULER_HEIGHT - 8);
        ctx.lineTo(px, RULER_HEIGHT - 1);
        ctx.lineTo(px - 6, RULER_HEIGHT - 8);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(px, 7, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }, [
    viewport,
    bottomLane,
    region,
    rootNote,
    scaleMode,
    showGhostNotes,
    companionRegions,
    selectedNoteIds,
    playheadBeats,
    activeMidiPitches,
    timeSignatureNumerator,
    hoveredPitch,
    trackColor,
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
        if (hit) {
          const vel = Math.max(
            0.01,
            Math.min(1.0, (height - y) / (viewport.velocityLaneHeight - 20)),
          );
          const updated = region.notes.map((n) =>
            n.id === hit.id ? { ...n, velocity: vel } : n,
          );
          onNotesChange(updated);
        }
        draggingRef.current = {
          type: "velocity",
          startPointerX: x,
          startPointerY: y,
          startBeat: beat,
          startPitch: 0,
          initialNotesSnapshot: new Map(region.notes.map((n) => [n.id, n])),
        };
      } else {
        const beat = Math.max(0, snapBeat(xToBeat(x)));
        const topY = gridBottom + 18;
        const botY = height - 6;
        const norm = Math.max(
          0,
          Math.min(1, (botY - y) / Math.max(1, botY - topY)),
        );
        const isPB = bottomLane === "pitchBend";
        const val = isPB
          ? Math.round(norm * 16383 - 8192)
          : Math.round(norm * 127);

        const lanes = region.automationLanes ? [...region.automationLanes] : [];
        let laneIdx = lanes.findIndex(
          (l) =>
            l.target.parameterId === bottomLane ||
            (bottomLane === "cc1" && l.target.parameterId === "1") ||
            (bottomLane === "cc11" && l.target.parameterId === "11") ||
            (bottomLane === "cc64" && l.target.parameterId === "64"),
        );

        if (laneIdx < 0) {
          lanes.push({
            id: `lane_${bottomLane}`,
            target: {
              domain: "midiCC",
              entityId: region.id,
              parameterId: bottomLane,
              valueType: "integer",
              defaultValue: 0,
              minValue: isPB ? -8192 : 0,
              maxValue: isPB ? 8191 : 127,
            },
            scope: "region",
            enabled: true,
            writeMode: "read",
            points: [{ timeBeats: beat, value: val, curve: 0 }],
          });
        } else {
          const lane = {
            ...lanes[laneIdx],
            points: [...lanes[laneIdx].points],
          };
          const existingPtIdx = lane.points.findIndex(
            (p) => Math.abs(p.timeBeats - beat) < 0.1,
          );
          if (existingPtIdx >= 0) {
            lane.points[existingPtIdx] = {
              ...lane.points[existingPtIdx],
              value: val,
            };
          } else {
            lane.points.push({ timeBeats: beat, value: val, curve: 0 });
            lane.points.sort((a, b) => a.timeBeats - b.timeBeats);
          }
          lanes[laneIdx] = lane;
        }

        onRegionChange?.({ ...region, automationLanes: lanes });
        draggingRef.current = {
          type: "cc",
          startPointerX: x,
          startPointerY: y,
          startBeat: beat,
          startPitch: 0,
          initialNotesSnapshot: new Map(region.notes.map((n) => [n.id, n])),
        };
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
      for (const note of region.notes) {
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
        onNotesChange(region.notes.filter((n) => n.id !== hit.note.id));
      }
      return;
    }

    if (tool === "slice") {
      if (hit) {
        const cutBeat = snap > 0 ? snapBeat(beat) : beat;
        const sliced = sliceNote(hit.note, cutBeat);
        if (sliced) {
          const [noteA, noteB] = sliced;
          const updated = region.notes
            .map((n) => (n.id === hit.note.id ? noteA : n))
            .concat(noteB);
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
        region.notes,
        snappedBeat,
        snappedPitch,
        dur,
      );
      if (painted) {
        onNotesChange(painted.updatedNotes);
        onSelectionChange(new Set([painted.newNote.id]));
      }
      draggingRef.current = {
        type: "brush",
        startPointerX: x,
        startPointerY: y,
        startBeat: snappedBeat,
        startPitch: snappedPitch,
        initialNotesSnapshot: new Map(region.notes.map((n) => [n.id, n])),
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
        const duration = snap > 0 ? snap : 1.0;
        const newNote: MidiNoteRow = {
          id: generateNoteId(),
          pitch: snappedPitch,
          startBeats: snappedBeat,
          durationBeats: duration,
          velocity: 0.8,
          releaseVelocity: 0.5,
          probability: 1.0,
        };

        const updated = [...region.notes, newNote];
        onNotesChange(updated);
        const targetIds = new Set([newNote.id]);
        onSelectionChange(targetIds);

        const initialMap = new Map<number, MidiNoteRow>();
        initialMap.set(newNote.id, { ...newNote });

        draggingRef.current = {
          type: "resize",
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
      const hit = spatialIndex.current.hitTestStart(
        beat,
        Math.max(0.08, 8 / viewport.pixelsPerBeat),
      );
      if (hit) {
        const updated = region.notes.map((n) =>
          n.id === hit.id ? { ...n, velocity: vel } : n,
        );
        onNotesChange(updated);
      }
      return;
    }

    // ── Dragging: CC Automation ──────────────────────────────────────────
    if (dragging.type === "cc" && onRegionChange) {
      const curBeat = Math.max(0, snapBeat(xToBeat(x)));
      const topY = gridBottom + 18;
      const botY = height - 6;
      const norm = Math.max(
        0,
        Math.min(1, (botY - y) / Math.max(1, botY - topY)),
      );
      const isPB = bottomLane === "pitchBend";
      const val = isPB
        ? Math.round(norm * 16383 - 8192)
        : Math.round(norm * 127);

      const lanes = region.automationLanes ? [...region.automationLanes] : [];
      const laneIdx = lanes.findIndex(
        (l) =>
          l.target.parameterId === bottomLane ||
          (bottomLane === "cc1" && l.target.parameterId === "1") ||
          (bottomLane === "cc11" && l.target.parameterId === "11") ||
          (bottomLane === "cc64" && l.target.parameterId === "64"),
      );
      if (laneIdx >= 0) {
        const lane = { ...lanes[laneIdx], points: [...lanes[laneIdx].points] };
        const existingPtIdx = lane.points.findIndex(
          (p) => Math.abs(p.timeBeats - curBeat) < 0.1,
        );
        if (existingPtIdx >= 0) {
          lane.points[existingPtIdx] = {
            ...lane.points[existingPtIdx],
            value: val,
          };
        } else {
          lane.points.push({ timeBeats: curBeat, value: val, curve: 0 });
          lane.points.sort((a, b) => a.timeBeats - b.timeBeats);
        }
        lanes[laneIdx] = lane;
        onRegionChange({ ...region, automationLanes: lanes });
      }
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
      const painted = paintBrushNote(region.notes, curBeat, curPitch, dur);
      if (painted) {
        onNotesChange(painted.updatedNotes);
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
      const updated = region.notes.map((note) => {
        if (!dragging.targetNoteIds?.has(note.id)) return note;
        const initial = dragging.initialNotesSnapshot.get(note.id);
        if (!initial) return note;
        const newBeat = Math.max(0, initial.startBeats + snappedDeltaBeats);
        const newPitch = Math.max(0, Math.min(127, initial.pitch + deltaPitch));
        return { ...note, startBeats: newBeat, pitch: newPitch };
      });

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

      const updated = region.notes.map((note) => {
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
    stopAutoScroll();

    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }

    const dragging = draggingRef.current;
    if (dragging) {
      if (
        (dragging.type === "move" || dragging.type === "resize") &&
        localNotes
      ) {
        onNotesChange(localNotes);
        triggerHaptic("generic");
      }
    }

    setLocalNotes(null);
    draggingRef.current = null;
    setHoveredPitch(null);
    render();
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    stopAutoScroll();
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    // A cancelled gesture must not leave a speculative local preview or a
    // running RAF loop behind. The authoritative notes were not committed.
    setLocalNotes(null);
    draggingRef.current = null;
    lastDragDetentRef.current = null;
    render();
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden select-none bg-background"
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        className="block h-full w-full touch-none"
      />
    </div>
  );
}
