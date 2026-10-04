/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { MidiNoteRow } from "@/lib/state/types";
import { useThemeVersion } from "@/hooks/useThemeVersion";
import { drawPianoRollCanvas } from "@/screens/editor/pianoroll/logic/pianoRollRenderer";
import type { PianoRollRenderParams } from "@/screens/editor/pianoroll/logic/pianoRollRenderer";
import {
  controllerYFromValue,
  isControllerLane,
  noteTextColor,
} from "@/screens/editor/pianoroll/logic/canvasUtils";
import type { DraggingState } from "@/screens/editor/pianoroll/logic/types";
import type { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";

interface PianoRollCanvasRendererOptions extends Omit<
  PianoRollRenderParams,
  | "canvasElement"
  | "spatialIndex"
  | "draggingState"
  | "noteTextColor"
  | "isControllerLane"
  | "controllerYFromValue"
> {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  spatialIndex: MutableRefObject<SpatialNoteIndex>;
  draggingRef: MutableRefObject<DraggingState | null>;
  /** Invalidation input: visible note changes mutate the existing index. */
  notesToRender: MidiNoteRow[];
}

/** Draws the Piano Roll canvas and keeps its backing resolution in sync with layout. */
export function usePianoRollCanvasRenderer({
  canvasRef,
  containerRef,
  spatialIndex,
  draggingRef,
  notesToRender,
  viewport,
  bottomLane,
  controllerLaneMode,
  region,
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
}: PianoRollCanvasRendererOptions) {
  const currentThemeVersion = useThemeVersion();
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const render = useCallback(() => {
    drawPianoRollCanvas({
      canvasElement: canvasRef.current,
      viewport,
      bottomLane,
      controllerLaneMode,
      region,
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
      spatialIndex: spatialIndex.current,
      draggingState: draggingRef.current,
      noteTextColor,
      isControllerLane,
      controllerYFromValue,
    });
  }, [
    canvasRef,
    draggingRef,
    spatialIndex,
    viewport,
    bottomLane,
    controllerLaneMode,
    region,
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
  }, [canvasRef, containerRef, render]);

  useEffect(() => {
    render();
  }, [render, notesToRender, currentThemeVersion]);

  return { canvasSize, render };
}
