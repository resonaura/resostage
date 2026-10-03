/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useRef, useState } from "react";
import { beginCancellableDrag, type CancellableDrag } from "@/lib/interaction/dragCancel";
import type { SongRow, TrackRow } from "@/lib/state/types";
import type { CueSelKey } from "@/screens/editor/timeline/lighting/logic/types";
import { laneHeightPx } from "@/screens/editor/timeline/layout/logic/laneDimensions";
import {
  normalizeMarquee,
  resolveMarqueeSelection,
  type MarqueeRect,
} from "@/screens/editor/timeline/selection/logic/marqueeSelect";
import type { TimelineViewMode } from "@/screens/editor/timeline/toolbar/logic/types";
import type { TimelineRow } from "@/screens/editor/timeline/layout/logic/rows";
import type { RegionSelKey } from "@/screens/editor/timeline/regions/logic/regionUtils";

interface TimelineMarqueeOptions {
  viewMode: TimelineViewMode;
  lightTrackIds: string[];
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  verticalZoom: number;
  rows: TimelineRow[];
  rowHeights?: number[];
  tracks: TrackRow[];
  hasSongs: boolean;
  readOnly: boolean;
  tracksOriginRef: { current: HTMLDivElement | null };
  selectedRegionKeys: RegionSelKey[];
  selectedCueKeys: CueSelKey[];
  setSelectedRegionKeys: (keys: RegionSelKey[]) => void;
  setSelectedCueKeys: (keys: CueSelKey[]) => void;
  setCueSelection: (key: CueSelKey | null) => void;
  seekFromClientX: (clientX: number, commit?: boolean) => void;
}

interface MarqueeGesture {
  x0: number;
  y0: number;
  active: boolean;
  additive: boolean;
  /** Selection snapshot at marquee start (for shift/⌘ additive merge). */
  baseRegionKeys: RegionSelKey[];
  baseCueKeys: CueSelKey[];
}

interface MarqueeLiveInputs {
  viewMode: TimelineViewMode;
  lightTrackIds: string[];
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  verticalZoom: number;
  rows: TimelineRow[];
  rowHeights?: number[];
  tracks: TrackRow[];
}

/**
 * Owns the empty-lane marquee gesture and its live audio/light hit-testing.
 * Region and cue children stop propagation, so only empty lane space reaches
 * these handlers; selection is previewed live before pointer release.
 */
export function useTimelineMarquee({
  viewMode,
  lightTrackIds,
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  verticalZoom,
  rows,
  rowHeights,
  tracks,
  hasSongs,
  readOnly,
  tracksOriginRef,
  selectedRegionKeys,
  selectedCueKeys,
  setSelectedRegionKeys,
  setSelectedCueKeys,
  setCueSelection,
  seekFromClientX,
}: TimelineMarqueeOptions) {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const marqueeRef = useRef<MarqueeGesture | null>(null);
  // Keep geometry inputs current without tying an in-progress pointer gesture
  // to the render at which it began.
  const liveInputsRef = useRef<MarqueeLiveInputs | null>(null);
  liveInputsRef.current = {
    viewMode,
    lightTrackIds,
    songs,
    songOffsets,
    songLengths,
    pxPerSec,
    verticalZoom,
    rows,
    rowHeights,
    tracks,
  };

  const applyMarqueeHits = (box: MarqueeRect, gesture: MarqueeGesture) => {
    const live = liveInputsRef.current;
    if (!live) return;
    const selection = resolveMarqueeSelection({
      mode: live.viewMode,
      marquee: box,
      additive: gesture.additive,
      baseCueKeys: gesture.baseCueKeys,
      baseRegionKeys: gesture.baseRegionKeys,
      lightTrackIds: live.lightTrackIds,
      songs: live.songs,
      songOffsets: live.songOffsets,
      songLengths: live.songLengths,
      pxPerSec: live.pxPerSec,
      laneHeight: laneHeightPx(live.verticalZoom),
      rows: live.rows,
      rowHeights: live.rowHeights,
      tracks: live.tracks,
    });
    setSelectedCueKeys(selection.cueKeys);
    setCueSelection(selection.selectedCue);
    setSelectedRegionKeys(selection.regionKeys);
  };

  const marqueeCancelRef = useRef<CancellableDrag | null>(null);
  /**
   * Esc mid-marquee: drop the rubber band and put the selection back to what it
   * was before the drag. The marquee highlights live (applyMarqueeHits runs on
   * every move), so the baseline it captured at pointerdown is exactly what
   * needs restoring.
   */
  const cancelMarquee = () => {
    const gesture = marqueeRef.current;
    marqueeRef.current = null;
    setMarqueeRect(null);
    marqueeCancelRef.current?.end();
    marqueeCancelRef.current = null;
    if (!gesture) return;
    setSelectedRegionKeys(gesture.baseRegionKeys);
    setSelectedCueKeys(gesture.baseCueKeys);
  };

  const onTracksPointerDown = (event: React.PointerEvent) => {
    if (!hasSongs || readOnly || event.button !== 0) return;
    const origin = tracksOriginRef.current;
    if (!origin) return;
    const rect = origin.getBoundingClientRect();
    // tracksOrigin lives inside the scrolled body -- getBoundingClientRect()
    // already shifts with scrollLeft. Adding scrollLeft again double-counts
    // (same bug seekFromClientX fixed) and draws marquee offset when panned.
    const x = event.clientX - rect.left;
    // y relative to tracks container (tracksOrigin is inside the scroll body).
    const y = event.clientY - rect.top;
    marqueeRef.current = {
      x0: x,
      y0: y,
      active: false,
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
      baseRegionKeys: [...selectedRegionKeys],
      baseCueKeys: [...selectedCueKeys],
    };
    marqueeCancelRef.current?.end();
    marqueeCancelRef.current = beginCancellableDrag(cancelMarquee);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onTracksPointerMove = (event: React.PointerEvent) => {
    const gesture = marqueeRef.current;
    if (!gesture) return;
    const origin = tracksOriginRef.current;
    if (!origin) return;
    const rect = origin.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const dx = x - gesture.x0;
    const dy = y - gesture.y0;
    if (!gesture.active && Math.hypot(dx, dy) < 6) return;
    gesture.active = true;
    const box = normalizeMarquee(gesture.x0, gesture.y0, x, y);
    setMarqueeRect(box);
    // Live highlight under the rubber-band before release.
    applyMarqueeHits(box, gesture);
  };

  const finishMarquee = (event: React.PointerEvent) => {
    const gesture = marqueeRef.current;
    marqueeRef.current = null;
    setMarqueeRect(null);
    marqueeCancelRef.current?.end();
    marqueeCancelRef.current = null;
    if (!gesture) return;
    const origin = tracksOriginRef.current;
    if (!origin) return;
    const rect = origin.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!gesture.active) {
      // Click empty lane: clear selection + seek.
      setSelectedRegionKeys([]);
      setSelectedCueKeys([]);
      setCueSelection(null);
      seekFromClientX(event.clientX, true);
      return;
    }
    // Final apply (matches last live frame; keeps additive baseline correct).
    applyMarqueeHits(
      normalizeMarquee(gesture.x0, gesture.y0, x, y),
      gesture,
    );
  };

  const onTracksPointerCancel = (_event: React.PointerEvent) => {
    marqueeRef.current = null;
    setMarqueeRect(null);
    marqueeCancelRef.current?.end();
    marqueeCancelRef.current = null;
  };

  return {
    marqueeRect,
    onTracksPointerDown,
    onTracksPointerMove,
    onTracksPointerUp: finishMarquee,
    onTracksPointerCancel,
  };
}
