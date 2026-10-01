// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { TimelineFollowMode } from "@/screens/editor/timeline/toolbar/logic/types";
import type { PianoRollViewport } from "@/screens/editor/pianoroll/logic/types";

interface PianoRollPlayheadFollowOptions {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  isFollowSuspendedRef: MutableRefObject<boolean>;
  isPlaying: boolean;
  followMode: TimelineFollowMode;
  catchOnPlay: boolean;
  playheadBeats?: number;
  viewport: PianoRollViewport;
  projectBpm?: number;
  onViewportChange: Dispatch<SetStateAction<PianoRollViewport>>;
}

/** Keeps the Piano Roll viewport aligned with transport playback. */
export function usePianoRollPlayheadFollow({
  canvasRef,
  isFollowSuspendedRef,
  isPlaying,
  followMode,
  catchOnPlay,
  playheadBeats,
  viewport,
  projectBpm,
  onViewportChange,
}: PianoRollPlayheadFollowOptions) {
  const prevPlayingRef = useRef<boolean>(isPlaying);

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
    canvasRef,
    isFollowSuspendedRef,
    isPlaying,
    catchOnPlay,
    playheadBeats,
    viewport.keyWidth,
    viewport.pixelsPerBeat,
    onViewportChange,
  ]);

  // Autofollow frame update during playback
  const followScrollBeats = followMode === "snap" ? viewport.scrollBeats : 0;
  useEffect(() => {
    if (!isPlaying || followMode === "off" || isFollowSuspendedRef.current) {
      return;
    }
    if (playheadBeats === undefined) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.width / (window.devicePixelRatio || 1);
    const viewBeats = (width - viewport.keyWidth) / viewport.pixelsPerBeat;
    if (followMode === "smooth") {
      // Telemetry is sampled below display refresh. Project from its latest
      // position for at most one short packet interval, then ease the viewport
      // on animation frames like the main timeline.
      const receivedAt = performance.now();
      const beatsPerMs = (projectBpm || 120) / 60_000;
      let frame = 0;
      const tick = (now: number) => {
        if (isFollowSuspendedRef.current) return;
        const projectedBeat = playheadBeats + Math.min(now - receivedAt, 120) * beatsPerMs;
        const target = Math.max(0, projectedBeat - viewBeats * 0.35);
        onViewportChange((current) => {
          const next = current.scrollBeats + (target - current.scrollBeats) * 0.28;
          return Math.abs(next - current.scrollBeats) < 0.001
            ? current
            : { ...current, scrollBeats: next };
        });
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    if (followMode === "snap") {
      const minBeat = followScrollBeats;
      const maxBeat = minBeat + viewBeats;
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
    canvasRef,
    isFollowSuspendedRef,
    isPlaying,
    followMode,
    playheadBeats,
    viewport.keyWidth,
    viewport.pixelsPerBeat,
    followScrollBeats,
    projectBpm,
    onViewportChange,
  ]);
}
