import { useEffect, useRef, useState } from "react";
import { builder } from "../../lib/api";
import { triggerHaptic } from "../../lib/haptics";
import type { SongRow } from "../../lib/types";
import { lookupRegion, type RegionSelKey } from "./regionUtils";
import {
  baseRegionGeom,
  computeRegionDragGeom,
  regionDraftMatchesCommitted,
  type RegionDragCtx,
  type RegionDragSession,
  type RegionGeom,
  type RegionGeomDraft,
} from "./regionDrag";

/**
 * Live geometry drafts + window-level pointer tracking for free region
 * move/trim/fade (survives track re-parent remounts mid-gesture).
 */
export function useRegionDrag({
  songs,
  markGestureActive,
}: {
  songs: SongRow[];
  markGestureActive: () => void;
}) {
  const [regionGeomDraft, setRegionGeomDraft] = useState<
    Record<RegionSelKey, RegionGeomDraft>
  >({});
  const regionGeomDraftRef = useRef(regionGeomDraft);
  regionGeomDraftRef.current = regionGeomDraft;

  const regionDragRef = useRef<RegionDragSession | null>(null);
  const regionDragCtxRef = useRef<RegionDragCtx>({
    pxPerSec: 1,
    verticalZoom: 1,
    snapToGrid: true,
    rows: [],
    tracks: [],
    songs: [],
  });
  const regionDragWindowCleanupRef = useRef<(() => void) | null>(null);
  // Always-latest gesture marker so window listeners don't hold a stale ref.
  const markGestureActiveRef = useRef(markGestureActive);
  markGestureActiveRef.current = markGestureActive;

  // Drop draft once project state reflects it (or the region vanished).
  useEffect(() => {
    const drafts = regionGeomDraftRef.current;
    const keys = Object.keys(drafts) as RegionSelKey[];
    if (keys.length === 0) return;
    setRegionGeomDraft((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next) as RegionSelKey[]) {
        const d = next[key];
        const hit = lookupRegion(songs, key);
        if (!hit) {
          delete next[key];
          changed = true;
          continue;
        }
        if (regionDraftMatchesCommitted(hit.region, d)) {
          delete next[key];
          changed = true;
        }
      }
      if (!changed) return prev;
      regionGeomDraftRef.current = next;
      return next;
    });
  }, [songs]);

  const writeGeomDraft = (key: RegionSelKey, geom: RegionGeom) => {
    // Sync ref immediately so pointer-up in the same frame sees the value
    // (setState alone would lag one render and drop the resize).
    const next = { ...regionGeomDraftRef.current, [key]: geom };
    regionGeomDraftRef.current = next;
    setRegionGeomDraft(next);
    if (regionDragRef.current?.key === key) {
      regionDragRef.current.lastGeom = geom;
    }
  };

  const processRegionDragMove = (clientX: number, clientY: number) => {
    const rd = regionDragRef.current;
    if (!rd) return;
    const geom = computeRegionDragGeom(
      rd,
      regionDragCtxRef.current,
      clientX,
      clientY,
    );
    // A brief trackpad tick each time the gesture actually lands on a new
    // grid-snapped position/lane -- not on every pointermove, which would
    // buzz continuously instead of reading as a detent.
    const prev = rd.lastGeom;
    if (
      prev &&
      (prev.start !== geom.start ||
        prev.duration !== geom.duration ||
        prev.trackId !== geom.trackId)
    ) {
      triggerHaptic("alignment");
    }
    writeGeomDraft(rd.key, geom);
  };

  const finishRegionDrag = () => {
    const rd = regionDragRef.current;
    if (!rd) return;
    const finalGeom: RegionGeom = rd.lastGeom ?? baseRegionGeom(rd);
    // Keep draft until state.songs matches -- no snap-back flash.
    writeGeomDraft(rd.key, finalGeom);
    triggerHaptic("generic");

    void builder.regionUpdate({
      songIndex: rd.songIndex,
      regionId: rd.regionId,
      ...(finalGeom.trackId !== undefined
        ? { trackId: finalGeom.trackId }
        : {}),
      startSeconds: finalGeom.start,
      sourceOffsetSeconds: finalGeom.sourceOffset,
      durationSeconds: finalGeom.duration,
      fadeInSeconds: finalGeom.fadeIn,
      fadeOutSeconds: finalGeom.fadeOut,
      fadeInCurve: finalGeom.fadeInCurve,
      fadeOutCurve: finalGeom.fadeOutCurve,
      loop: finalGeom.loop,
      loopLengthSeconds: finalGeom.loopLengthSeconds,
    });
    regionDragRef.current = null;
    regionDragWindowCleanupRef.current?.();
    regionDragWindowCleanupRef.current = null;
  };

  const attachRegionDragWindowListeners = () => {
    regionDragWindowCleanupRef.current?.();
    const onMove = (e: PointerEvent) => {
      if (!regionDragRef.current) return;
      e.preventDefault();
      markGestureActiveRef.current();
      processRegionDragMove(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      if (!regionDragRef.current) return;
      processRegionDragMove(e.clientX, e.clientY);
      finishRegionDrag();
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    regionDragWindowCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  };

  // Drop window listeners if the host unmounts mid-drag.
  useEffect(
    () => () => {
      regionDragWindowCleanupRef.current?.();
      regionDragWindowCleanupRef.current = null;
      regionDragRef.current = null;
    },
    [],
  );

  const startRegionDrag = (session: RegionDragSession) => {
    regionDragRef.current = session;
    attachRegionDragWindowListeners();
    markGestureActiveRef.current();
    triggerHaptic("generic");
  };

  return {
    regionGeomDraft,
    regionGeomDraftRef,
    regionDragRef,
    regionDragCtxRef,
    writeGeomDraft,
    startRegionDrag,
  };
}
