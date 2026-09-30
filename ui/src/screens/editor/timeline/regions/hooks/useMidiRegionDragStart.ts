import { useCallback, type PointerEvent } from "react";
import { builder } from "@/lib/state/api";
import type { MidiRegionRow, SongRow } from "@/lib/state/types";
import type { RegionDragMode, RegionDragSession } from "@/screens/editor/timeline/regions/logic/regionDrag";
import { splitRegionsAtPlayhead } from "@/screens/editor/timeline/regions/logic/regionEdit";
import { regionSelKey } from "@/screens/editor/timeline/regions/logic/regionUtils";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";

interface MidiRegionDragStartOptions {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  readOnly: boolean;
  tool: TimelineTool;
  clearGeomDrafts: (keys: string[]) => void;
  startRegionDrag: (session: RegionDragSession) => void;
}

export interface MidiRegionDragStartRequest {
  event: PointerEvent;
  mode: RegionDragMode;
  region: MidiRegionRow;
  songIndex: number;
  songBpm: number;
  rowIndex: number;
  fallbackTrackId: string;
}

/** Owns MIDI-region erase, split, and drag-session setup for timeline gestures. */
export function useMidiRegionDragStart({
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  readOnly,
  tool,
  clearGeomDrafts,
  startRegionDrag,
}: MidiRegionDragStartOptions) {
  return useCallback(
    ({
      event,
      mode,
      region,
      songIndex,
      songBpm,
      rowIndex,
      fallbackTrackId,
    }: MidiRegionDragStartRequest) => {
      event.stopPropagation();
      event.preventDefault();
      if (readOnly) return;
      if (tool === "eraser") {
        void builder.midiRegionRemove(songIndex, region.id);
        return;
      }

      const bpm = songBpm > 0 ? songBpm : 120;
      if (tool === "scissors") {
        const rect = event.currentTarget.getBoundingClientRect();
        const clickSeconds = Math.max(
          0,
          Math.min(
            (region.durationBeats * 60) / bpm,
            (event.clientX - rect.left) / pxPerSec,
          ),
        );
        const absoluteSeconds =
          songOffsets[songIndex] +
          (region.startBeats * 60) / bpm +
          clickSeconds;
        const key = regionSelKey(songIndex, region.id);
        clearGeomDrafts([key]);
        void splitRegionsAtPlayhead(
          [key],
          songs,
          songOffsets,
          songLengths,
          absoluteSeconds,
        );
        return;
      }

      const key = regionSelKey(songIndex, region.id);
      const startSeconds = (region.startBeats * 60) / bpm;
      const durationSeconds = Math.max(
        0.05,
        (region.durationBeats * 60) / bpm,
      );
      const clipOffsetSeconds = (region.clipOffsetBeats * 60) / bpm;
      const loopLengthSeconds =
        region.loopLengthBeats > 0
          ? (region.loopLengthBeats * 60) / bpm
          : durationSeconds;
      const loopStartSeconds = ((region.loopStartBeats ?? 0) * 60) / bpm;
      const geom = {
        start: startSeconds,
        sourceOffset: clipOffsetSeconds,
        duration: durationSeconds,
        speed: 1,
        fadeIn: 0,
        fadeOut: 0,
        fadeInCurve: 0,
        fadeOutCurve: 0,
        loop: region.loop,
        loopLengthSeconds,
        loopStartSeconds,
        trackId: region.trackId,
      };
      const originTrackId = region.trackId || fallbackTrackId;

      startRegionDrag({
        key,
        kind: "midi",
        mode,
        startX: event.clientX,
        startY: event.clientY,
        songIndex,
        regionId: region.id,
        origStart: startSeconds,
        origSourceOffset: clipOffsetSeconds,
        origDuration: durationSeconds,
        origFadeIn: 0,
        origFadeOut: 0,
        origFadeInCurve: 0,
        origFadeOutCurve: 0,
        origLoop: region.loop,
        origLoopLength: loopLengthSeconds,
        origLoopStart: loopStartSeconds,
        origSpeed: 1,
        maxEnd: songLengths[songIndex] ?? 600,
        maxSourceDur: 3600,
        lastGeom: geom,
        originRowIndex: rowIndex,
        targetRowIndex: rowIndex,
        originTrackId,
        bpm,
        origStartBeats: region.startBeats,
        origDurationBeats: region.durationBeats,
      });
    },
    [
      clearGeomDrafts,
      pxPerSec,
      readOnly,
      songLengths,
      songOffsets,
      songs,
      startRegionDrag,
      tool,
    ],
  );
}
