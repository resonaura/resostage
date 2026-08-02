import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { lighting } from "../../lib/api";
import type {
  AllPeaksResponse,
  LightCueRow,
  LightFixtureRow,
  LightTrackRow,
  PeaksResponse,
  SongRow,
  WebUiState,
} from "../../lib/types";
import {
  ContextMenu,
  ContextMenuItem,
} from "../ContextMenu";
import { LANE_HEIGHT, TrackWaveformLane } from "../TrackWaveformLane";

// Distinct palette for light tracks so they read as a different layer from
// the audio track colors (which cycle TRACK_COLORS). Warm/amber-heavy.
export const LIGHT_COLORS = [
  "#ff9f0a",
  "#ffd60a",
  "#ff375f",
  "#bf5af2",
  "#64d2ff",
  "#30d158",
  "#ff453a",
  "#00c7be",
];

// Fixed heights for the cross-mode hint strips (one strip per mode, the
// opposite mode's content shown dimmed and non-clickable -- the "для света
// подсвечивай что есть, но не кликабельное" ask in RESTORE_POINT.md Feature 6).
export const LIGHT_HINT_HEIGHT = 26;
export const AUDIO_HINT_HEIGHT = 46;

const CUE_EDGE_PX = 10;

export interface CueSelKey {
  songIndex: number;
  cueId: string;
}

function cueKey(songIndex: number, cueId: string): string {
  return `${songIndex}:${cueId}`;
}

/** Slanted-fade clip path sized to a cue's fadeIn/fadeOut (Cue Block spec). */
function cueClipPath(cue: LightCueRow, pxPerSec: number): string | undefined {
  const fadeInPx =
    Math.min(cue.durationSeconds / 2, Math.max(0, cue.fadeInSeconds)) *
    pxPerSec;
  const fadeOutPx =
    Math.min(cue.durationSeconds / 2, Math.max(0, cue.fadeOutSeconds)) *
    pxPerSec;
  if (fadeInPx <= 0 && fadeOutPx <= 0) return undefined;
  return `polygon(${fadeInPx}px 0, calc(100% - ${fadeOutPx}px) 0, 100% 100%, 0 100%)`;
}

// Audio mode: a dimmed, non-interactive strip near the top showing that light
// content exists on the timeline without offering any click targets.
export function LightHintStrip({
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  scrollState,
  contentWidth,
  height,
  trackColor,
}: {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  contentWidth: number;
  height: number;
  trackColor: (trackId: string) => string;
}) {
  const viewStart = scrollState.scrollLeft;
  const viewEnd = scrollState.scrollLeft + scrollState.viewportWidth;
  return (
    <div
      className="pointer-events-none relative shrink-0 border-b border-default/30 bg-surface/20"
      style={{ width: contentWidth, height }}
    >
      {songs.map((song, i) => {
        const segStart = songOffsets[i] * pxPerSec;
        const segEnd = segStart + songLengths[i] * pxPerSec;
        if (viewEnd <= segStart || viewStart >= segEnd) return null;
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0"
            style={{ left: segStart, width: songLengths[i] * pxPerSec }}
          >
            {(song.lightCues ?? []).map((cue) => {
              const leftPx = cue.startSeconds * pxPerSec;
              const widthPx = Math.max(3, cue.durationSeconds * pxPerSec);
              if (
                leftPx + widthPx < viewStart - segStart ||
                leftPx > viewEnd - segStart
              )
                return null;
              return (
                <div
                  key={cue.id}
                  className="absolute top-1 bottom-1 rounded-sm"
                  style={{
                    left: leftPx,
                    width: widthPx,
                    background: `rgb(${cue.colorR},${cue.colorG},${cue.colorB})`,
                    opacity: 0.45,
                    border: `1px solid ${trackColor(cue.trackId)}88`,
                    clipPath: cueClipPath(cue, pxPerSec),
                  }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// Light mode: a dimmed, non-interactive waveform strip so the light-focused
// view keeps its musical reference. Reuses the real waveform renderer
// (TrackWaveformLane) per region, stacked over one short strip.
export function AudioHintStrip({
  state,
  peaks,
  allPeaks,
  audioRows,
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  scrollState,
  verticalZoom,
  contentWidth,
}: {
  state: WebUiState;
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  audioRows: { name: string; color: string }[];
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  verticalZoom: number;
  contentWidth: number;
}) {
  const viewStart = scrollState.scrollLeft;
  const viewEnd = scrollState.scrollLeft + scrollState.viewportWidth;
  return (
    <div
      className="pointer-events-none relative shrink-0 overflow-hidden border-b border-default/30 bg-default/10"
      style={{ width: contentWidth, height: AUDIO_HINT_HEIGHT }}
    >
      {songs.map((song, i) => {
        const segStart = songOffsets[i] * pxPerSec;
        const segEnd = segStart + songLengths[i] * pxPerSec;
        if (viewEnd <= segStart || viewStart >= segEnd) return null;
        const peaksForSong =
          allPeaks?.songs[i]?.tracks ??
          (i === state.songIndex ? peaks?.tracks : undefined);
        const segDuration = songLengths[i];
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0"
            style={{ left: segStart, width: songLengths[i] * pxPerSec }}
          >
            {audioRows.map((row) => {
              const track = state.tracks.find(
                (t) => (t.name || t.id) === row.name || t.id === row.name,
              );
              return (song.regions ?? [])
                .filter(
                  (r) =>
                    Boolean(r.file) &&
                    (r.trackId === track?.id || r.trackId === row.name),
                )
                .map((r) => {
                  const peakEntry = peaksForSong?.find((p) => {
                    const withTrackId = p as { trackId?: string };
                    if (withTrackId.trackId !== undefined) return p.id === r.id;
                    return p.id === track?.id;
                  });
                  const fileDur =
                    peakEntry?.durationSeconds ??
                    r.durationSeconds ??
                    segDuration;
                  const dur =
                    r.durationSeconds > 0
                      ? r.durationSeconds
                      : Math.max(0.05, segDuration - r.startSeconds);
                  const leftPx = r.startSeconds * pxPerSec;
                  const widthPx = Math.max(4, dur * pxPerSec);
                  if (
                    leftPx + widthPx < viewStart - segStart ||
                    leftPx > viewEnd - segStart
                  )
                    return null;
                  const absLeft = segStart + leftPx;
                  const regViewStart = Math.max(absLeft, viewStart);
                  const regViewEnd = Math.min(absLeft + widthPx, viewEnd);
                  const regViewportWidth = Math.max(
                    0,
                    regViewEnd - regViewStart,
                  );
                  if (regViewportWidth <= 0) return null;
                  return (
                    <div
                      key={r.id}
                      className="absolute top-0 bottom-0"
                      style={{ left: leftPx, width: widthPx, opacity: 0.28 }}
                    >
                      <TrackWaveformLane
                        levels={peakEntry?.levels ?? []}
                        durationSeconds={fileDur}
                        regionFile={r.file}
                        gestureActive={false}
                        verticalZoom={verticalZoom * 0.5}
                        contentWidth={widthPx}
                        scrollLeft={Math.max(0, regViewStart - absLeft)}
                        viewportWidth={regViewportWidth}
                        pxPerSec={pxPerSec}
                        color={row.color}
                        muted={false}
                        sourceOffsetSec={r.sourceOffsetSeconds}
                        embedded
                      />
                    </div>
                  );
                });
            })}
          </div>
        );
      })}
    </div>
  );
}

// One light track's lane across every song: LightCue blocks per the Cue Block
// spec, plus minimal Phase A authoring -- click empty lane to add a cue,
// drag the block to move it, drag either edge to resize, right-click to
// delete. Selection opens the cue editor panel (owned by the parent Timeline).
export function LightTrackLane({
  track,
  color,
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  scrollState,
  verticalZoom,
  contentWidth,
  readOnly,
  toAbsSec,
  snapLocalSec,
  selected,
  onSelect,
}: {
  track: LightTrackRow;
  color: string;
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  verticalZoom: number;
  contentWidth: number;
  readOnly: boolean;
  toAbsSec: (clientX: number) => number;
  snapLocalSec: (songIndex: number, localSeconds: number) => number;
  selected: CueSelKey | null;
  onSelect: (sel: CueSelKey | null) => void;
}) {
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
  const [hoverEdge, setHoverEdge] = useState<Record<string, "start" | "end" | null>>({});

  type CueDragMode = "move" | "trimStart" | "trimEnd";
  const dragRef = useRef<{
    key: string;
    mode: CueDragMode;
    songIndex: number;
    cueId: string;
    startX: number;
    origStart: number;
    origDuration: number;
    maxEnd: number;
    lastGeom: CueDraft;
  } | null>(null);

  const laneClickRef = useRef<{
    x: number;
    y: number;
    songIndex: number;
  } | null>(null);

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

  const geomFor = (songIndex: number, cue: LightCueRow): CueDraft =>
    drafts[cueKey(songIndex, cue.id)] ?? {
      start: cue.startSeconds,
      duration: cue.durationSeconds,
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
    onSelect({ songIndex, cueId: cue.id });
    dragRef.current = {
      key: cueKey(songIndex, cue.id),
      mode,
      songIndex,
      cueId: cue.id,
      startX: e.clientX,
      origStart: geom.start,
      origDuration: geom.duration,
      maxEnd: songLengths[songIndex] ?? 0,
      lastGeom: geom,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onCueDragMove = (e: React.PointerEvent, songIndex: number) => {
    const rd = dragRef.current;
    if (!rd || rd.songIndex !== songIndex) return;
    const dSec = (e.clientX - rd.startX) / pxPerSec;
    const snap = (s: number) => snapLocalSec(songIndex, s);
    let next: CueDraft = { start: rd.origStart, duration: rd.origDuration };
    if (rd.mode === "move") {
      const maxStart = Math.max(0, rd.maxEnd - rd.origDuration);
      next.start = Math.max(0, Math.min(maxStart, snap(rd.origStart + dSec)));
    } else if (rd.mode === "trimStart") {
      const s = Math.max(
        0,
        Math.min(rd.origStart + rd.origDuration - 0.05, snap(rd.origStart + dSec)),
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
    const updated = { ...draftsRef.current, [rd.key]: next };
    draftsRef.current = updated;
    setDrafts(updated);
    rd.lastGeom = next;
  };

  const onCueDragUp = (e: React.PointerEvent) => {
    const rd = dragRef.current;
    if (!rd) return;
    const final = rd.lastGeom;
    const updated = { ...draftsRef.current, [rd.key]: final };
    draftsRef.current = updated;
    setDrafts(updated);
    void lighting.cueUpdate({
      songIndex: rd.songIndex,
      cueId: rd.cueId,
      startSeconds: final.start,
      durationSeconds: final.duration,
    });
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const onLanePointerDown = (e: React.PointerEvent) => {
    if (readOnly) return;
    e.stopPropagation();
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
    const local = Math.max(0, toAbsSec(e.clientX) - songOffsets[c.songIndex]);
    void lighting.cueAdd(c.songIndex, track.id, snapLocalSec(c.songIndex, local));
  };

  const viewStart = scrollState.scrollLeft;
  const viewEnd = scrollState.scrollLeft + scrollState.viewportWidth;

  return (
    <div
      className="relative border-b border-default/15 bg-surface/10"
      style={{
        width: contentWidth,
        height: LANE_HEIGHT * verticalZoom,
        cursor: readOnly ? "default" : "copy",
      }}
      onPointerDown={readOnly ? undefined : onLanePointerDown}
      onPointerUp={readOnly ? undefined : onLanePointerUp}
    >
      {songs.map((song, i) => {
        const segStart = songOffsets[i] * pxPerSec;
        const segEnd = segStart + songLengths[i] * pxPerSec;
        if (viewEnd <= segStart || viewStart >= segEnd) return null;
        const songCues = (song.lightCues ?? []).filter(
          (c) => c.trackId === track.id,
        );
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
              const isSelected =
                selected?.songIndex === i && selected.cueId === cue.id;
              const clip = cueClipPath(
                { ...cue, ...geom } as LightCueRow,
                pxPerSec,
              );
              const labelShown = Boolean(cue.label) && widthPx > 48;
              const edge = hoverEdge[cue.id];
              return (
                <div
                  key={cue.id}
                  className={`absolute top-1 bottom-1 rounded-sm ${readOnly ? "pointer-events-none" : ""}`}
                  style={{
                    left: leftPx,
                    width: widthPx,
                    border: isSelected
                      ? `1.5px solid ${color}`
                      : `1px solid ${color}66`,
                    boxShadow: isSelected
                      ? `0 0 0 1px ${color}aa, 0 0 8px ${color}44`
                      : undefined,
                    // No clipPath here -- it lives on the decorative fill
                    // below. clip-path also clips pointer-event hit-testing
                    // in modern browsers, so a faded cue's slanted top
                    // corners used to silently swallow trim-handle clicks
                    // right where CUE_EDGE_PX expects them. Keeping this
                    // outer div a plain rectangle means the full box height
                    // is always draggable/trimmable regardless of fades.
                    cursor: readOnly
                      ? "default"
                      : edge
                        ? "ew-resize"
                        : "grab",
                    zIndex: isSelected ? 2 : 1,
                  }}
                  title={`${cue.label || cue.id} — Song ${i + 1}: ${song.name}`}
                  onPointerDown={
                    readOnly
                      ? undefined
                      : (e) => {
                          const rect =
                            e.currentTarget.getBoundingClientRect();
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
                    if (dragRef.current) dragRef.current = null;
                  }}
                  onContextMenu={(e) => {
                    if (readOnly) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onSelect({ songIndex: i, cueId: cue.id });
                    setCtxMenu({ x: e.clientX, y: e.clientY, songIndex: i, cueId: cue.id });
                  }}
                >
                  {/* Decorative fill + fade slant -- pointer-events-none so
                      clip-path here never affects the outer div's hit area. */}
                  <div
                    className="absolute inset-0 rounded-sm pointer-events-none"
                    style={{
                      background: `rgb(${cue.colorR},${cue.colorG},${cue.colorB})`,
                      opacity: Math.max(0.12, cue.intensity),
                      clipPath: clip,
                    }}
                  />
                  {/* Edge affordance -- a faint highlight over the trim
                      hit-zone so it's visually discoverable, not just a
                      cursor change. */}
                  {!readOnly && (
                    <>
                      <div
                        className="absolute top-0 bottom-0 left-0 pointer-events-none bg-white/0 transition-colors"
                        style={{
                          width: CUE_EDGE_PX,
                          background: edge === "start" ? "rgba(255,255,255,0.35)" : undefined,
                        }}
                      />
                      <div
                        className="absolute top-0 bottom-0 right-0 pointer-events-none"
                        style={{
                          width: CUE_EDGE_PX,
                          background: edge === "end" ? "rgba(255,255,255,0.35)" : undefined,
                        }}
                      />
                    </>
                  )}
                  {labelShown && (
                    <span
                      className="absolute top-0.5 left-2 truncate text-[9px] font-semibold pointer-events-none select-none"
                      style={{
                        color: "#ffffffcc",
                        textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                        maxWidth: `calc(100% - ${CUE_EDGE_PX + 4}px)`,
                      }}
                    >
                      {cue.label}
                    </span>
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
          width={150}
          onClose={() => setCtxMenu(null)}
        >
          <ContextMenuItem
            danger
            onClick={() => {
              void lighting.cueRemove(ctxMenu.songIndex, ctxMenu.cueId);
              setCtxMenu(null);
            }}
          >
            Delete cue
          </ContextMenuItem>
        </ContextMenu>
      )}
    </div>
  );
}

// Sidebar row for a light track — clickable to open settings in LightSidePanel.
export function LightTrackHeader({
  track,
  color,
  height,
  selected,
  onSelect,
}: {
  track: LightTrackRow;
  index?: number;
  fixtures?: LightFixtureRow[];
  color: string;
  height: number;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 border-b border-default/15 px-3 py-1.5 select-none cursor-pointer transition-colors ${
        selected ? "bg-accent/10 border-l-2 border-l-accent" : "bg-surface/20 hover:bg-surface/40"
      }`}
      style={{ height }}
      onClick={onSelect}
      title="Click to edit track in side panel"
    >
      <span
        className="h-3.5 w-2 shrink-0 rounded-sm"
        style={{ background: color }}
      />
      <span
        className="flex-1 truncate text-xs font-medium text-foreground/80"
        title={track.name}
      >
        {track.name}
      </span>
      {track.fixtureIds.length === 0 ? (
        <span
          className="shrink-0 flex items-center gap-0.5 text-[9px] font-mono text-warning"
          title="No fixtures assigned -- cues on this track won't drive anything until you check at least one fixture below"
        >
          <TriangleAlert size={10} />
          0f
        </span>
      ) : (
        <span className="shrink-0 text-[9px] text-foreground/30 font-mono">
          {track.fixtureIds.length}f
        </span>
      )}
    </div>
  );
}
