// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useEffect, useRef, useState } from "react";
import { lighting } from "@/lib/state/api";
import { roleColor } from "@/lib/theme";
import { themeAdaptedColor } from "@/screens/light/logic/tintFilter";
import { LightCueBody } from "@/screens/light/cues/components/LightCueBody";
import {
  adaptCueToTheme,
  CUE_EDGE_PX,
  lightCueSelectionStyle,
} from "@/screens/light/cues/logic/appearance";
import { useThemeVersion } from "@/hooks/useThemeVersion";
import {
  beginCancellableDrag,
  type CancellableDrag,
} from "@/lib/interaction/dragCancel";
import { triggerHaptic } from "@/lib/interaction/haptics";
import { edgesCrossedDetent } from "@/screens/editor/timeline/snapping/logic/detents";
import type {
  LightCueRow,
  LightTrackRow,
  SongRow,
} from "@/lib/state/types";
import type { CueSelKey, LightCueDragState } from "@/screens/editor/timeline/lighting/logic/types";
import { ContextMenu, ContextMenuItem } from "@/components/common/ContextMenu";
import { splitCueAtPlayhead } from "@/screens/editor/timeline/selection/logic/cueEdit";
import {
  LANE_HEIGHT,
  laneHeightPx,
} from "@/screens/editor/timeline/layout/logic/laneDimensions";
import { toolCursor, type TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";
import { EFFECT_META } from "@/screens/light/logic/lightEffectMeta";
import type { EffectType } from "@/screens/light/components/LightSidePanel";

function cueKey(songIndex: number, cueId: string): string {
  return `${songIndex}:${cueId}`;
}

// One light track's lane across every song: LightCue blocks per the Cue Block
// spec, plus minimal Phase A authoring -- click empty lane to add a cue,
// drag the block to move it, drag either edge to resize, right-click to
// delete. Selection opens the cue editor panel (owned by the parent Timeline).
export function LightTrackLane({
  lightTrueColors,
  track,
  trackIndex,
  trackIds,
  color,
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  scrollState,
  verticalZoom,
  contentWidth,
  readOnly,
  tool = "pointer",
  toAbsSec,
  snapLocalSec,
  snapToGrid,
  detentsForSong,
  selectedKeys,
  onSelect,
  onCopySelected,
  onDeleteSelected,
  activeDrag,
  onActiveDragChange,
}: {
  track: LightTrackRow;
  /** This lane's position among lightTracks -- used to resolve which lane a
   * vertical cue drag is currently hovering (see onCueDragMove below). */
  trackIndex: number;
  /** Every light track's id, in the same order as trackIndex, so a drag
   * that crosses into another lane can resolve a real trackId. */
  trackIds: string[];
  color: string;
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  verticalZoom: number;
  contentWidth: number;
  readOnly: boolean;
  tool?: TimelineTool;
  toAbsSec: (clientX: number) => number;
  snapLocalSec: (songIndex: number, localSeconds: number) => number;
  /** Magnet state -- a free cue drag ticks on landmarks, not on every pixel. */
  snapToGrid: boolean;
  detentsForSong: (songIndex: number) => number[];
  /** Multi-select set (outline on every matching cue). */
  selectedKeys: CueSelKey[];
  onSelect: (
    sel: CueSelKey | null,
    mods?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => void;
  /** Multi-select context actions (copy / delete whole selection). */
  onCopySelected?: () => void;
  onDeleteSelected?: () => void;
  /** Shared across all lanes (owned by the parent Timeline, unlike audio
   * regions which share one drag ref/draft within a single Timeline.tsx
   * closure -- each light lane is its own component instance, so a cue
   * crossing into a different lane has to be coordinated one level up).
   * Non-null only while a "move" drag has actually crossed into a
   * different lane; every lane resolves its own rendered cue list against
   * this so the cue visually jumps to its new lane immediately instead of
   * waiting for the backend round-trip. */
  activeDrag: LightCueDragState | null;
  onActiveDragChange: (next: LightCueDragState | null) => void;
  /** Show the rig's real output colours instead of the theme-tinted ones. */
  lightTrueColors: boolean;
}) {
  // Resolved per render, not memoised: roleColor is already a cached DOM
  // probe, and a memo keyed on the theme version is exactly what went stale
  // on the hint strip.
  useThemeVersion();
  const laneTint = roleColor("master");

  interface CueDraft {
    start: number;
    duration: number;
  }
  const [drafts, setDrafts] = useState<Record<string, CueDraft>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  // Which edge (if any) the pointer is currently hovering, per cue -- drives
  // the ew-resize cursor. Tracked in React state rather than mutating
  // e.currentTarget.style.cursor directly: this component re-renders on
  // every drag/draft update, and React would silently stomp a manually-set
  // inline cursor back to the static style prop's "grab" on the very next
  // render, so the resize cursor never actually stuck.
  const [hoverEdge, setHoverEdge] = useState<
    Record<string, "start" | "end" | null>
  >({});

  type CueDragMode = "move" | "trimStart" | "trimEnd";
  const dragRef = useRef<{
    key: string;
    mode: CueDragMode;
    songIndex: number;
    cueId: string;
    startX: number;
    startY: number;
    origStart: number;
    origDuration: number;
    maxEnd: number;
    lastGeom: CueDraft;
    /** Lane this drag started in / currently hovers over -- "move" mode
     * only, see onCueDragMove. */
    originTrackIndex: number;
    targetTrackIndex: number;
  } | null>(null);

  const dragCancelRef = useRef<CancellableDrag | null>(null);

  const laneClickRef = useRef<{
    x: number;
    y: number;
    songIndex: number;
  } | null>(null);

  /**
   * Esc: abandon the cue gesture, move and trim alike.
   *
   * A cue drag only reaches the backend in onCueDragUp, so there is nothing to
   * un-commit -- dropping the draft (and any cross-lane activeDrag) snaps the
   * cue back onto its committed geometry and its original lane.
   */
  const cancelCueDrag = () => {
    const rd = dragRef.current;
    dragRef.current = null;
    dragCancelRef.current?.end();
    dragCancelRef.current = null;
    if (!rd) return;
    onActiveDragChange(null);
    const next = { ...draftsRef.current };
    delete next[rd.key];
    draftsRef.current = next;
    setDrafts(next);
    triggerHaptic("generic");
  };

  // A lane unmounted mid-drag must not leave a listener that fires on a later,
  // unrelated Esc.
  useEffect(
    () => () => {
      dragCancelRef.current?.end();
      dragCancelRef.current = null;
    },
    [],
  );

  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    songIndex: number;
    cueId: string;
  } | null>(null);

  // Drop drafts that now match committed project state (mirrors the audio
  // regionGeomDraft discipline -- REST lands before the WS snapshot does).
  useEffect(() => {
    const drafts = draftsRef.current;
    if (Object.keys(drafts).length === 0) return;
    const eps = 0.02;
    setDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const sep = key.indexOf(":");
        const si = Number(key.slice(0, sep));
        const cueId = key.slice(sep + 1);
        const cue = songs[si]?.lightCues?.find((c) => c.id === cueId);
        if (!cue) {
          delete next[key];
          changed = true;
          continue;
        }
        if (
          Math.abs(cue.startSeconds - next[key].start) < eps &&
          Math.abs(cue.durationSeconds - next[key].duration) < eps
        ) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [songs]);

  const resolveSongAt = (absSeconds: number): number => {
    for (let i = 0; i < songs.length; i++) {
      const end = songOffsets[i] + songLengths[i];
      if (absSeconds < end || i === songs.length - 1) return i;
    }
    return -1;
  };

  const geomFor = (songIndex: number, cue: LightCueRow): CueDraft => {
    const key = cueKey(songIndex, cue.id);
    // A cue crossing into a different lane is driven by the shared
    // activeDrag (visible to every lane), not this lane's own local
    // drafts -- see the module doc comment on LightCueDragState.
    if (activeDrag?.key === key) {
      return { start: activeDrag.start, duration: activeDrag.duration };
    }
    return (
      drafts[key] ?? {
        start: cue.startSeconds,
        duration: cue.durationSeconds,
      }
    );
  };

  const beginCueDrag = (
    e: React.PointerEvent,
    songIndex: number,
    cue: LightCueRow,
    geom: CueDraft,
    mode: CueDragMode,
  ) => {
    e.stopPropagation();
    e.preventDefault();

    // Tool overrides on cue click (before drag/select).
    if (!readOnly && tool === "eraser") {
      void lighting.cueRemove(songIndex, cue.id);
      return;
    }
    if (!readOnly && tool === "scissors") {
      // Clamp split into the cue body using click X.
      const cueLeftAbs = (songOffsets[songIndex] ?? 0) + geom.start;
      const clickAbs = toAbsSec(e.clientX);
      const splitAbs = Math.max(
        cueLeftAbs + 0.02,
        Math.min(cueLeftAbs + geom.duration - 0.02, clickAbs),
      );
      void splitCueAtPlayhead(
        songs,
        { songIndex, cueId: cue.id },
        songOffsets,
        splitAbs,
      );
      return;
    }

    onSelect(
      { songIndex, cueId: cue.id },
      { metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey },
    );
    if (tool !== "pointer") return;
    dragRef.current = {
      key: cueKey(songIndex, cue.id),
      mode,
      songIndex,
      cueId: cue.id,
      startX: e.clientX,
      startY: e.clientY,
      origStart: geom.start,
      origDuration: geom.duration,
      maxEnd: songLengths[songIndex] ?? 0,
      lastGeom: geom,
      originTrackIndex: trackIndex,
      targetTrackIndex: trackIndex,
    };
    triggerHaptic("generic");
    dragCancelRef.current?.end();
    dragCancelRef.current = beginCancellableDrag(cancelCueDrag);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onCueDragMove = (e: React.PointerEvent, songIndex: number) => {
    const rd = dragRef.current;
    if (!rd || rd.songIndex !== songIndex) return;
    const dSec = (e.clientX - rd.startX) / pxPerSec;
    const snap = (s: number) => snapLocalSec(songIndex, s);
    const prevTargetTrackIndex = rd.targetTrackIndex;
    let next: CueDraft = { start: rd.origStart, duration: rd.origDuration };
    if (rd.mode === "move") {
      const maxStart = Math.max(0, rd.maxEnd - rd.origDuration);
      next.start = Math.max(0, Math.min(maxStart, snap(rd.origStart + dSec)));

      // Move between tracks: crossing into a neighboring lane's vertical
      // span moves the cue into that lane's rendering immediately -- every
      // lane resolves its own cue list against activeDrag (see songCues
      // below and geomFor above), instead of only previewing a drop
      // target and waiting for the backend round-trip.
      const dY = e.clientY - rd.startY;
      const rowsCrossed = Math.round(dY / laneHeightPx(verticalZoom));
      const nextTargetTrack = Math.max(
        0,
        Math.min(trackIds.length - 1, rd.originTrackIndex + rowsCrossed),
      );
      rd.targetTrackIndex = nextTargetTrack;
      onActiveDragChange(
        nextTargetTrack !== rd.originTrackIndex
          ? {
              key: rd.key,
              songIndex: rd.songIndex,
              cueId: rd.cueId,
              start: next.start,
              duration: next.duration,
              targetTrackId: trackIds[nextTargetTrack],
            }
          : null,
      );
    } else if (rd.mode === "trimStart") {
      const s = Math.max(
        0,
        Math.min(
          rd.origStart + rd.origDuration - 0.05,
          snap(rd.origStart + dSec),
        ),
      );
      next = { start: s, duration: rd.origDuration - (s - rd.origStart) };
    } else if (rd.mode === "trimEnd") {
      // Anchor the new end at the ORIGINAL end plus the drag delta (same as
      // the audio region trim in Timeline.tsx) -- using origStart + dSec
      // instead left the block's right edge lagging the cursor by the full
      // original width, so a wide cue only stretched a fraction of the drag.
      const end = snap(rd.origStart + rd.origDuration + dSec);
      next.duration = Math.max(
        0.05,
        Math.min(rd.maxEnd - rd.origStart, end - rd.origStart),
      );
    }
    // A brief trackpad tick each time the gesture lands somewhere worth
    // feeling -- mirrors the audio-region drag (useRegionDrag.ts) instead of
    // buzzing on every pointermove. With the magnet off there are no snapped
    // positions to land on, so only a lane change or a crossed landmark
    // counts; see detents.ts.
    const laneChanged = rd.targetTrackIndex !== prevTargetTrackIndex;
    const tick = laneChanged
      ? true
      : snapToGrid
        ? rd.lastGeom.start !== next.start ||
          rd.lastGeom.duration !== next.duration
        : edgesCrossedDetent(
            [rd.lastGeom.start, rd.lastGeom.start + rd.lastGeom.duration],
            [next.start, next.start + next.duration],
            detentsForSong(songIndex),
          );
    if (tick) triggerHaptic("alignment");

    const updated = { ...draftsRef.current, [rd.key]: next };
    draftsRef.current = updated;
    setDrafts(updated);
    rd.lastGeom = next;
  };

  const onCueDragUp = (e: React.PointerEvent) => {
    const rd = dragRef.current;
    // Always disarm: pointerup still arrives after an Esc cancel.
    dragCancelRef.current?.end();
    dragCancelRef.current = null;
    if (!rd) return;
    const final = rd.lastGeom;
    const updated = { ...draftsRef.current, [rd.key]: final };
    draftsRef.current = updated;
    setDrafts(updated);

    // Resolve a track crossing (see onCueDragMove) to an actual trackId.
    const targetTrackId =
      rd.mode === "move" && rd.targetTrackIndex !== rd.originTrackIndex
        ? trackIds[rd.targetTrackIndex]
        : undefined;

    void lighting.cueUpdate({
      songIndex: rd.songIndex,
      cueId: rd.cueId,
      ...(targetTrackId ? { trackId: targetTrackId } : {}),
      startSeconds: final.start,
      durationSeconds: final.duration,
    });
    dragRef.current = null;
    // activeDrag (if a crossing happened) intentionally stays set -- the
    // parent clears it once state.songs confirms the new trackId, so the
    // cue doesn't flash back to its old lane before the server catches up.
    // If no crossing happened it's already null (see onCueDragMove).
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const onLanePointerDown = (e: React.PointerEvent) => {
    if (readOnly) return;
    // Do NOT stopPropagation — parent Timeline runs marquee select on empty
    // lane drags (pointer tool). Cues still stopPropagation on their own handlers.
    onSelect(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    laneClickRef.current = {
      x: e.clientX,
      y: e.clientY,
      songIndex: resolveSongAt(toAbsSec(e.clientX)),
    };
  };

  const onLanePointerUp = (e: React.PointerEvent) => {
    const c = laneClickRef.current;
    laneClickRef.current = null;
    if (!c || readOnly) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const dx = Math.abs(e.clientX - c.x);
    const dy = Math.abs(e.clientY - c.y);
    if (dx > 4 || dy > 4) return;
    if (c.songIndex < 0) return;
    // Pencil only creates cues on empty-lane click. Pointer marquee-selects.
    if (tool !== "pencil") return;
    const local = Math.max(0, toAbsSec(e.clientX) - songOffsets[c.songIndex]);
    void lighting.cueAdd(
      c.songIndex,
      track.id,
      snapLocalSec(c.songIndex, local),
    );
  };

  const viewStart = scrollState.scrollLeft;
  const viewEnd = scrollState.scrollLeft + scrollState.viewportWidth;

  return (
    <div
      className="relative border-b border-default/15 bg-surface/10"
      style={{
        width: contentWidth,
        height: Math.max(22, Math.round(LANE_HEIGHT * verticalZoom)),
        cursor: toolCursor(tool, readOnly),
      }}
      onPointerDown={readOnly ? undefined : onLanePointerDown}
      onPointerUp={readOnly ? undefined : onLanePointerUp}
    >
      {songs.map((song, i) => {
        const segStart = songOffsets[i] * pxPerSec;
        const segEnd = segStart + songLengths[i] * pxPerSec;
        if (viewEnd <= segStart || viewStart >= segEnd) return null;
        // A cue actively being dragged across lanes renders in whichever
        // lane activeDrag.targetTrackId points at -- not its own
        // (not-yet-committed) trackId -- so it visually jumps to the new
        // lane immediately during the drag. See geomFor above for the
        // matching live-geometry override.
        const songCues = (song.lightCues ?? []).filter((c) => {
          const effectiveTrackId =
            activeDrag?.key === cueKey(i, c.id)
              ? activeDrag.targetTrackId
              : c.trackId;
          return effectiveTrackId === track.id;
        });
        // Sorted by rendered start so the 6px minimum hit-box below (and
        // any genuine data overlap from a drag) can never bleed a cue's
        // clickable area into its neighbor's territory -- that bleed is
        // what made clicking near one cue's edge select the *other* cue,
        // most visibly right after a split leaves two cues touching.
        const sortedCues = songCues
          .map((cue) => ({ cue, geom: geomFor(i, cue) }))
          .sort((a, b) => a.geom.start - b.geom.start);
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0"
            style={{ left: segStart, width: songLengths[i] * pxPerSec }}
          >
            {sortedCues.map(({ cue, geom }, sortedIdx) => {
              const leftPx = geom.start * pxPerSec;
              const nextGeom = sortedCues[sortedIdx + 1]?.geom;
              const maxWidthPx =
                nextGeom !== undefined
                  ? Math.max(0, nextGeom.start * pxPerSec - leftPx)
                  : Infinity;
              const widthPx = Math.min(
                Math.max(6, geom.duration * pxPerSec),
                maxWidthPx,
              );
              if (
                leftPx + widthPx < viewStart - segStart ||
                leftPx > viewEnd - segStart
              )
                return null;
              const isSelected = selectedKeys.some(
                (s) => s.songIndex === i && s.cueId === cue.id,
              );
              const labelText =
                cue.label ||
                (cue.effect.type && cue.effect.type !== "none"
                  ? EFFECT_META[cue.effect.type as EffectType]?.label ||
                    cue.effect.type
                  : "");
              const edge = hoverEdge[cue.id];
              return (
                <div
                  key={cue.id}
                  className={`absolute top-1 bottom-1 rounded-sm ${readOnly ? "pointer-events-none" : ""}`}
                  style={{
                    left: leftPx,
                    width: widthPx,
                    ...lightCueSelectionStyle(
                      isSelected,
                      lightTrueColors
                        ? color
                        : themeAdaptedColor(color, laneTint),
                    ),
                    // No clipPath on the hit shell -- clip lives on the
                    // decorative LightCueBody fill so edge handles stay
                    // clickable under fades.
                    cursor: readOnly ? "default" : edge ? "ew-resize" : "grab",
                    zIndex: isSelected ? 2 : 1,
                  }}
                  title={`${labelText || cue.id} — Song ${i + 1}: ${song.name}`}
                  onPointerDown={
                    readOnly
                      ? undefined
                      : (e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const localX = e.clientX - rect.left;
                          const mode: CueDragMode =
                            localX < CUE_EDGE_PX
                              ? "trimStart"
                              : localX > widthPx - CUE_EDGE_PX
                                ? "trimEnd"
                                : "move";
                          beginCueDrag(e, i, cue, geom, mode);
                        }
                  }
                  onPointerMove={(e) => {
                    if (readOnly) return;
                    const rd = dragRef.current;
                    if (rd && rd.cueId === cue.id) {
                      onCueDragMove(e, i);
                      return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    const localX = e.clientX - rect.left;
                    const next: "start" | "end" | null =
                      localX < CUE_EDGE_PX
                        ? "start"
                        : localX > widthPx - CUE_EDGE_PX
                          ? "end"
                          : null;
                    if (hoverEdge[cue.id] !== next)
                      setHoverEdge((prev) => ({ ...prev, [cue.id]: next }));
                  }}
                  onPointerLeave={() => {
                    if (hoverEdge[cue.id] !== undefined)
                      setHoverEdge((prev) => {
                        const next = { ...prev };
                        delete next[cue.id];
                        return next;
                      });
                  }}
                  onPointerUp={readOnly ? undefined : onCueDragUp}
                  onPointerCancel={() => {
                    if (dragRef.current) cancelCueDrag();
                  }}
                  onContextMenu={(e) => {
                    if (readOnly) return;
                    e.preventDefault();
                    e.stopPropagation();
                    // Keep multi-select if this cue is already in it;
                    // otherwise select only this cue.
                    const already = selectedKeys.some(
                      (s) => s.songIndex === i && s.cueId === cue.id,
                    );
                    if (!already) {
                      onSelect(
                        { songIndex: i, cueId: cue.id },
                        { metaKey: false, ctrlKey: false, shiftKey: false },
                      );
                    }
                    setCtxMenu({
                      x: e.clientX,
                      y: e.clientY,
                      songIndex: i,
                      cueId: cue.id,
                    });
                  }}
                >
                  {/* Adapted on the cue, not over it -- see adaptCueToTheme.
                      True-colour mode hands the cue through untouched, which
                      is the point of that mode. */}
                  <LightCueBody
                    cue={(() => {
                      const sized = {
                        ...cue,
                        durationSeconds: geom.duration,
                      } as LightCueRow;
                      return lightTrueColors
                        ? sized
                        : adaptCueToTheme(sized, laneTint);
                    })()}
                    pxPerSec={pxPerSec}
                    widthPx={widthPx}
                    label={labelText}
                  />
                  {/* Edge affordance -- faint highlight over the trim zone. */}
                  {!readOnly && (
                    <>
                      <div
                        className="absolute top-0 bottom-0 left-0 pointer-events-none bg-white/0 transition-colors"
                        style={{
                          width: CUE_EDGE_PX,
                          background:
                            edge === "start"
                              ? "rgba(255,255,255,0.35)"
                              : undefined,
                        }}
                      />
                      <div
                        className="absolute top-0 bottom-0 right-0 pointer-events-none"
                        style={{
                          width: CUE_EDGE_PX,
                          background:
                            edge === "end"
                              ? "rgba(255,255,255,0.35)"
                              : undefined,
                        }}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          width={180}
          onClose={() => setCtxMenu(null)}
        >
          {(() => {
            const multi =
              selectedKeys.length > 1 &&
              selectedKeys.some(
                (s) =>
                  s.songIndex === ctxMenu.songIndex &&
                  s.cueId === ctxMenu.cueId,
              );
            const n = multi ? selectedKeys.length : 1;
            return (
              <>
                {multi && (
                  <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/40">
                    {n} cues selected
                  </div>
                )}
                <ContextMenuItem
                  onClick={() => {
                    if (multi && onCopySelected) onCopySelected();
                    else if (onCopySelected) onCopySelected();
                    setCtxMenu(null);
                  }}
                >
                  {n > 1 ? `Copy (${n})` : "Copy"}
                </ContextMenuItem>
                <ContextMenuItem
                  danger
                  onClick={() => {
                    if (multi && onDeleteSelected) {
                      onDeleteSelected();
                    } else {
                      void lighting.cueRemove(ctxMenu.songIndex, ctxMenu.cueId);
                    }
                    setCtxMenu(null);
                  }}
                >
                  {n > 1 ? `Delete (${n})` : "Delete cue"}
                </ContextMenuItem>
              </>
            );
          })()}
        </ContextMenu>
      )}
    </div>
  );
}
