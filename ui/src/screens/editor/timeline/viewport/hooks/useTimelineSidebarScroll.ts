/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback } from "react";
import type { RefObject, WheelEvent } from "react";
import { EVENT_LANE_HEIGHT } from "@/screens/editor/timeline/events/logic/constants";
import { AUDIO_HINT_HEIGHT, LIGHT_HINT_HEIGHT } from "@/screens/editor/timeline/layout/logic/hintStripDimensions";
import { laneHeightPx } from "@/screens/editor/timeline/layout/logic/laneDimensions";
import { SECTION_LANE_HEIGHT } from "@/screens/editor/timeline/sections/logic/constants";
import type { TimelineRow } from "@/screens/editor/timeline/layout/logic/rows";
import type { TimelineViewMode } from "@/screens/editor/timeline/toolbar/logic/types";

interface UseTimelineSidebarScrollOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  sidebarContentRef: RefObject<HTMLDivElement | null>;
  verticalZoom: number;
  effectiveViewMode: TimelineViewMode;
  hasLightContent: boolean;
  rows: TimelineRow[];
}

/** Keeps sidebar wheel, track reveal, and timeline vertical scrolling in sync. */
export function useTimelineSidebarScroll({
  scrollRef,
  sidebarContentRef,
  verticalZoom,
  effectiveViewMode,
  hasLightContent,
  rows,
}: UseTimelineSidebarScrollOptions) {
  const syncSidebarScrollMirror = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || !sidebarContentRef.current) return;
    const scrollTop = scroller.scrollTop;
    sidebarContentRef.current.style.transform = `translate3d(0, -${scrollTop}px, 0)`;
  }, [scrollRef, sidebarContentRef]);

  const handleSidebarWheel = useCallback((event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const scroller = scrollRef.current;
    if (!scroller) return;

    const lineMult =
      event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? scroller.clientHeight : 1;
    const dy = event.deltaY * lineMult;
    const dx = event.deltaX * lineMult;

    if (event.shiftKey && !dx && dy) {
      scroller.scrollLeft += dy;
    } else {
      if (dy) {
        scroller.scrollTop += dy;
        syncSidebarScrollMirror();
      }
      if (dx) scroller.scrollLeft += dx;
    }
  }, [scrollRef, syncSidebarScrollMirror]);

  const handleAutoScroll = useCallback((deltaY: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTop += deltaY;
    syncSidebarScrollMirror();
  }, [scrollRef, syncSidebarScrollMirror]);

  const scrollToTrackIndex = useCallback((trackIndex: number) => {
    const scroller = scrollRef.current;
    if (!scroller || trackIndex < 0) return;
    const laneHeight = laneHeightPx(verticalZoom);
    const showHintSpacer = effectiveViewMode === "audio" ? hasLightContent : true;
    const hintHeight = effectiveViewMode === "light" ? AUDIO_HINT_HEIGHT : LIGHT_HINT_HEIGHT;
    const baseTop = SECTION_LANE_HEIGHT + EVENT_LANE_HEIGHT + (showHintSpacer ? hintHeight : 0);

    let rowIndex = trackIndex;
    if (effectiveViewMode === "audio") {
      const foundRowIndex = rows.findIndex((row) => row.headerIndex === trackIndex);
      if (foundRowIndex >= 0) rowIndex = foundRowIndex;
    }
    const rowTop = baseTop + rowIndex * laneHeight;
    const rowBottom = rowTop + laneHeight;
    const currentScrollTop = scroller.scrollTop;
    const clientHeight = scroller.clientHeight;

    if (rowTop < currentScrollTop) {
      scroller.scrollTop = Math.max(0, rowTop - 12);
      syncSidebarScrollMirror();
    } else if (rowBottom > currentScrollTop + clientHeight) {
      scroller.scrollTop = rowBottom - clientHeight + 12;
      syncSidebarScrollMirror();
    }
  }, [
    scrollRef,
    verticalZoom,
    effectiveViewMode,
    hasLightContent,
    rows,
    syncSidebarScrollMirror,
  ]);

  return { handleSidebarWheel, handleAutoScroll, scrollToTrackIndex };
}
