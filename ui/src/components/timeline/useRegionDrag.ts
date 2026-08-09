import { useEffect, useRef, useState } from "react";
import { builder } from "../../lib/api";
import {
  beginCancellableDrag,
  type CancellableDrag,
} from "../../lib/dragCancel";
import { triggerHaptic } from "../../lib/haptics";
import type { SongRow } from "../../lib/types";
import {
  DEFAULT_CROSSFADE_SHAPE,
  planTrackCrossfades,
  type CrossfadeRegion,
  type CrossfadeShape,
} from "./crossfade";
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
  crossfadeShape = DEFAULT_CROSSFADE_SHAPE,
}: {
  songs: SongRow[];
  markGestureActive: () => void;
  crossfadeShape?: CrossfadeShape;
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
  const dragCancelRef = useRef<CancellableDrag | null>(null);
  // Always-latest gesture marker so window listeners don't hold a stale ref.
  const markGestureActiveRef = useRef(markGestureActive);
  markGestureActiveRef.current = markGestureActive;
  // Read at pointer-up from window listeners, which outlive the render that
  // started the drag.
  const crossfadeRef = useRef({ crossfadeShape });
  crossfadeRef.current = { crossfadeShape };
  const songsRef = useRef(songs);
  songsRef.current = songs;

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

  /**
   * Turn any overlap this drag created into a crossfade.
   *
   * Unconditional. An overlap between two regions on one track has exactly
   * one sensible reading -- they play together through the overlap -- and
   * that is what the engine now does, so the fades that make it sound like a
   * join rather than a doubling belong there too. There is no mode to turn
   * on; the toggle that used to gate this only ever meant "make the overlap
   * behave".
   *
   * Runs on the geometry that was just committed rather than on `songs`,
   * which still holds the pre-drag position -- the engine echo has not
   * arrived yet, and waiting for it would make the fades appear a frame after
   * the region lands.
   */
  const applyCrossfades = (
    songIndex: number,
    regionId: string,
    finalGeom: RegionGeom,
    gestureId: string,
  ) => {
    const { crossfadeShape: shape } = crossfadeRef.current;
    const song = songsRef.current[songIndex];
    if (!song) return;
    const siblings = song.regions ?? [];

    const trackId =
      finalGeom.trackId ?? siblings.find((r) => r.id === regionId)?.trackId;
    if (!trackId) return;

    // Stands in for "duration 0 = runs to the end of the song", the same
    // resolution effectiveRegionGeom does when drawing. An authored end wins
    // over the derived one, exactly as it does for the transport.
    const songLength = song.endSeconds && song.endSeconds > 0
      ? song.endSeconds
      : Math.max(
          0,
          ...siblings.map((r) =>
            r.durationSeconds > 0 ? r.startSeconds + r.durationSeconds : 0,
          ),
        );
    const resolve = (start: number, duration: number) =>
      duration > 0 ? duration : Math.max(0.05, songLength - start);

    const onTrack: CrossfadeRegion[] = [];
    for (const r of siblings) {
      if (r.id === regionId) continue;
      if (r.trackId !== trackId) continue;
      onTrack.push({
        id: r.id,
        trackId: r.trackId,
        startSeconds: r.startSeconds,
        durationSeconds: resolve(r.startSeconds, r.durationSeconds),
        fadeInSeconds: r.fade?.inSeconds ?? 0,
        fadeOutSeconds: r.fade?.outSeconds ?? 0,
        fadeInCurve: r.fade?.inCurve ?? 0,
        fadeOutCurve: r.fade?.outCurve ?? 0,
      });
    }
    onTrack.push({
      id: regionId,
      trackId,
      startSeconds: finalGeom.start,
      durationSeconds: resolve(finalGeom.start, finalGeom.duration),
      fadeInSeconds: finalGeom.fadeIn,
      fadeOutSeconds: finalGeom.fadeOut,
      fadeInCurve: finalGeom.fadeInCurve,
      fadeOutCurve: finalGeom.fadeOutCurve,
    });

    for (const u of planTrackCrossfades(onTrack, shape)) {
      void builder.regionUpdate({
        songIndex,
        regionId: u.regionId,
        fadeInSeconds: u.fadeInSeconds,
        fadeOutSeconds: u.fadeOutSeconds,
        fadeInCurve: u.fadeInCurve,
        fadeOutCurve: u.fadeOutCurve,
        gestureId,
      });
    }
  };

  const finishRegionDrag = () => {
    const rd = regionDragRef.current;
    if (!rd) return;
    const finalGeom: RegionGeom = rd.lastGeom ?? baseRegionGeom(rd);
    // Keep draft until state.songs matches -- no snap-back flash.
    writeGeomDraft(rd.key, finalGeom);
    triggerHaptic("generic");

    // One id for the move AND for any crossfades it causes: undo has to put
    // the neighbours' fades back in the same step that puts the region back,
    // or a single Cmd-Z leaves the track sounding wrong.
    const gestureId = crypto.randomUUID();
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
      gestureId,
    });
    applyCrossfades(rd.songIndex, rd.regionId, finalGeom, gestureId);
    regionDragRef.current = null;
    regionDragWindowCleanupRef.current?.();
    regionDragWindowCleanupRef.current = null;
    dragCancelRef.current?.end();
    dragCancelRef.current = null;
  };

  /**
   * Esc: drop the whole gesture, move/trim/fade alike.
   *
   * Nothing needs un-committing -- a region drag only reaches the engine in
   * finishRegionDrag -- so cancelling is purely deleting the draft, which puts
   * the region straight back on its committed geometry.
   */
  const cancelRegionDrag = () => {
    const rd = regionDragRef.current;
    regionDragRef.current = null;
    regionDragWindowCleanupRef.current?.();
    regionDragWindowCleanupRef.current = null;
    dragCancelRef.current?.end();
    dragCancelRef.current = null;
    if (!rd) return;
    const next = { ...regionGeomDraftRef.current };
    delete next[rd.key];
    regionGeomDraftRef.current = next;
    setRegionGeomDraft(next);
    triggerHaptic("generic");
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
      dragCancelRef.current?.end();
      dragCancelRef.current = null;
    },
    [],
  );

  const startRegionDrag = (session: RegionDragSession) => {
    regionDragRef.current = session;
    attachRegionDragWindowListeners();
    dragCancelRef.current?.end();
    dragCancelRef.current = beginCancellableDrag(cancelRegionDrag);
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
    cancelRegionDrag,
  };
}
