import { useCallback, useEffect, useRef, useState } from "react";
import type { MidiNoteRow, MidiRegionRow } from "../../lib/types";
import { paintBrushNote, sliceNote } from "./pianoRollModel";
import { isBlackKey, isPitchInScale, pitchToName, snapPitchToScale } from "./scales";
import { SpatialNoteIndex } from "./spatialIndex";
import type {
  DraggingState,
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollTool,
  PianoRollViewport,
  ScaleMode,
} from "./types";

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

const DEFAULT_VIEWPORT: PianoRollViewport = {
  pixelsPerBeat: 80,
  pixelsPerPitch: 18,
  scrollBeats: 0,
  scrollPitch: 48, // Start around C3 (pitch 48)
  keyWidth: 54,
  velocityLaneHeight: 90,
};

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
}: PianoRollCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [viewport, setViewport] = useState<PianoRollViewport>(DEFAULT_VIEWPORT);
  const spatialIndex = useRef(new SpatialNoteIndex(4.0, 12));
  const draggingRef = useRef<DraggingState | null>(null);
  const [hoveredPitch, setHoveredPitch] = useState<number | null>(null);

  // Sync spatial index whenever region notes change
  useEffect(() => {
    spatialIndex.current.rebuild(region.notes);
  }, [region.notes]);

  // Coordinate transforms
  const beatToX = useCallback(
    (beat: number) => {
      return viewport.keyWidth + (beat - viewport.scrollBeats) * viewport.pixelsPerBeat;
    },
    [viewport.keyWidth, viewport.scrollBeats, viewport.pixelsPerBeat],
  );

  const xToBeat = useCallback(
    (x: number) => {
      return viewport.scrollBeats + (x - viewport.keyWidth) / viewport.pixelsPerBeat;
    },
    [viewport.keyWidth, viewport.scrollBeats, viewport.pixelsPerBeat],
  );

  const pitchToY = useCallback(
    (pitch: number, height: number) => {
      const gridHeight = height - viewport.velocityLaneHeight;
      // High pitches at top, low pitches at bottom
      return gridHeight - (pitch - viewport.scrollPitch + 1) * viewport.pixelsPerPitch;
    },
    [viewport.velocityLaneHeight, viewport.scrollPitch, viewport.pixelsPerPitch],
  );

  const yToPitch = useCallback(
    (y: number, height: number) => {
      const gridHeight = height - viewport.velocityLaneHeight;
      return viewport.scrollPitch + Math.floor((gridHeight - y) / viewport.pixelsPerPitch);
    },
    [viewport.velocityLaneHeight, viewport.scrollPitch, viewport.pixelsPerPitch],
  );

  // Quantize beat to grid snap
  const snapBeat = useCallback(
    (beat: number): number => {
      if (snap <= 0) return Math.max(0, beat);
      return Math.max(0, Math.round(beat / snap) * snap);
    },
    [snap],
  );

  // Render loop
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width / (window.devicePixelRatio || 1);
    const height = canvas.height / (window.devicePixelRatio || 1);
    const gridHeight = height - viewport.velocityLaneHeight;

    ctx.save();
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, width, height);

    // ── 1. Background Grid & Semitones ─────────────────────────────────────
    const minPitch = Math.max(0, Math.floor(viewport.scrollPitch));
    const maxPitch = Math.min(
      127,
      Math.ceil(viewport.scrollPitch + gridHeight / viewport.pixelsPerPitch),
    );

    for (let p = minPitch; p <= maxPitch; ++p) {
      const y = pitchToY(p, height);
      const isBlack = isBlackKey(p);
      const inScale = isPitchInScale(p, rootNote, scaleMode);

      // Row background
      if (isBlack) {
        ctx.fillStyle = inScale ? "rgba(25, 27, 33, 0.95)" : "rgba(16, 17, 21, 0.95)";
      } else {
        ctx.fillStyle = inScale ? "rgba(35, 38, 47, 0.85)" : "rgba(24, 26, 31, 0.85)";
      }
      ctx.fillRect(viewport.keyWidth, y, width - viewport.keyWidth, viewport.pixelsPerPitch);

      // Pitch divider line
      ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(viewport.keyWidth, y + viewport.pixelsPerPitch);
      ctx.lineTo(width, y + viewport.pixelsPerPitch);
      ctx.stroke();
    }

    // ── 2. Vertical Beat & Bar Dividers ────────────────────────────────────
    const minBeat = Math.max(0, xToBeat(viewport.keyWidth));
    const maxBeat = xToBeat(width);
    const startBar = Math.floor(minBeat / 4.0);
    const endBar = Math.ceil(maxBeat / 4.0);

    for (let bar = startBar; bar <= endBar; ++bar) {
      // 4 beats per bar in standard 4/4
      for (let b = 0; b < 4; ++b) {
        const beatNum = bar * 4 + b;
        const x = beatToX(beatNum);
        if (x < viewport.keyWidth || x > width) continue;

        const isBarLine = b === 0;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, gridHeight);
        ctx.strokeStyle = isBarLine ? "rgba(255, 255, 255, 0.22)" : "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = isBarLine ? 1.5 : 1;
        ctx.stroke();

        // Bar numbers along top header
        if (isBarLine && yToPitch(0, height) <= 127) {
          ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
          ctx.font = "10px sans-serif";
          ctx.fillText(`Bar ${bar + 1}`, x + 4, 12);
        }
      }
    }

    // ── 3. Ghost Notes (from companion tracks) ──────────────────────────────
    if (showGhostNotes && companionRegions.length > 0) {
      ctx.fillStyle = "rgba(160, 174, 192, 0.18)";
      ctx.strokeStyle = "rgba(160, 174, 192, 0.35)";
      ctx.lineWidth = 1;

      for (const comp of companionRegions) {
        for (const note of comp.notes) {
          if (note.pitch < minPitch || note.pitch > maxPitch) continue;
          const x = beatToX(note.startBeats);
          const y = pitchToY(note.pitch, height);
          const w = Math.max(2, note.durationBeats * viewport.pixelsPerBeat);
          const h = viewport.pixelsPerPitch - 1;

          if (x + w < viewport.keyWidth || x > width) continue;

          ctx.fillRect(x, y + 1, w, h);
          ctx.strokeRect(x, y + 1, w, h);
        }
      }
    }

    // ── 4. Active MIDI Notes ───────────────────────────────────────────────
    const visibleNotes = spatialIndex.current.queryRange(minBeat, maxBeat, minPitch, maxPitch);
    const [baseR, baseG, baseB] = parseRgb(trackColor);

    for (const note of visibleNotes) {
      const isSelected = selectedNoteIds.has(note.id);
      const x = beatToX(note.startBeats);
      const y = pitchToY(note.pitch, height);
      const w = Math.max(4, note.durationBeats * viewport.pixelsPerBeat);
      const h = Math.max(4, viewport.pixelsPerPitch - 2);

      // Track-color velocity modulation: dim at low velocity, vibrant at high velocity
      const vel = Math.max(0.1, Math.min(1.0, note.velocity));
      const factor = 0.5 + 0.5 * vel;
      const nr = Math.min(255, Math.round(baseR * factor));
      const ng = Math.min(255, Math.round(baseG * factor));
      const nb = Math.min(255, Math.round(baseB * factor));

      ctx.fillStyle = isSelected
        ? "#ffd60a" // Logic Pro warm amber/gold for selected
        : `rgb(${nr}, ${ng}, ${nb})`;

      // Note rounded rect body
      ctx.beginPath();
      ctx.roundRect(x, y + 1, w, h, 3);
      ctx.fill();

      // Border styling
      ctx.strokeStyle = isSelected ? "rgba(255, 255, 255, 0.95)" : "rgba(0, 0, 0, 0.45)";
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      // Dynamic LOD: note pitch name and velocity inside note body
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

    // ── 5. Marquee Selection Box ───────────────────────────────────────────
    if (draggingRef.current?.type === "marquee" && draggingRef.current.marqueeBox) {
      const { startBeat, startPitch, currentBeat, currentPitch } =
        draggingRef.current.marqueeBox;
      const x1 = beatToX(Math.min(startBeat, currentBeat));
      const x2 = beatToX(Math.max(startBeat, currentBeat));
      const y1 = pitchToY(Math.max(startPitch, currentPitch), height);
      const y2 = pitchToY(Math.min(startPitch, currentPitch), height) + viewport.pixelsPerPitch;

      ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
      ctx.strokeStyle = "rgba(59, 130, 246, 0.85)";
      ctx.lineWidth = 1;
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

    // ── 6. Piano Keyboard Margin (Left) ────────────────────────────────────
    ctx.fillStyle = "#121418";
    ctx.fillRect(0, 0, viewport.keyWidth, gridHeight);

    for (let p = minPitch; p <= maxPitch; ++p) {
      const y = pitchToY(p, height);
      const isBlack = isBlackKey(p);
      const isC = p % 12 === 0;

      if (p === hoveredPitch) {
        ctx.fillStyle = "#3b82f6";
      } else {
        ctx.fillStyle = isBlack ? "#1e2128" : "#f1f3f5";
      }
      ctx.fillRect(0, y, viewport.keyWidth - 1, viewport.pixelsPerPitch);

      ctx.strokeStyle = "#0b0c0e";
      ctx.lineWidth = 1;
      ctx.strokeRect(0, y, viewport.keyWidth - 1, viewport.pixelsPerPitch);

      // Label octave on C keys (e.g. C3, C4)
      if (isC) {
        ctx.fillStyle = "#1e2128";
        ctx.font = "bold 9px sans-serif";
        ctx.fillText(pitchToName(p), 4, y + viewport.pixelsPerPitch - 4);
      }
    }

    // Key / Grid vertical separator
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(viewport.keyWidth, 0);
    ctx.lineTo(viewport.keyWidth, gridHeight);
    ctx.stroke();

    // ── 7. Playhead Line ───────────────────────────────────────────────────
    if (playheadBeats !== undefined && playheadBeats >= minBeat && playheadBeats <= maxBeat) {
      const px = beatToX(playheadBeats);
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();

      // Playhead triangle cap
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();
    }

    // ── 8. Bottom Lane (Velocity or CC Automation) ─────────────────────────
    const laneY = gridHeight;
    ctx.fillStyle = "#0e1014";
    ctx.fillRect(0, laneY, width, viewport.velocityLaneHeight);

    // Lane header divider
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, laneY);
    ctx.lineTo(width, laneY);
    ctx.stroke();

    if (bottomLane === "velocity") {
      // Lane title
      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "9px sans-serif";
      ctx.fillText("VELOCITY", 8, laneY + 14);

      // Render velocity lollipops for visible notes
      for (const note of visibleNotes) {
        const isSelected = selectedNoteIds.has(note.id);
        const x = beatToX(note.startBeats);
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

        // Circular lollipop knob
        ctx.fillStyle = isSelected ? "#ffd60a" : velColor;
        ctx.beginPath();
        ctx.arc(x, stalkTop, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // CC Automation Lane
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

      // Value grid lines: min, mid (dashed), max
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

      // Dotted mid line
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(viewport.keyWidth, midY);
      ctx.lineTo(width, midY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Margin scale labels
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "8px sans-serif";
      ctx.fillText(isPB ? "+8191" : "127", 6, topY + 4);
      ctx.fillText(isPB ? "0" : "64", 6, midY + 3);
      ctx.fillText(isPB ? "-8192" : "0", 6, botY - 1);

      // Automation points if present
      const lane = region.automationLanes?.find(
        (l) =>
          l.target.parameterId === bottomLane ||
          (bottomLane === "cc1" && l.target.parameterId === "1") ||
          (bottomLane === "cc11" && l.target.parameterId === "11") ||
          (bottomLane === "cc64" && l.target.parameterId === "64"),
      );

      if (lane && lane.points && lane.points.length > 0) {
        const sorted = [...lane.points].sort((a, b) => a.timeBeats - b.timeBeats);
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

        // Fill area under curve
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

        // Point knobs
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
    hoveredPitch,
    beatToX,
    xToBeat,
    pitchToY,
    yToPitch,
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

  // Pointer interactions
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const height = rect.height;
    const gridHeight = height - viewport.velocityLaneHeight;

    canvas.setPointerCapture(e.pointerId);

    // Click in bottom lane (velocity or CC automation)
    if (y >= gridHeight) {
      if (bottomLane === "velocity") {
        const beat = xToBeat(x);
        const hit = spatialIndex.current.hitTest(beat, Math.floor(viewport.scrollPitch + 12), 0.5);
        if (hit) {
          const vel = Math.max(0.01, Math.min(1.0, (height - y) / (viewport.velocityLaneHeight - 20)));
          const updated = region.notes.map((n) =>
            n.id === hit.note.id ? { ...n, velocity: vel } : n,
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
        // CC lane editing
        const beat = Math.max(0, snapBeat(xToBeat(x)));
        const topY = gridHeight + 18;
        const botY = height - 6;
        const norm = Math.max(0, Math.min(1, (botY - y) / Math.max(1, botY - topY)));
        const isPB = bottomLane === "pitchBend";
        const val = isPB ? Math.round(norm * 16383 - 8192) : Math.round(norm * 127);

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
          const lane = { ...lanes[laneIdx], points: [...lanes[laneIdx].points] };
          const existingPtIdx = lane.points.findIndex(
            (p) => Math.abs(p.timeBeats - beat) < 0.1,
          );
          if (existingPtIdx >= 0) {
            lane.points[existingPtIdx] = { ...lane.points[existingPtIdx], value: val };
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

    // Click in Piano keyboard margin (audition)
    if (x < viewport.keyWidth) {
      const pitch = yToPitch(y, height);
      setHoveredPitch(pitch);
      return;
    }

    const beat = xToBeat(x);
    const pitch = yToPitch(y, height);

    // Check hit test on existing notes
    const hit = spatialIndex.current.hitTest(beat, pitch, 0.15);

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
      const painted = paintBrushNote(region.notes, snappedBeat, snappedPitch, dur);
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

    if (tool === "draw") {
      if (hit) {
        // Clicking note with draw tool selects it for moving
        const newSel = new Set([hit.note.id]);
        onSelectionChange(newSel);
        draggingRef.current = {
          type: "move",
          startPointerX: x,
          startPointerY: y,
          startBeat: hit.note.startBeats,
          startPitch: hit.note.pitch,
          initialNotesSnapshot: new Map(region.notes.map((n) => [n.id, n])),
        };
      } else {
        // Create new note
        const snappedBeat = snapBeat(beat);
        let snappedPitch = Math.max(0, Math.min(127, pitch));
        if (snapToScale) {
          snappedPitch = snapPitchToScale(snappedPitch, rootNote, scaleMode);
        }
        const duration = snap > 0 ? snap : 1.0;
        const newNote: MidiNoteRow = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          pitch: snappedPitch,
          startBeats: snappedBeat,
          durationBeats: duration,
          velocity: 0.8,
          releaseVelocity: 0.5,
          probability: 1.0,
        };

        const updated = [...region.notes, newNote];
        onNotesChange(updated);
        onSelectionChange(new Set([newNote.id]));

        draggingRef.current = {
          type: "resize",
          startPointerX: x,
          startPointerY: y,
          startBeat: snappedBeat,
          startPitch: snappedPitch,
          initialNotesSnapshot: new Map(updated.map((n) => [n.id, n])),
        };
      }
      return;
    }

    // Select Tool
    if (hit) {
      const isShift = e.shiftKey;
      let newSelection = new Set(selectedNoteIds);
      if (isShift) {
        if (newSelection.has(hit.note.id)) newSelection.delete(hit.note.id);
        else newSelection.add(hit.note.id);
      } else if (!newSelection.has(hit.note.id)) {
        newSelection = new Set([hit.note.id]);
      }
      onSelectionChange(newSelection);

      draggingRef.current = {
        type: hit.isResizeHandle ? "resize" : "move",
        startPointerX: x,
        startPointerY: y,
        startBeat: hit.note.startBeats,
        startPitch: hit.note.pitch,
        initialNotesSnapshot: new Map(region.notes.map((n) => [n.id, n])),
      };
    } else {
      // Click on background: start marquee selection
      if (!e.shiftKey) {
        onSelectionChange(new Set());
      }
      draggingRef.current = {
        type: "marquee",
        startPointerX: x,
        startPointerY: y,
        startBeat: beat,
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

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !draggingRef.current) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const height = rect.height;
    const gridHeight = height - viewport.velocityLaneHeight;
    const dragging = draggingRef.current;

    if (dragging.type === "velocity") {
      const vel = Math.max(0.01, Math.min(1.0, (height - y) / (viewport.velocityLaneHeight - 20)));
      const beat = xToBeat(x);
      const hit = spatialIndex.current.hitTest(beat, Math.floor(viewport.scrollPitch + 12), 0.5);
      if (hit) {
        const updated = region.notes.map((n) =>
          n.id === hit.note.id ? { ...n, velocity: vel } : n,
        );
        onNotesChange(updated);
      }
      return;
    }

    if (dragging.type === "cc" && onRegionChange) {
      const curBeat = Math.max(0, snapBeat(xToBeat(x)));
      const topY = gridHeight + 18;
      const botY = height - 6;
      const norm = Math.max(0, Math.min(1, (botY - y) / Math.max(1, botY - topY)));
      const isPB = bottomLane === "pitchBend";
      const val = isPB ? Math.round(norm * 16383 - 8192) : Math.round(norm * 127);

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
          lane.points[existingPtIdx] = { ...lane.points[existingPtIdx], value: val };
        } else {
          lane.points.push({ timeBeats: curBeat, value: val, curve: 0 });
          lane.points.sort((a, b) => a.timeBeats - b.timeBeats);
        }
        lanes[laneIdx] = lane;
        onRegionChange({ ...region, automationLanes: lanes });
      }
      return;
    }

    if (dragging.type === "brush") {
      const curBeat = snapBeat(xToBeat(x));
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

    if (dragging.type === "move") {
      const deltaX = x - dragging.startPointerX;
      const deltaY = y - dragging.startPointerY;
      const deltaBeats = deltaX / viewport.pixelsPerBeat;
      const deltaPitch = -Math.round(deltaY / viewport.pixelsPerPitch);

      const updated = region.notes.map((note) => {
        if (!selectedNoteIds.has(note.id)) return note;
        const initial = dragging.initialNotesSnapshot.get(note.id) || note;
        const newBeat = snapBeat(Math.max(0, initial.startBeats + deltaBeats));
        const newPitch = Math.max(0, Math.min(127, initial.pitch + deltaPitch));
        return { ...note, startBeats: newBeat, pitch: newPitch };
      });

      onNotesChange(updated);
    } else if (dragging.type === "resize") {
      const deltaX = x - dragging.startPointerX;
      const deltaBeats = deltaX / viewport.pixelsPerBeat;

      const updated = region.notes.map((note) => {
        if (!selectedNoteIds.has(note.id)) return note;
        const initial = dragging.initialNotesSnapshot.get(note.id) || note;
        const rawDuration = initial.durationBeats + deltaBeats;
        const snappedDuration =
          snap > 0 ? Math.max(snap, snapBeat(rawDuration)) : Math.max(0.125, rawDuration);
        return { ...note, durationBeats: snappedDuration };
      });

      onNotesChange(updated);
    } else if (dragging.type === "marquee" && dragging.marqueeBox) {
      const currentBeat = xToBeat(x);
      const currentPitch = yToPitch(y, height);
      dragging.marqueeBox.currentBeat = currentBeat;
      dragging.marqueeBox.currentPitch = currentPitch;

      const minB = Math.min(dragging.marqueeBox.startBeat, currentBeat);
      const maxB = Math.max(dragging.marqueeBox.startBeat, currentBeat);
      const minP = Math.min(dragging.marqueeBox.startPitch, currentPitch);
      const maxP = Math.max(dragging.marqueeBox.startPitch, currentPitch);

      const enclosedNotes = spatialIndex.current.queryRange(minB, maxB, minP, maxP);
      onSelectionChange(new Set(enclosedNotes.map((n) => n.id)));
      render();
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    draggingRef.current = null;
    setHoveredPitch(null);
    render();
  };

  // Zoom and pan via wheel
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Horizontal zoom
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      setViewport((v) => ({
        ...v,
        pixelsPerBeat: Math.max(20, Math.min(400, v.pixelsPerBeat * zoomFactor)),
      }));
    } else if (e.altKey) {
      // Vertical zoom
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      setViewport((v) => ({
        ...v,
        pixelsPerPitch: Math.max(10, Math.min(40, v.pixelsPerPitch * zoomFactor)),
      }));
    } else if (e.shiftKey) {
      // Horizontal scroll
      setViewport((v) => ({
        ...v,
        scrollBeats: Math.max(0, v.scrollBeats + (e.deltaY || e.deltaX) / v.pixelsPerBeat),
      }));
    } else {
      // Vertical pitch scroll
      setViewport((v) => ({
        ...v,
        scrollPitch: Math.max(0, Math.min(100, v.scrollPitch - e.deltaY / v.pixelsPerPitch)),
      }));
    }
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden select-none bg-background">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        className="block h-full w-full cursor-crosshair touch-none"
      />
    </div>
  );
}
