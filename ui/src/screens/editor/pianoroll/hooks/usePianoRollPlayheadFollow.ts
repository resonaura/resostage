/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { TimelineFollowMode } from "@/screens/editor/timeline/toolbar/logic/types";
import type { DraggingState, PianoRollViewport } from "@/screens/editor/pianoroll/logic/types";

export interface PianoRollPlayheadFollowOptions {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  playheadRef: MutableRefObject<HTMLDivElement | null>;
  isFollowSuspendedRef?: MutableRefObject<boolean>;
  isPlaying: boolean;
  followMode: TimelineFollowMode;
  catchOnPlay: boolean;
  catchOnSeek: boolean;
  playheadBeats?: number;
  getLivePlayheadBeats?: () => number;
  viewport: PianoRollViewport;
  projectBpm?: number;
  onViewportChange: Dispatch<SetStateAction<PianoRollViewport>>;
  draggingRef?: MutableRefObject<DraggingState | null>;
}

/**
 * Keeps the Piano Roll viewport and playhead marker aligned with transport playback.
 * Moves the playhead marker directly in the DOM (playheadRef) from a dedicated 60/120fps rAF loop,
 * perfectly matching Timeline's jitter-free architecture.
 */
export function usePianoRollPlayheadFollow({
  containerRef,
  playheadRef,
  isFollowSuspendedRef,
  isPlaying,
  followMode,
  catchOnPlay,
  catchOnSeek,
  playheadBeats,
  getLivePlayheadBeats,
  viewport,
  onViewportChange,
  draggingRef,
}: PianoRollPlayheadFollowOptions) {
  const prevPlayingRef = useRef<boolean>(isPlaying);
  const lastSeekBeatRef = useRef<number | null>(null);

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const followModeRef = useRef(followMode);
  followModeRef.current = followMode;

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const getLivePlayheadBeatsRef = useRef(getLivePlayheadBeats);
  getLivePlayheadBeatsRef.current = getLivePlayheadBeats;

  const playheadBeatsRef = useRef(playheadBeats);
  playheadBeatsRef.current = playheadBeats;

  // Catch on playback start: reveal playhead
  useEffect(() => {
    if (isPlaying && !prevPlayingRef.current) {
      if (isFollowSuspendedRef) {
        isFollowSuspendedRef.current = false;
      }
      if (catchOnPlay) {
        const liveBeat = getLivePlayheadBeatsRef.current
          ? getLivePlayheadBeatsRef.current()
          : (playheadBeatsRef.current ?? 0);
        const container = containerRef.current;
        const vp = viewportRef.current;
        if (container) {
          const width = container.clientWidth || 1000;
          const viewBeats = Math.max(1, (width - vp.keyWidth) / vp.pixelsPerBeat);
          const isVisible =
            liveBeat >= vp.scrollBeats && liveBeat <= vp.scrollBeats + viewBeats;
          if (!isVisible) {
            onViewportChange((v) => ({
              ...v,
              scrollBeats: Math.max(0, liveBeat - viewBeats * 0.25),
            }));
          }
        }
      }
    }
    prevPlayingRef.current = isPlaying;
  }, [isPlaying, catchOnPlay, containerRef, isFollowSuspendedRef, onViewportChange]);

  // Catch on seek: reveal playhead if jumped outside view
  useEffect(() => {
    if (playheadBeats === undefined) return;
    if (lastSeekBeatRef.current !== null && Math.abs(playheadBeats - lastSeekBeatRef.current) > 0.5) {
      if (isFollowSuspendedRef) {
        isFollowSuspendedRef.current = false;
      }
      if (catchOnSeek) {
        const container = containerRef.current;
        const vp = viewportRef.current;
        if (container) {
          const width = container.clientWidth || 1000;
          const viewBeats = Math.max(1, (width - vp.keyWidth) / vp.pixelsPerBeat);
          const isVisible =
            playheadBeats >= vp.scrollBeats &&
            playheadBeats <= vp.scrollBeats + viewBeats;
          if (!isVisible) {
            onViewportChange((v) => ({
              ...v,
              scrollBeats: Math.max(0, playheadBeats - viewBeats * 0.25),
            }));
          }
        }
      }
    }
    lastSeekBeatRef.current = playheadBeats;
  }, [playheadBeats, catchOnSeek, containerRef, isFollowSuspendedRef, onViewportChange]);

  // Dedicated 60/120fps frame loop for playhead marker and viewport follow
  useEffect(() => {
    let animFrame = 0;
    let engineScrollBeats: number | null = null;

    const tick = () => {
      const liveBeat = getLivePlayheadBeatsRef.current
        ? getLivePlayheadBeatsRef.current()
        : (playheadBeatsRef.current ?? 0);

      const vp = viewportRef.current;
      const container = containerRef.current;
      const viewWidth = container ? container.clientWidth || 1000 : 1000;
      const viewBeats = Math.max(1, (viewWidth - vp.keyWidth) / vp.pixelsPerBeat);

      const playing = isPlayingRef.current;
      const mode = followModeRef.current;
      const isDragging = draggingRef?.current !== null && draggingRef?.current !== undefined;
      const isDraggingPlayhead = draggingRef?.current?.type === "playhead";
      const isSuspended = isFollowSuspendedRef?.current === true;

      // Scrub edge auto-scroll while dragging playhead in ruler
      if (isDraggingPlayhead && container) {
        const margin = 48;
        const currentPx = vp.keyWidth + (liveBeat - vp.scrollBeats) * vp.pixelsPerBeat;
        if (currentPx > viewWidth - margin) {
          const step = 8 / vp.pixelsPerBeat;
          onViewportChange((v) => ({ ...v, scrollBeats: v.scrollBeats + step }));
        } else if (currentPx < vp.keyWidth + margin && vp.scrollBeats > 0) {
          const step = 8 / vp.pixelsPerBeat;
          onViewportChange((v) => ({
            ...v,
            scrollBeats: Math.max(0, v.scrollBeats - step),
          }));
        }
      }

      if (playing && !isDragging && !isSuspended && mode === "smooth") {
        const targetScroll = Math.max(0, liveBeat - viewBeats * 0.25);
        if (engineScrollBeats === null) {
          engineScrollBeats = vp.scrollBeats;
        }
        const diff = targetScroll - engineScrollBeats;
        if (Math.abs(diff) < 0.001) {
          engineScrollBeats = targetScroll;
        } else {
          engineScrollBeats += diff * 0.25;
        }

        if (Math.abs(engineScrollBeats - vp.scrollBeats) > 0.005) {
          onViewportChange((v) => ({ ...v, scrollBeats: engineScrollBeats! }));
        }

        // Move marker directly in DOM synchronously with the eased scroll
        if (playheadRef.current) {
          const px = vp.keyWidth + (liveBeat - engineScrollBeats) * vp.pixelsPerBeat;
          playheadRef.current.style.left = `${px}px`;
          const inBounds = px >= vp.keyWidth && px <= viewWidth + 2;
          playheadRef.current.style.display = inBounds ? "block" : "none";
        }
      } else if (playing && !isDragging && !isSuspended && mode === "snap") {
        engineScrollBeats = null;
        if (playheadRef.current) {
          const px = vp.keyWidth + (liveBeat - vp.scrollBeats) * vp.pixelsPerBeat;
          playheadRef.current.style.left = `${px}px`;
          const inBounds = px >= vp.keyWidth && px <= viewWidth + 2;
          playheadRef.current.style.display = inBounds ? "block" : "none";
        }

        // Page turn edge detection
        if (liveBeat >= vp.scrollBeats + viewBeats - 0.75) {
          const nextScroll = Math.max(0, liveBeat - viewBeats * 0.15);
          onViewportChange((v) => ({ ...v, scrollBeats: nextScroll }));
        } else if (liveBeat < vp.scrollBeats) {
          const nextScroll = Math.max(0, liveBeat - viewBeats * 0.2);
          onViewportChange((v) => ({ ...v, scrollBeats: nextScroll }));
        }
      } else {
        engineScrollBeats = null;
        if (playheadRef.current) {
          const px = vp.keyWidth + (liveBeat - vp.scrollBeats) * vp.pixelsPerBeat;
          playheadRef.current.style.left = `${px}px`;
          const inBounds = px >= vp.keyWidth && px <= viewWidth + 2;
          playheadRef.current.style.display = inBounds ? "block" : "none";
        }
      }

      animFrame = requestAnimationFrame(tick);
    };

    tick();
    return () => cancelAnimationFrame(animFrame);
  }, [
    containerRef,
    playheadRef,
    draggingRef,
    isFollowSuspendedRef,
    onViewportChange,
  ]);
}
