import type { RegionRow, SongRow, TrackRow } from "../../lib/types";
import { laneHeightPx } from "./laneDimensions";
import { EDGE_PX } from "./constants";
import { snapToGridSec } from "./geometry";
import type { RegionSelKey } from "./regionUtils";
import type { TimelineRow } from "./rows";

export type RegionDragMode =
  | "move"
  | "trimStart" // left center/bottom: extend left into earlier source
  | "trimEnd" // right bottom: set timeline duration
  | "loopTrim" // right upper-middle: Logic Pro loop stretch handle
  | "fadeIn" // left top
  | "fadeOut" // right top
  | "fadeInCurve"
  | "fadeOutCurve";

export type RegionGeom = {
  start: number;
  sourceOffset: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
  fadeInCurve: number;
  fadeOutCurve: number;
  loop: boolean;
  loopLengthSeconds?: number;
  /** Set while a "move" drag is hovering a track's lane (may equal origin). */
  trackId?: string;
};

export type RegionGeomDraft = {
  start: number;
  sourceOffset: number;
  duration: number;
  fadeIn?: number;
  fadeOut?: number;
  fadeInCurve?: number;
  fadeOutCurve?: number;
  loop?: boolean;
  loopLengthSeconds?: number;
  trackId?: string;
};

export type RegionDragSession = {
  key: RegionSelKey;
  mode: RegionDragMode;
  startX: number;
  startY: number;
  songIndex: number;
  regionId: string;
  origStart: number;
  origSourceOffset: number;
  origDuration: number;
  origFadeIn: number;
  origFadeOut: number;
  origFadeInCurve: number;
  origFadeOutCurve: number;
  origLoop: boolean;
  origLoopLength: number;
  maxEnd: number; // song length
  /** Remaining source length from sourceOffset (fileDuration - offset). */
  maxSourceDur: number;
  /** Last live geometry during drag (committed on pointer up). */
  lastGeom: RegionGeom;
  /** Row index (in `rows`) the region started in -- "move" mode only. */
  originRowIndex: number;
  /** Row index the drag currently hovers over. */
  targetRowIndex: number;
  /** Committed track id when the drag began (for returning mid-gesture). */
  originTrackId: string;
};

export type RegionDragCtx = {
  pxPerSec: number;
  verticalZoom: number;
  snapToGrid: boolean;
  rows: TimelineRow[];
  tracks: TrackRow[];
  songs: SongRow[];
};

export function baseRegionGeom(rd: RegionDragSession): RegionGeom {
  return {
    start: rd.origStart,
    sourceOffset: rd.origSourceOffset,
    duration: rd.origDuration,
    fadeIn: rd.origFadeIn,
    fadeOut: rd.origFadeOut,
    fadeInCurve: rd.origFadeInCurve,
    fadeOutCurve: rd.origFadeOutCurve,
    loop: rd.origLoop,
    loopLengthSeconds: rd.origLoopLength,
  };
}

/** Hit-test left/right edge into Logic Pro style zones. */
export function regionEdgeMode(
  localX: number,
  localY: number,
  w: number,
  h: number,
): RegionDragMode {
  const qH = h * 0.25;
  if (localX < EDGE_PX) {
    // Left: top 25% = fade in, bottom 75% = trim start
    return localY < qH ? "fadeIn" : "trimStart";
  }
  if (localX > w - EDGE_PX) {
    // Right Logic Pro style:
    // - Top 25%: Fade Out
    // - Upper-Middle (25%..65%): Loop Trim Handle
    // - Bottom (65%..100%): Standard Trim End
    if (localY < qH) return "fadeOut";
    if (localY < h * 0.65) return "loopTrim";
    return "trimEnd";
  }
  return "move";
}

export function regionEdgeCursor(
  localX: number,
  localY: number,
  w: number,
  h: number,
): string {
  const m = regionEdgeMode(localX, localY, w, h);
  if (m === "fadeIn" || m === "fadeOut") return "col-resize";
  if (m === "loopTrim") return "alias";
  if (m === "trimStart" || m === "trimEnd") return "ew-resize";
  return "grab";
}

export function effectiveRegionGeom(
  r: RegionRow,
  draft: RegionGeomDraft | undefined,
  segDuration: number,
): RegionGeom {
  const start = draft?.start ?? r.startSeconds;
  const duration =
    draft?.duration ??
    (r.durationSeconds > 0
      ? r.durationSeconds
      : Math.max(0.05, segDuration - start));
  return {
    start,
    sourceOffset: draft?.sourceOffset ?? r.source.offsetSeconds,
    duration,
    fadeIn: draft?.fadeIn ?? r.fade?.inSeconds ?? 0,
    fadeOut: draft?.fadeOut ?? r.fade?.outSeconds ?? 0,
    fadeInCurve: draft?.fadeInCurve ?? r.fade?.inCurve ?? 0,
    fadeOutCurve: draft?.fadeOutCurve ?? r.fade?.outCurve ?? 0,
    loop: draft?.loop ?? r.loop?.enabled ?? false,
    loopLengthSeconds: draft?.loopLengthSeconds ?? r.loop?.lengthSeconds ?? 0,
    trackId: draft?.trackId,
  };
}

/** True when project region already matches the live draft (clear draft). */
export function regionDraftMatchesCommitted(
  r: RegionRow,
  d: RegionGeomDraft,
): boolean {
  const eps = 0.02;
  const dur =
    r.durationSeconds > 0 ? r.durationSeconds : Math.max(0.05, d.duration);
  return (
    Math.abs(r.startSeconds - d.start) < eps &&
    Math.abs(r.source.offsetSeconds - d.sourceOffset) < eps &&
    Math.abs(dur - d.duration) < eps &&
    (d.fadeIn === undefined ||
      Math.abs((r.fade?.inSeconds ?? 0) - d.fadeIn) < eps) &&
    (d.fadeOut === undefined ||
      Math.abs((r.fade?.outSeconds ?? 0) - d.fadeOut) < eps) &&
    (d.fadeInCurve === undefined ||
      Math.abs((r.fade?.inCurve ?? 0) - d.fadeInCurve) < 0.05) &&
    (d.fadeOutCurve === undefined ||
      Math.abs((r.fade?.outCurve ?? 0) - d.fadeOutCurve) < 0.05) &&
    (d.loop === undefined ||
      Boolean(r.loop?.enabled) === Boolean(d.loop)) &&
    (d.trackId === undefined || r.trackId === d.trackId)
  );
}

/**
 * Compute next geometry for an in-progress region drag. Mutates
 * `rd.targetRowIndex` on move; returns the draft to write (or null if no-op).
 */
export function computeRegionDragGeom(
  rd: RegionDragSession,
  ctx: RegionDragCtx,
  clientX: number,
  clientY: number,
): RegionGeom {
  const { pxPerSec: pps, verticalZoom: vz, snapToGrid: snapOn } = ctx;
  const song = ctx.songs[rd.songIndex];
  const snapSec = (sec: number) =>
    snapToGridSec(sec, pps, song?.bpm ?? 120, song?.tsNum ?? 4, snapOn);
  const dSec = (clientX - rd.startX) / pps;
  const dY = clientY - rd.startY;

  if (rd.mode === "move") {
    const maxStart = Math.max(0, rd.maxEnd - rd.origDuration);
    const nextStart = Math.max(
      0,
      Math.min(maxStart, snapSec(rd.origStart + dSec)),
    );

    // Free track crossing: each full lane height of vertical travel jumps
    // the region into that row's rendering immediately (draft trackId).
    const laneH = Math.max(1, laneHeightPx(vz));
    const rowsCrossed = Math.round(dY / laneH);
    const nextTargetRow = Math.max(
      0,
      Math.min(ctx.rows.length - 1, rd.originRowIndex + rowsCrossed),
    );
    rd.targetRowIndex = nextTargetRow;

    let draftTrackId: string | undefined;
    if (nextTargetRow !== rd.originRowIndex) {
      const targetRow = ctx.rows[nextTargetRow];
      const targetTrack = targetRow
        ? ctx.tracks.find(
            (t) =>
              (t.name || t.id) === targetRow.name || t.id === targetRow.name,
          )
        : undefined;
      // Prefer a real track id; fall back to the row name so orphan rows
      // (present only via other songs' regions) still accept the drop.
      draftTrackId = targetTrack?.id ?? targetRow?.name;
    } else {
      draftTrackId = rd.originTrackId;
    }

    return {
      ...baseRegionGeom(rd),
      start: nextStart,
      trackId: draftTrackId,
    };
  }

  if (rd.mode === "trimStart") {
    const maxLeft = rd.origSourceOffset;
    const rawDelta = snapSec(rd.origStart + dSec) - rd.origStart;
    const delta = Math.max(
      -maxLeft,
      Math.min(rd.origDuration - 0.05, rawDelta),
    );
    return {
      ...baseRegionGeom(rd),
      start: rd.origStart + delta,
      sourceOffset: rd.origSourceOffset + delta,
      duration: rd.origDuration - delta,
    };
  }

  if (rd.mode === "loopTrim") {
    const rawEnd = rd.origStart + rd.origDuration + dSec;
    const snappedEnd = snapSec(rawEnd);
    const maxDur = rd.maxEnd - rd.origStart;
    const nextDur = Math.max(0.05, Math.min(maxDur, snappedEnd - rd.origStart));
    const loopLen = rd.origLoopLength > 0 ? rd.origLoopLength : rd.origDuration;
    const isLooped = nextDur > loopLen + 0.01;
    return {
      ...baseRegionGeom(rd),
      duration: nextDur,
      loop: isLooped,
      loopLengthSeconds: isLooped ? loopLen : 0,
    };
  }

  if (rd.mode === "trimEnd") {
    const rawEnd = rd.origStart + rd.origDuration + dSec;
    const snappedEnd = snapSec(rawEnd);
    const maxDur = Math.min(rd.maxEnd - rd.origStart, rd.maxSourceDur);
    const nextDur = Math.max(0.05, Math.min(maxDur, snappedEnd - rd.origStart));
    return {
      ...baseRegionGeom(rd),
      duration: nextDur,
      loop: false,
      loopLengthSeconds: 0,
    };
  }

  if (rd.mode === "fadeIn") {
    const maxFade = rd.origDuration * 0.5;
    const next = Math.max(0, Math.min(maxFade, rd.origFadeIn + dSec));
    return { ...baseRegionGeom(rd), fadeIn: next };
  }

  if (rd.mode === "fadeOut") {
    const maxFade = rd.origDuration * 0.5;
    const next = Math.max(0, Math.min(maxFade, rd.origFadeOut - dSec));
    return { ...baseRegionGeom(rd), fadeOut: next };
  }

  if (rd.mode === "fadeInCurve") {
    const next = Math.max(-1, Math.min(1, rd.origFadeInCurve - dY / 40));
    return { ...baseRegionGeom(rd), fadeInCurve: next };
  }

  if (rd.mode === "fadeOutCurve") {
    const next = Math.max(-1, Math.min(1, rd.origFadeOutCurve - dY / 40));
    return { ...baseRegionGeom(rd), fadeOutCurve: next };
  }

  return baseRegionGeom(rd);
}

/** Build a RegionDragSession from the current region geometry (for startRegionDrag). */
export function buildRegionDragSession(args: {
  key: RegionSelKey;
  mode: RegionDragMode;
  clientX: number;
  clientY: number;
  songIndex: number;
  regionId: string;
  geom: RegionGeom;
  originTrackId: string;
  originRowIndex: number;
  segDuration: number;
  fileDuration: number;
}): RegionDragSession {
  const {
    key,
    mode,
    clientX,
    clientY,
    songIndex,
    regionId,
    geom,
    originTrackId,
    originRowIndex,
    segDuration,
    fileDuration,
  } = args;
  const origLoopLen =
    mode === "loopTrim"
      ? geom.loop && geom.loopLengthSeconds && geom.loopLengthSeconds > 0
        ? geom.loopLengthSeconds
        : geom.duration
      : (geom.loopLengthSeconds ?? 0);
  const orig: RegionGeom = {
    start: geom.start,
    sourceOffset: geom.sourceOffset,
    duration: geom.duration,
    fadeIn: geom.fadeIn,
    fadeOut: geom.fadeOut,
    fadeInCurve: geom.fadeInCurve,
    fadeOutCurve: geom.fadeOutCurve,
    loop: geom.loop,
    loopLengthSeconds: geom.loopLengthSeconds,
    trackId: originTrackId,
  };
  return {
    key,
    mode,
    startX: clientX,
    startY: clientY,
    songIndex,
    regionId,
    origStart: orig.start,
    origSourceOffset: orig.sourceOffset,
    origDuration: orig.duration,
    origFadeIn: orig.fadeIn,
    origFadeOut: orig.fadeOut,
    origFadeInCurve: orig.fadeInCurve,
    origFadeOutCurve: orig.fadeOutCurve,
    origLoop: orig.loop,
    origLoopLength: origLoopLen,
    maxEnd: segDuration,
    maxSourceDur: Math.max(0.05, fileDuration - orig.sourceOffset),
    lastGeom: orig,
    originRowIndex,
    targetRowIndex: originRowIndex,
    originTrackId,
  };
}
