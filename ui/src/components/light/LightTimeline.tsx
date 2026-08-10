import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { lighting } from "../../lib/api";
import { withHexAlpha } from "../../lib/cssColor";
import { roleColor } from "../../lib/theme";
import { themeAdaptedColor } from "../../lib/tintFilter";
import { useThemeVersion } from "../../hooks/useThemeVersion";
import {
  beginCancellableDrag,
  type CancellableDrag,
} from "../../lib/dragCancel";
import { triggerHaptic } from "../../lib/haptics";
import { edgesCrossedDetent } from "../timeline/detents";
import type {
  AllPeaksResponse,
  LightCueRow,
  LightFixtureRow,
  LightTrackRow,
  PeaksResponse,
  SongRow,
  WebUiState,
} from "../../lib/types";
import { ContextMenu, ContextMenuItem } from "../ContextMenu";
import { splitCueAtPlayhead } from "../timeline/cueEdit";
import {
  COMPACT_LANE_MAX_PX,
  LANE_HEIGHT,
  laneHeightPx,
} from "../timeline/laneDimensions";
import { buildSongPeakLookup } from "../timeline/regionPeaks";
import { toolCursor, type TimelineTool } from "../timeline/tools";
import { TrackWaveformLane } from "../TrackWaveformLane";
import { EFFECT_META, effectUsesOwnColor } from "./lightEffectMeta";
import type { EffectType } from "./LightSidePanel";

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

/** Slanted-fade clip path sized to a cue's fadeIn/fadeOut (Cue Block spec).
 * Fades share the cue duration without overlapping (same clamp as the side
 * panel sliders / lightCueInterpolation). */
function cueClipPath(
  cue: Pick<LightCueRow, "durationSeconds"> & {
    fade: Pick<LightCueRow["fade"], "inSeconds" | "outSeconds">;
  },
  pxPerSec: number,
): string | undefined {
  const dur = Math.max(0, cue.durationSeconds);
  const fi = Math.min(Math.max(0, cue.fade.inSeconds), dur);
  const fo = Math.min(Math.max(0, cue.fade.outSeconds), Math.max(0, dur - fi));
  const fadeInPx = fi * pxPerSec;
  const fadeOutPx = fo * pxPerSec;
  if (fadeInPx <= 0 && fadeOutPx <= 0) return undefined;
  return `polygon(${fadeInPx}px 0, calc(100% - ${fadeOutPx}px) 0, 100% 100%, 0 100%)`;
}

/** Shared fill for timeline cues and player/hint previews. */
function lightCueFill(
  cue: Pick<LightCueRow, "intensity"> & {
    color: Pick<LightCueRow["color"], "r" | "g" | "b">;
    effect: Pick<LightCueRow["effect"], "type">;
    gradient: Pick<LightCueRow["gradient"], "preset">;
  },
): { background: string; opacity: number; isOwnColor: boolean } {
  const cueEt = cue.effect.type as EffectType;
  const isOwnColor = effectUsesOwnColor(cueEt, cue.gradient.preset);
  return {
    isOwnColor,
    background: isOwnColor
      ? "rgb(80, 85, 100)"
      : `rgb(${cue.color.r},${cue.color.g},${cue.color.b})`,
    opacity: Math.max(isOwnColor ? 0.45 : 0.12, cue.intensity),
  };
}

/**
 * A cue with its colour leaned toward the theme.
 *
 * Applied to the cue rather than over it. Filters and blend overlays both
 * covered the whole block, which squared off its rounded corners and, on the
 * hint strip, painted the gaps between cues -- and both replaced the cue's
 * hue outright instead of adapting it. Rewriting the colour before anything
 * draws leaves the geometry alone entirely.
 */
function adaptCueToTheme(cue: LightCueRow, themeColor: string): LightCueRow {
  const hex = rgbToHexTriple(cue.color.r, cue.color.g, cue.color.b);
  const out = themeAdaptedColor(hex, themeColor);
  const n = parseInt(out.slice(1), 16);
  return {
    ...cue,
    color: {
      ...cue.color,
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
    },
  };
}

function rgbToHexTriple(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Selection chrome — outline only when selected (no default border). */
function lightCueSelectionStyle(
  selected: boolean,
  accentColor: string,
): React.CSSProperties {
  // Same crossfade as the body: switching colour modes should read as one
  // deliberate change, not as the lane blinking.
  const transition = "border-color 260ms ease-out, box-shadow 260ms ease-out";
  if (!selected) return { border: "none", transition };
  return {
    border: `1.5px solid ${accentColor}`,
    boxShadow: `0 0 0 1px ${withHexAlpha(accentColor, "aa")}, 0 0 8px ${withHexAlpha(accentColor, "44")}`,
    transition,
  };
}

/**
 * Decorative cue body (fill + fade clip + optional label). Used by both the
 * interactive timeline lane and the non-interactive hint/player preview so
 * the two never diverge (borders, colors, fade shape).
 */
function LightCueBody({
  cue,
  pxPerSec,
  widthPx,
  label,
  showLabel = true,
}: {
  cue: LightCueRow;
  pxPerSec: number;
  widthPx: number;
  label?: string;
  showLabel?: boolean;
}) {
  const fill = lightCueFill(cue);
  const clip = cueClipPath(cue, pxPerSec);
  const labelText =
    (label ?? cue.label) ||
    (cue.effect.type && cue.effect.type !== "none"
      ? EFFECT_META[cue.effect.type as EffectType]?.label || cue.effect.type
      : "");
  const labelShown = showLabel && Boolean(labelText) && widthPx > 24;

  return (
    <>
      <div
        className="absolute inset-0 rounded-sm pointer-events-none"
        style={{
          background: fill.background,
          opacity: fill.opacity,
          clipPath: clip,
          // Flipping between theme-adapted and true colours is a deliberate
          // switch, not a state change to be noticed -- so the colours cross
          // over rather than cutting.
          transition: "background-color 260ms ease-out, background 260ms ease-out",
        }}
      />
      {labelShown && (
        <span
          className="absolute top-0.5 left-1.5 truncate text-[9px] font-semibold pointer-events-none select-none"
          style={{
            color: "#ffffffdd",
            textShadow: "0 1px 2px rgba(0,0,0,0.8)",
            maxWidth: `calc(100% - ${CUE_EDGE_PX + 2}px)`,
          }}
        >
          {labelText}
        </span>
      )}
    </>
  );
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
  // One filter for the whole strip, recomputed only when the theme moves --
  // there can be hundreds of cues on screen and the chain is identical for
  // every one of them.
  // Subscribed, not memoised. The resolved colour used to be cached in a
  // useMemo keyed on this version and went stale often enough to notice;
  // roleColor is already a cached DOM probe, so re-resolving it once per
  // render of one component costs nothing and cannot be out of date.
  useThemeVersion();
  const tint = roleColor("master");

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
                  className="absolute top-1 bottom-1 rounded-sm overflow-hidden"
                  style={{
                    left: leftPx,
                    width: widthPx,
                    // Quiet reference strip (player / audio mode): the cue
                    // keeps its brightness but takes its hue from the theme,
                    // so the strip reads as one calm layer instead of as a
                    // second, louder palette. Computed rather than filtered
                    // -- see lib/tintFilter for the two CSS approaches this
                    // replaces and why each failed.
                    ...lightCueSelectionStyle(
                      false,
                      themeAdaptedColor(trackColor(cue.trackId), tint),
                    ),
                    opacity: 0.22,
                  }}
                >
                  <LightCueBody
                    cue={adaptCueToTheme(cue, tint)}
                    pxPerSec={pxPerSec}
                    widthPx={widthPx}
                    showLabel={false}
                  />
                </div>
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
//
// The strip is FIXED height (AUDIO_HINT_HEIGHT) — it does not track the
// timeline's vertical zoom. Waveform verticalZoom is therefore a constant
// sized to fill the strip and always stay above the compact-lane cutoff
// (below which TrackWaveformLane draws nothing).
const AUDIO_HINT_WAVEFORM_ZOOM = Math.max(
  (COMPACT_LANE_MAX_PX + 2) / LANE_HEIGHT,
  AUDIO_HINT_HEIGHT / LANE_HEIGHT,
);

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
  /** @deprecated ignored — strip height is fixed; kept optional for callers. */
  verticalZoom?: number;
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
        const peakLookup = buildSongPeakLookup(
          allPeaks?.songs[i]?.tracks,
          allPeaks?.files,
          i === state.songIndex ? peaks?.tracks : undefined,
        );
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
                    Boolean(r.source.file) &&
                    (r.trackId === track?.id || r.trackId === row.name),
                )
                .map((r) => {
                  const peakEntry = peakLookup.forRegion(r, track?.id);
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
                        regionFile={r.source.file}
                        gestureActive={false}
                        verticalZoom={AUDIO_HINT_WAVEFORM_ZOOM}
                        contentWidth={widthPx}
                        scrollLeft={Math.max(0, regViewStart - absLeft)}
                        viewportWidth={regViewportWidth}
                        pxPerSec={pxPerSec}
                        color={row.color}
                        muted={false}
                        sourceOffsetSec={r.source.offsetSeconds}
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
export interface LightCueDragState {
  key: string;
  songIndex: number;
  cueId: string;
  start: number;
  duration: number;
  targetTrackId: string;
}

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

// Sidebar row for a light track — clickable to open settings in LightSidePanel.
// Height tracks verticalZoom (passed as `height`); typography/padding scale
// with it so the left rail stays aligned with light lanes at any zoom.
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
  const h = Math.max(22, Math.round(height));
  const padX = h < 36 ? 8 : 12;
  const nameSize = h < 32 ? 10 : h < 64 ? 12 : 13;
  const metaSize = Math.max(8, nameSize - 2);
  const swatchH = h < 32 ? 10 : 14;
  const swatchW = h < 32 ? 6 : 8;
  const iconSize = h < 36 ? 9 : 10;
  return (
    <div
      className={`flex items-center gap-2 border-b border-default/15 select-none overflow-hidden cursor-pointer transition-colors ${
        selected
          ? "tint--subtle border-l-2 border-l-accent"
          : "bg-surface/20 hover:bg-surface/40"
      }`}
      style={{ height: h, padding: `0 ${padX}px` }}
      onClick={onSelect}
      title="Click to edit track in side panel"
    >
      <span
        className="shrink-0 rounded-sm"
        style={{ height: swatchH, width: swatchW, background: color }}
      />
      <span
        className="min-w-0 flex-1 truncate font-medium text-foreground/80"
        style={{ fontSize: nameSize }}
        title={track.name}
      >
        {track.name}
      </span>
      {track.fixtureIds.length === 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 font-mono text-warning"
          style={{ fontSize: metaSize }}
          title="No fixtures assigned -- cues on this track won't drive anything until you check at least one fixture below"
        >
          <TriangleAlert size={iconSize} />
          0f
        </span>
      ) : (
        <span
          className="shrink-0 font-mono text-foreground/30"
          style={{ fontSize: metaSize }}
        >
          {track.fixtureIds.length}f
        </span>
      )}
    </div>
  );
}
