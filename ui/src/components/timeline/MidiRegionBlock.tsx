import React from "react";
import type { MidiRegionRow, TrackRow } from "../../lib/state/types";
import type { TimelineTool } from "./tools";
import type { RegionDragMode } from "./regionDrag";
import type { RegionGeomDraft } from "./regionDrag";

export interface MidiRegionBlockProps {
  midiRegion: MidiRegionRow;
  songIndex: number;
  songBpm: number;
  rowName: string;
  rowColor: string;
  laneHeight: number;
  pxPerSec: number;
  dimmed?: boolean;
  isSelected?: boolean;
  readOnly?: boolean;
  tool?: TimelineTool;
  tracks: TrackRow[];
  geomDraft?: RegionGeomDraft;
  isDragging?: boolean;
  onSelect?: (e: React.PointerEvent | React.MouseEvent) => void;
  onBeginDrag?: (e: React.PointerEvent, mode: RegionDragMode) => void;
  onOpenPianoRoll?: (trackId: string, regionId: string) => void;
  onContextMenu?: (e: React.MouseEvent, region: MidiRegionRow) => void;
}

export function MidiRegionBlock({
  midiRegion,
  songBpm,
  rowColor,
  laneHeight,
  pxPerSec,
  dimmed = false,
  isSelected = false,
  readOnly = false,
  tool = "pointer",
  geomDraft,
  isDragging = false,
  onSelect,
  onBeginDrag,
  onOpenPianoRoll,
  onContextMenu,
}: MidiRegionBlockProps) {
  const bpm = songBpm > 0 ? songBpm : 120;

  // Geometry: derived optimistically from geomDraft if active, falling back to committed region
  const effectiveStartBeats =
    geomDraft !== undefined
      ? (geomDraft.start * bpm) / 60
      : midiRegion.startBeats;
  const effectiveDurationBeats =
    geomDraft !== undefined
      ? (geomDraft.duration * bpm) / 60
      : midiRegion.durationBeats;
  const effectiveLoop = geomDraft?.loop ?? midiRegion.loop;
  const effectiveLoopLengthBeats =
    geomDraft?.loopLengthSeconds !== undefined
      ? (geomDraft.loopLengthSeconds * bpm) / 60
      : midiRegion.loopLengthBeats;
  const effectiveClipOffsetBeats =
    geomDraft?.sourceOffset !== undefined
      ? (geomDraft.sourceOffset * bpm) / 60
      : midiRegion.clipOffsetBeats;

  const startSeconds = (effectiveStartBeats * 60) / bpm;
  const durationSeconds = Math.max(0.05, (effectiveDurationBeats * 60) / bpm);
  const leftPx = startSeconds * pxPerSec;
  const widthPx = Math.max(12, durationSeconds * pxPerSec);

  // Pitch span for miniature note visualization
  const pitches = midiRegion.notes.map((note) => note.pitch);
  const minPitch = pitches.length ? Math.min(...pitches) : 48;
  const maxPitch = pitches.length ? Math.max(...pitches) : 72;
  const pitchSpan = Math.max(12, maxPitch - minPitch + 4);
  const noteAreaHeight = Math.max(16, laneHeight - 22);
  const noteInstances = midiRegion.notes.flatMap((note) => {
    const loopLength = Math.max(0.03125, effectiveLoopLengthBeats);
    const firstStart = note.startBeats - effectiveClipOffsetBeats;
    if (!effectiveLoop) {
      return firstStart + note.durationBeats > 0 &&
        firstStart < effectiveDurationBeats
        ? [{ note, displayStart: firstStart, iteration: 0 }]
        : [];
    }
    const firstIteration =
      Math.floor((-firstStart - note.durationBeats) / loopLength) + 1;
    const lastIteration =
      Math.ceil((effectiveDurationBeats - firstStart) / loopLength) - 1;
    const instances: Array<{
      note: (typeof midiRegion.notes)[number];
      displayStart: number;
      iteration: number;
    }> = [];
    for (
      let iteration = firstIteration;
      iteration <= lastIteration;
      iteration += 1
    ) {
      const displayStart = firstStart + iteration * loopLength;
      if (
        displayStart + note.durationBeats > 0 &&
        displayStart < effectiveDurationBeats
      ) {
        instances.push({ note, displayStart, iteration });
      }
    }
    return instances;
  });

  const handlePointerDown = (e: React.PointerEvent, mode: RegionDragMode) => {
    if (readOnly) return;
    if (e.button !== 0) return;
    onSelect?.(e);
    onBeginDrag?.(e, mode);
  };

  return (
    <div
      data-region-block=""
      className={`absolute top-1 bottom-1 select-none overflow-hidden rounded border transition-shadow ${
        isSelected
          ? "ring-2 ring-amber-400 border-amber-300 shadow-md z-20"
          : "hover:brightness-115"
      } ${isDragging ? "opacity-90 shadow-lg z-30 cursor-grabbing" : "cursor-pointer"}`}
      style={{
        left: leftPx,
        width: widthPx,
        backgroundColor: `color-mix(in srgb, ${rowColor} 42%, var(--background))`,
        borderColor: isSelected ? undefined : rowColor,
        opacity: dimmed || midiRegion.muted ? 0.35 : 1,
      }}
      title={`${midiRegion.name || "MIDI Region"} · Drag to move · Edges to trim · Double-click to edit in Piano Roll`}
      onPointerDown={(e) => handlePointerDown(e, "move")}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpenPianoRoll?.(midiRegion.trackId, midiRegion.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e, midiRegion);
      }}
    >
      {/* Header bar with title */}
      <div className="absolute left-1.5 top-0.5 z-10 flex items-center gap-1.5 max-w-[calc(100%-12px)] pointer-events-none">
        <span className="truncate text-[9.5px] font-semibold text-white/95 drop-shadow-sm">
          {midiRegion.name || "MIDI Region"}
        </span>
        {midiRegion.notes.length > 0 && (
          <span className="text-[8px] text-white/50 shrink-0 font-mono">
            {midiRegion.notes.length}n
          </span>
        )}
      </div>

      {/* Note bodies */}
      <div className="absolute inset-0 pointer-events-none">
        {noteInstances.map(({ note, displayStart, iteration }) => {
          const noteLeftPercent = Math.max(
            0,
            (displayStart / effectiveDurationBeats) * 100,
          );
          const noteWidthPercent = Math.max(
            0.5,
            (note.durationBeats / effectiveDurationBeats) * 100,
          );
          const noteTop =
            18 + ((maxPitch + 2 - note.pitch) / pitchSpan) * noteAreaHeight;
          const noteHeight = Math.max(2, noteAreaHeight / pitchSpan);

          return (
            <span
              key={`${note.id}:${iteration}:${displayStart}`}
              className="absolute rounded-[1px]"
              style={{
                left: `${noteLeftPercent}%`,
                width: `${noteWidthPercent}%`,
                top: `${noteTop}px`,
                height: `${noteHeight}px`,
                backgroundColor: `color-mix(in srgb, ${rowColor} 30%, white)`,
                opacity: 0.45 + note.velocity * 0.5,
              }}
            />
          );
        })}
      </div>

      {/* Same loop-boundary language as audio regions: triangles at both
          edges plus a vertical seam for every repeated pattern. */}
      {effectiveLoop &&
        effectiveLoopLengthBeats > 0 &&
        effectiveDurationBeats > effectiveLoopLengthBeats + 0.001 &&
        Array.from({
          length: Math.floor(effectiveDurationBeats / effectiveLoopLengthBeats),
        }).map((_, index) => {
          const x =
            (((index + 1) * effectiveLoopLengthBeats) /
              effectiveDurationBeats) *
            100;
          if (x >= 99.5) return null;
          return (
            <div
              key={`loop-${index}`}
              className="pointer-events-none absolute inset-y-0 z-10 border-l border-white/35"
              style={{ left: `${x}%` }}
              title="Loop boundary"
            >
              <span className="absolute -left-1 top-0 h-0 w-0 border-x-4 border-t-6 border-x-transparent border-t-white/80" />
              <span className="absolute -left-1 bottom-0 h-0 w-0 border-x-4 border-b-6 border-x-transparent border-b-white/80" />
            </div>
          );
        })}

      {/* Left Trim Handle */}
      {!readOnly && (tool === "pointer" || tool === "pencil") && (
        <div
          className="absolute left-0 top-0 bottom-0 w-2.5 cursor-col-resize hover:bg-white/30 z-20 transition-colors"
          title="Trim Start"
          onPointerDown={(e) => {
            e.stopPropagation();
            handlePointerDown(e, "trimStart");
          }}
        />
      )}

      {/* Logic-style right edge: upper part extends/creates a loop, lower
          part trims the authored region end. */}
      {!readOnly && (tool === "pointer" || tool === "pencil") && (
        <>
          <div
            className="absolute right-0 top-0 h-[65%] w-2.5 cursor-alias hover:bg-white/30 z-20 transition-colors"
            title="Loop Region"
            onPointerDown={(e) => {
              e.stopPropagation();
              handlePointerDown(e, "loopTrim");
            }}
          />
          <div
            className="absolute right-0 bottom-0 h-[35%] w-2.5 cursor-col-resize hover:bg-white/30 z-20 transition-colors"
            title="Trim End"
            onPointerDown={(e) => {
              e.stopPropagation();
              handlePointerDown(e, "trimEnd");
            }}
          />
        </>
      )}
    </div>
  );
}
