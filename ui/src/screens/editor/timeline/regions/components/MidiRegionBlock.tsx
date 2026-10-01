/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import React from "react";
import type { MidiRegionRow, TrackRow } from "@/lib/state/types";
import { isCompactLane } from "@/screens/editor/timeline/layout/logic/laneDimensions";
import { RegionLoopBoundaries } from "@/screens/editor/timeline/regions/components/RegionLoopBoundaries";
import { TimelineRegionFrame } from "@/screens/editor/timeline/regions/components/TimelineRegionFrame";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";
import {
  regionEdgeMode,
  type RegionDragMode,
  type RegionGeomDraft,
} from "@/screens/editor/timeline/regions/logic/regionDrag";
import {
  midiRegionContainsLoopSourceBeat,
  midiRegionLoopOccurrence,
  midiRegionNotePlaybackDuration,
} from "@/lib/midi/midiRegionTiming";

export interface MidiRegionBlockProps {
  midiRegion: MidiRegionRow;
  songIndex: number;
  songBpm: number;
  rowName: string;
  rowColor: string;
  laneHeight: number;
  verticalZoom: number;
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
  rowName,
  rowColor,
  laneHeight,
  verticalZoom,
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
  const effectiveLoopStartBeats = geomDraft?.loopStartSeconds !== undefined
    ? (geomDraft.loopStartSeconds * bpm) / 60
    : (midiRegion.loopStartBeats ?? 0);
  const sourceRegion = {
    ...midiRegion,
    clipOffsetBeats: effectiveClipOffsetBeats,
    loopLengthBeats: effectiveLoopLengthBeats,
    loopStartBeats: effectiveLoopStartBeats,
    loop: effectiveLoop,
  };

  const startSeconds = (effectiveStartBeats * 60) / bpm;
  const durationSeconds = Math.max(0.05, (effectiveDurationBeats * 60) / bpm);
  const leftPx = startSeconds * pxPerSec;
  const widthPx = Math.max(12, durationSeconds * pxPerSec);
  const compactLane = isCompactLane(verticalZoom);
  const muted = midiRegion.muted;
  const labelText = `${muted ? "[M] " : ""}${rowName}${effectiveLoop ? " ↺" : ""}`;

  // Map the region's own pitch range to the lane, keeping a single pitch
  // centered. Small lanes use a readable minimum height, as in the compact
  // region overview described by the Logic research.
  let minPitch = Infinity;
  let maxPitch = -Infinity;
  for (const note of midiRegion.notes) {
    if (note.muted) continue;
    minPitch = Math.min(minPitch, note.pitch);
    maxPitch = Math.max(maxPitch, note.pitch);
  }
  const hasNotes = Number.isFinite(minPitch) && Number.isFinite(maxPitch);
  const pitchRange = hasNotes ? maxPitch - minPitch : 0;
  // The note coordinates are local to the visible region block, which is
  // inset from the lane by four pixels on each side. Keeping the calculation
  // inside that box prevents the bottom pitch from being clipped.
  const regionContentHeight = Math.max(1, laneHeight - 15);
  const noteAreaTop = compactLane
    ? 0
    : Math.min(18, Math.max(12, regionContentHeight * 0.34));
  const noteAreaHeight = Math.max(
    1,
    regionContentHeight - noteAreaTop - (compactLane ? 0 : 2),
  );
  const pitchStep = pitchRange > 0
    ? noteAreaHeight / (pitchRange + 1)
    : Math.min(4, noteAreaHeight);
  const noteHeight = Math.max(1, Math.min(4, pitchStep));
  const noteTop = (pitch: number) =>
    pitchRange > 0
      ? noteAreaTop + (maxPitch - pitch) * pitchStep
      : noteAreaTop + (noteAreaHeight - noteHeight) / 2;
  const loopLength = Math.max(0.03125, effectiveLoopLengthBeats);
  const estimatedInstanceCount = midiRegion.notes.reduce((total, note) => {
    if (note.muted) return total;
    if (effectiveLoop && !midiRegionContainsLoopSourceBeat(sourceRegion, note.startBeats))
      return total;
    const firstStart = effectiveLoop
      ? midiRegionLoopOccurrence(sourceRegion, note.startBeats)
      : note.startBeats - effectiveClipOffsetBeats;
    const visibleDuration = midiRegionNotePlaybackDuration(
      sourceRegion, note.startBeats, note.durationBeats,
    );
    if (!effectiveLoop) {
      return total + Number(
        firstStart + visibleDuration > 0 &&
          firstStart < effectiveDurationBeats,
      );
    }
    return total + Math.max(
      0,
      Math.ceil((effectiveDurationBeats - firstStart) / loopLength),
    );
  }, 0);
  const useAggregatedPreview =
    !compactLane && estimatedInstanceCount > 0 &&
    (pxPerSec * 60 / bpm < 1.5 || estimatedInstanceCount > 512);
  const noteInstances = midiRegion.notes.flatMap((note) => {
    if (note.muted || useAggregatedPreview) return [];
    if (effectiveLoop && !midiRegionContainsLoopSourceBeat(sourceRegion, note.startBeats))
      return [];
    const firstStart = effectiveLoop
      ? midiRegionLoopOccurrence(sourceRegion, note.startBeats)
      : note.startBeats - effectiveClipOffsetBeats;
    const visibleDuration = midiRegionNotePlaybackDuration(
      sourceRegion, note.startBeats, note.durationBeats,
    );
    if (!effectiveLoop) {
      return firstStart + visibleDuration > 0 &&
        firstStart < effectiveDurationBeats
        ? [{ note, displayStart: firstStart, iteration: 0 }]
        : [];
    }
    const firstIteration =
      Math.floor((-firstStart - visibleDuration) / loopLength) + 1;
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
        displayStart + visibleDuration > 0 &&
        displayStart < effectiveDurationBeats
      ) {
        instances.push({
          note: { ...note, durationBeats: visibleDuration },
          displayStart,
          iteration,
        });
      }
    }
    return instances;
  });
  const previewWidthPx = Math.max(1, widthPx - 7);
  const previewBinCount = Math.max(1, Math.min(1200, Math.ceil(previewWidthPx)));
  const previewBins = useAggregatedPreview
    ? (() => {
        const bins = new Map<number, { minPitch: number; maxPitch: number; density: number }>();
        for (const note of midiRegion.notes) {
          if (note.muted) continue;
          if (effectiveLoop && !midiRegionContainsLoopSourceBeat(sourceRegion, note.startBeats))
            continue;
          const firstStart = effectiveLoop
            ? midiRegionLoopOccurrence(sourceRegion, note.startBeats)
            : note.startBeats - effectiveClipOffsetBeats;
          const visibleDuration = midiRegionNotePlaybackDuration(
            sourceRegion, note.startBeats, note.durationBeats,
          );
          for (let bin = 0; bin < previewBinCount; bin += 1) {
            const binStart = (bin / previewBinCount) * effectiveDurationBeats;
            const binEnd = ((bin + 1) / previewBinCount) * effectiveDurationBeats;
            let overlapCount = 0;
            if (effectiveLoop) {
              const firstIteration =
                Math.floor((binStart - firstStart - visibleDuration) / loopLength) + 1;
              const lastIteration =
                Math.ceil((binEnd - firstStart) / loopLength) - 1;
              overlapCount = Math.max(0, lastIteration - firstIteration + 1);
            } else if (
              firstStart < binEnd &&
              firstStart + visibleDuration > binStart
            ) {
              overlapCount = 1;
            }
            if (overlapCount === 0) continue;
            const current = bins.get(bin);
            if (current) {
              current.minPitch = Math.min(current.minPitch, note.pitch);
              current.maxPitch = Math.max(current.maxPitch, note.pitch);
              current.density += overlapCount;
            } else {
              bins.set(bin, {
                minPitch: note.pitch,
                maxPitch: note.pitch,
                density: overlapCount,
              });
            }
          }
        }
        return [...bins.entries()];
    })()
    : [];
  const sustainIntervals = (() => {
    const sustainEvents = (midiRegion.events ?? []).filter((event) =>
      (event.status & 0xf0) === 0xb0 && event.data[0] === 64 && event.data.length > 1,
    );
    if (sustainEvents.length === 0) return [] as Array<{ start: number; end: number }>;

    const repeatLength = effectiveLoop ? loopLength : 0;
    const firstIteration = 0;
    const lastIteration = repeatLength > 0
      ? Math.ceil(effectiveDurationBeats / repeatLength)
      : 0;
    const expanded: Array<{ beat: number; channel: number; down: boolean }> = [];
    for (let iteration = firstIteration; iteration <= lastIteration && expanded.length < 10_000; iteration += 1) {
      for (const event of sustainEvents) {
        if (repeatLength > 0 && !midiRegionContainsLoopSourceBeat(sourceRegion, event.beat))
          continue;
        const firstStart = repeatLength > 0
          ? midiRegionLoopOccurrence(sourceRegion, event.beat)
          : event.beat - effectiveClipOffsetBeats;
        const beat = firstStart + iteration * repeatLength;
        if (beat >= effectiveDurationBeats) continue;
        expanded.push({
          beat,
          channel: event.status & 0x0f,
          down: event.data[1] >= 64,
        });
        if (expanded.length >= 10_000) break;
      }
    }
    expanded.sort((left, right) => left.beat - right.beat);

    const channels = new Set(expanded.map((event) => event.channel));
    const intervals: Array<{ start: number; end: number }> = [];
    for (const channel of channels) {
      const events = expanded.filter((event) => event.channel === channel);
      const beforeStart = events.filter((event) => event.beat <= 0);
      let down = beforeStart.at(-1)?.down ?? false;
      let start = 0;
      for (const event of events) {
        if (event.beat <= 0 || event.down === down) continue;
        if (down) intervals.push({ start, end: event.beat });
        else start = event.beat;
        down = event.down;
      }
      if (down) intervals.push({ start, end: effectiveDurationBeats });
    }
    return intervals.filter((interval) => interval.end > interval.start);
  })();

  const onRegionPointerDown = (e: React.PointerEvent) => {
    if (readOnly) return;
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    onSelect?.(e);
    const mode = regionEdgeMode(localX, localY, widthPx, rect.height);
    const effectiveMode: RegionDragMode =
      mode === "fadeIn" ? "trimStart" : mode === "fadeOut" ? "loopTrim" : mode;
    onBeginDrag?.(e, effectiveMode);
  };

  return (
    <TimelineRegionFrame
      color={rowColor}
      compact={compactLane}
      selected={isSelected}
      muted={midiRegion.muted}
      dimmed={dimmed || Boolean(midiRegion.muted)}
      data-region-block=""
      className={`absolute select-none overflow-hidden border ${
        compactLane
          ? "top-0.5 bottom-0.5 flex items-center rounded-sm"
          : "top-1 bottom-1 rounded-md"
      } ${
        isSelected
          ? "shadow-md z-20"
          : ""
      } ${isDragging ? "opacity-90 shadow-lg z-30 cursor-grabbing" : ""}`}
      style={{
        left: leftPx,
        width: widthPx,
        cursor: readOnly
          ? "default"
          : tool !== "pointer" && tool !== "pencil"
            ? "default"
            : isDragging
              ? "grabbing"
              : "grab",
        zIndex: isSelected ? 2 : 1,
      }}
      title={`${midiRegion.name || "MIDI Region"} · Drag to move · Edges to trim · Double-click to edit in Piano Roll`}
      onPointerDown={onRegionPointerDown}
      onPointerMove={(e) => {
        if (isDragging || readOnly) return;
        if (tool !== "pointer" && tool !== "pencil") return;
        const rect = e.currentTarget.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        const mode = regionEdgeMode(localX, localY, widthPx, rect.height);
        const c =
          mode === "trimStart" || mode === "trimEnd" || mode === "fadeIn"
            ? "col-resize"
            : mode === "loopTrim" || mode === "fadeOut"
              ? "alias"
              : "grab";
        if ((e.currentTarget as HTMLElement).style.cursor !== c) {
          (e.currentTarget as HTMLElement).style.cursor = c;
        }
      }}
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
      {/* Keep region labels visually identical to audio labels: track name,
          optional mute/loop markers, and the same compact-lane sizing. */}
      <div
        className={`pointer-events-none select-none max-w-[min(90%,14rem)] ${
          compactLane
            ? "relative z-3 shrink-0"
            : "absolute left-0.5 top-px z-3"
        }`}
        style={compactLane
          ? { paddingLeft: Math.max(1, Math.min(4, Math.round(laneHeight * 0.1))) }
          : undefined}
      >
        <span
          className="inline-block max-w-full truncate rounded-md font-semibold leading-none"
          style={{
            color: compactLane ? "#fff" : rowColor,
            fontSize: compactLane
              ? Math.max(7, Math.min(11, laneHeight - 10))
              : 10,
            paddingTop: compactLane ? 0 : 1,
            paddingBottom: compactLane ? 0 : 1,
            paddingLeft: compactLane
              ? Math.max(1, Math.min(4, Math.round(laneHeight * 0.12)))
              : 3,
            paddingRight: compactLane
              ? Math.max(1, Math.min(4, Math.round(laneHeight * 0.12)))
              : 3,
            background: "transparent",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
          }}
          title={labelText}
        >
          {labelText}
        </span>
      </div>

      {/* Note bodies use full note detail when readable and per-pixel pitch
          bands at low horizontal zoom to avoid turning dense regions into noise. */}
      {!compactLane && <div className="absolute inset-0.5 pointer-events-none">
        {useAggregatedPreview
          ? previewBins.map(([bin, value]) => {
              const top = noteTop(value.maxPitch);
              const bottom = noteTop(value.minPitch) + noteHeight;
              return (
                <span
                  key={`preview-bin-${bin}`}
                  className="absolute"
                  style={{
                    left: `${(bin / previewBinCount) * 100}%`,
                    width: `${100 / previewBinCount}%`,
                    top: `${top}px`,
                    height: `${Math.max(1, bottom - top)}px`,
                    backgroundColor: rowColor,
                    opacity: 1,
                  }}
                />
              );
            })
          : noteInstances.map(({ note, displayStart, iteration }) => {
              const visibleStart = Math.max(0, displayStart);
              const visibleEnd = Math.min(
                effectiveDurationBeats,
                displayStart + note.durationBeats,
              );
              if (visibleEnd <= visibleStart) return null;
              const noteLeftPercent =
                (visibleStart / effectiveDurationBeats) * 100;
              const noteWidthPercent = Math.max(
                (1 / previewWidthPx) * 100,
                ((visibleEnd - visibleStart) / effectiveDurationBeats) * 100,
              );
              return (
                <span
                  key={`${note.id}:${iteration}:${displayStart}`}
                  className="absolute rounded-xs"
                  style={{
                    left: `${noteLeftPercent}%`,
                    width: `${noteWidthPercent}%`,
                    top: `${noteTop(note.pitch)}px`,
                    height: `${noteHeight}px`,
                    backgroundColor: rowColor,
                    opacity: 1,
                  }}
                />
              );
            })}
        {sustainIntervals.map((interval, index) => {
          const start = Math.max(0, interval.start);
          const end = Math.min(effectiveDurationBeats, interval.end);
          if (end <= start) return null;
          return (
            <span
              key={`sustain-${index}`}
              className="absolute bottom-px h-0.5 rounded-none"
              style={{
                left: `${(start / effectiveDurationBeats) * 100}%`,
                width: `${Math.max((1 / previewWidthPx) * 100, ((end - start) / effectiveDurationBeats) * 100)}%`,
                backgroundColor: rowColor,
              }}
              title="Sustain pedal held"
            />
          );
        })}
      </div>}

      {/* Same loop-boundary language as audio regions: triangles at both
          edges plus a vertical seam for every repeated pattern. */}
      <RegionLoopBoundaries
        enabled={effectiveLoop}
        durationPx={widthPx}
        loopLengthPx={(effectiveLoopLengthBeats * 60 / bpm) * pxPerSec}
        color={rowColor}
      />
    </TimelineRegionFrame>
  );
}
