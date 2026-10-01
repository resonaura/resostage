/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { RULER_HEIGHT } from "@/screens/editor/timeline/ruler/logic/constants";
import type { PianoRollViewport } from "@/screens/editor/pianoroll/logic/types";

interface PianoRollViewportGesturesOptions {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  isPlaying: boolean;
  isFollowSuspendedRef: MutableRefObject<boolean>;
  keyWidth: number;
  onViewportChange: Dispatch<SetStateAction<PianoRollViewport>>;
}

/** Owns the non-passive trackpad/mouse listeners that zoom and pan the Piano Roll. */
export function usePianoRollViewportGestures({
  canvasRef,
  containerRef,
  isPlaying,
  isFollowSuspendedRef,
  keyWidth,
  onViewportChange,
}: PianoRollViewportGesturesOptions) {
  // ── Non-Passive Wheel & Trackpad Gesture Listeners ────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.style.touchAction = "none";
    el.style.overscrollBehavior = "contain";

    let lastScale = 1.0;

    const handleNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey) {
        // Horizontal Zoom centered at cursor focus position
        const base = 2;
        const speed = e.deltaMode === 1 ? 0.14 : 0.005;
        let factor = Math.pow(base, -e.deltaY * speed * 4);
        factor = Math.max(0.3, Math.min(3.0, factor));

        onViewportChange((v) => {
          const oldPpb = v.pixelsPerBeat;
          const nextPpb = Math.max(20, Math.min(400, oldPpb * factor));
          if (Math.abs(nextPpb - oldPpb) < 0.01) return v;

          const focusX = Math.max(v.keyWidth, Math.min(rect.width, mouseX));
          const focusBeat = v.scrollBeats + (focusX - v.keyWidth) / oldPpb;
          const nextScrollBeats = Math.max(
            0,
            focusBeat - (focusX - v.keyWidth) / nextPpb,
          );

          return {
            ...v,
            pixelsPerBeat: nextPpb,
            scrollBeats: nextScrollBeats,
          };
        });
      } else if (e.altKey) {
        // Vertical Zoom centered at cursor focus pitch
        const base = 2;
        const speed = e.deltaMode === 1 ? 0.14 : 0.005;
        let factor = Math.pow(base, -e.deltaY * speed * 4);
        factor = Math.max(0.3, Math.min(3.0, factor));

        onViewportChange((v) => {
          const oldPpp = v.pixelsPerPitch;
          const nextPpp = Math.max(10, Math.min(40, oldPpp * factor));
          if (Math.abs(nextPpp - oldPpp) < 0.01) return v;

          const gridBottom = rect.height - v.velocityLaneHeight;
          const focusY = Math.max(RULER_HEIGHT, Math.min(gridBottom, mouseY));
          const focusPitch = v.scrollPitch + (gridBottom - focusY) / oldPpp;
          const nextScrollPitch = Math.max(
            0,
            Math.min(127 - 8, focusPitch - (gridBottom - focusY) / nextPpp),
          );

          return {
            ...v,
            pixelsPerPitch: nextPpp,
            scrollPitch: nextScrollPitch,
          };
        });
      } else {
        // Natural 2D scroll (trackpad pan or mouse wheel)
        if (isPlaying) {
          isFollowSuspendedRef.current = true;
        }

        if (e.shiftKey) {
          const delta = e.deltaY || e.deltaX;
          onViewportChange((v) => ({
            ...v,
            scrollBeats: Math.max(0, v.scrollBeats + delta / v.pixelsPerBeat),
          }));
        } else {
          const dX = e.deltaX;
          const dY = e.deltaY;
          onViewportChange((v) => {
            const nextBeats =
              dX !== 0
                ? Math.max(0, v.scrollBeats + dX / v.pixelsPerBeat)
                : v.scrollBeats;
            const nextPitch =
              dY !== 0
                ? Math.max(
                    0,
                    Math.min(
                      127 - 5,
                      v.scrollPitch - dY / (v.pixelsPerPitch * 1.5),
                    ),
                  )
                : v.scrollPitch;
            return {
              ...v,
              scrollBeats: nextBeats,
              scrollPitch: nextPitch,
            };
          });
        }
      }
    };

    const handleGestureStart = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      lastScale = 1.0;
    };

    const handleGestureChange = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.scale === "number" && e.scale > 0) {
        const deltaScale = e.scale / lastScale;
        lastScale = e.scale;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mouseX = Math.max(
          keyWidth,
          Math.min(rect.width, e.clientX - rect.left),
        );

        onViewportChange((v) => {
          const oldPpb = v.pixelsPerBeat;
          const nextPpb = Math.max(20, Math.min(400, oldPpb * deltaScale));
          if (Math.abs(nextPpb - oldPpb) < 0.01) return v;
          const focusBeat = v.scrollBeats + (mouseX - v.keyWidth) / oldPpb;
          const nextScrollBeats = Math.max(
            0,
            focusBeat - (mouseX - v.keyWidth) / nextPpb,
          );
          return {
            ...v,
            pixelsPerBeat: nextPpb,
            scrollBeats: nextScrollBeats,
          };
        });
      }
    };

    const handleGestureEnd = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      lastScale = 1.0;
    };

    el.addEventListener("wheel", handleNativeWheel, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturestart", handleGestureStart as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturechange", handleGestureChange as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gestureend", handleGestureEnd as any, {
      capture: true,
      passive: false,
    });

    return () => {
      el.removeEventListener("wheel", handleNativeWheel, { capture: true });
      el.removeEventListener("gesturestart", handleGestureStart as any, {
        capture: true,
      });
      el.removeEventListener("gesturechange", handleGestureChange as any, {
        capture: true,
      });
      el.removeEventListener("gestureend", handleGestureEnd as any, {
        capture: true,
      });
    };
  }, [
    canvasRef,
    containerRef,
    isPlaying,
    isFollowSuspendedRef,
    keyWidth,
    onViewportChange,
  ]);
}
