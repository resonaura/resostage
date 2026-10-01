/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, type PointerEvent } from "react";
import { builder } from "@/lib/state/api";
import type { SongRow } from "@/lib/state/types";
import {
  buildRegionDragSession,
  regionStretchEdge,
  type RegionDragMode,
  type RegionDragSession,
  type RegionGeom,
} from "@/screens/editor/timeline/regions/logic/regionDrag";
import { splitRegionsAtPlayhead } from "@/screens/editor/timeline/regions/logic/regionEdit";
import type { RegionSelKey } from "@/screens/editor/timeline/regions/logic/regionUtils";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";

interface AudioRegionDragStartOptions {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  readOnly: boolean;
  tool: TimelineTool;
  clearGeomDrafts: (keys: RegionSelKey[]) => void;
  selectRegion: (
    key: RegionSelKey,
    event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => void;
  startRegionDrag: (session: RegionDragSession) => void;
}

export interface AudioRegionDragStartRequest {
  event: PointerEvent;
  mode: RegionDragMode;
  regionId: string;
  selectionKey: RegionSelKey;
  songIndex: number;
  rowIndex: number;
  fallbackTrackId: string;
  geom: RegionGeom;
  fileDuration: number;
}

/** Owns audio-region erase, split, stretch, and drag-session setup. */
export function useAudioRegionDragStart({
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  readOnly,
  tool,
  clearGeomDrafts,
  selectRegion,
  startRegionDrag,
}: AudioRegionDragStartOptions) {
  return useCallback(
    ({
      event,
      mode,
      regionId,
      selectionKey,
      songIndex,
      rowIndex,
      fallbackTrackId,
      geom,
      fileDuration,
    }: AudioRegionDragStartRequest) => {
      event.stopPropagation();
      event.preventDefault();

      if (!readOnly && tool === "eraser") {
        void builder.regionRemove(songIndex, regionId);
        return;
      }
      if (!readOnly && tool === "scissors") {
        const abs =
          songOffsets[songIndex] +
          geom.start +
          Math.max(
            0.02,
            Math.min(
              geom.duration - 0.02,
              (event.clientX -
                (event.currentTarget as HTMLElement).getBoundingClientRect()
                  .left) /
                pxPerSec,
            ),
          );
        // Drop the optimistic geometry first -- see the same call in
        // Timeline's splitSelectedAtPlayhead.
        clearGeomDrafts([selectionKey]);
        void splitRegionsAtPlayhead(
          [selectionKey],
          songs,
          songOffsets,
          songLengths,
          abs,
        );
        return;
      }

      selectRegion(selectionKey, event);
      // The stretch tool turns the whole region into one handle: there is only
      // one thing it can do, so aiming at a 6px edge would be busywork.
      if (tool === "stretch") {
        // Edges only. The middle of a region is not a handle: with one gesture
        // available, a click anywhere would rescale whatever it landed on.
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const edge = regionStretchEdge(event.clientX - rect.left, rect.width);
        if (!edge) return;
        startRegionDrag(
          buildRegionDragSession({
            key: selectionKey,
            mode: edge === "start" ? "stretchStart" : "stretch",
            clientX: event.clientX,
            clientY: event.clientY,
            songIndex,
            regionId,
            geom,
            originTrackId: fallbackTrackId,
            originRowIndex: rowIndex,
            segDuration: songLengths[songIndex] ?? 0,
            fileDuration,
          }),
        );
        return;
      }
      if (tool !== "pointer" && mode !== "slip") return;
      startRegionDrag(
        buildRegionDragSession({
          key: selectionKey,
          mode,
          clientX: event.clientX,
          clientY: event.clientY,
          songIndex,
          regionId,
          geom,
          originTrackId: fallbackTrackId,
          originRowIndex: rowIndex,
          segDuration: songLengths[songIndex],
          fileDuration,
        }),
      );
    },
    [
      clearGeomDrafts,
      pxPerSec,
      readOnly,
      selectRegion,
      songLengths,
      songOffsets,
      songs,
      startRegionDrag,
      tool,
    ],
  );
}
