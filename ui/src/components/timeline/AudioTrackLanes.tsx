import { useMemo, useRef } from "react";
import { builder } from "../../lib/api";
import { IS_EMBEDDED } from "../../lib/embedded";
import type {
  AllPeaksResponse,
  PeaksResponse,
  RegionRow,
  SongRow,
  TrackRow,
  WebUiState,
} from "../../lib/types";
import { isCompactLane, laneHeightPx } from "./laneDimensions";
import { AudioRegionBlock } from "./AudioRegionBlock";
import { CrossfadeOverlay } from "./CrossfadeOverlay";
import { MIN_CROSSFADE_SECONDS } from "./crossfade";
import { resizeCrossfade } from "./crossfadeResize";
import {
  buildRegionDragSession,
  regionStretchEdge,
  effectiveRegionGeom,
  type RegionGeom,
  type RegionDragMode,
  type RegionDragSession,
  type RegionGeomDraft,
} from "./regionDrag";
import { splitRegionsAtPlayhead } from "./regionEdit";
import { buildSongPeakLookup } from "./regionPeaks";
import {
  regionSelKey,
  type RegionSelKey,
  type RegionUiState,
} from "./regionUtils";
import type { TimelineRow } from "./rows";
import { toolCursor, type TimelineTool } from "./tools";

/** Geometry captured when a crossfade drag begins; see applyResize. */
interface CrossfadeDragBase {
  pairId: string;
  earlier: RegionGeom;
  later: RegionGeom;
  overlap: number;
}

export function AudioTrackLanes({
  state,
  rows,
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  verticalZoom,
  contentWidth,
  scrollState,
  peaks,
  allPeaks,
  regionGeomDraft,
  clearGeomDrafts,
  regionDragKey,
  selectedRegionKeys,
  getRegionUi,
  gestureActive,
  readOnly,
  tool = "pointer",
  selectRegion,
  startRegionDrag,
  writeGeomDraft,
  onRegionContextMenu,
}: {
  state: WebUiState;
  rows: TimelineRow[];
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  verticalZoom: number;
  contentWidth: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  regionGeomDraft: Record<RegionSelKey, RegionGeomDraft>;
  /** Forget optimistic geometry for regions an edit is about to reshape. */
  clearGeomDrafts: (keys: RegionSelKey[]) => void;
  regionDragKey: RegionSelKey | null;
  selectedRegionKeys: RegionSelKey[];
  getRegionUi: (key: RegionSelKey) => RegionUiState;
  gestureActive: boolean;
  readOnly: boolean;
  tool?: TimelineTool;
  /** Live geometry for a region mid-gesture; see useRegionDrag. */
  writeGeomDraft: (key: RegionSelKey, geom: RegionGeom) => void;
  selectRegion: (
    key: RegionSelKey,
    e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => void;
  startRegionDrag: (session: RegionDragSession) => void;
  onRegionContextMenu: (args: {
    x: number;
    y: number;
    songIndex: number;
    regionId: string;
    selKey: RegionSelKey;
  }) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingImportRef = useRef<{
    songIndex: number;
    trackIndex: number;
  } | null>(null);

  // One resolver per song: region -> waveform data, including the by-file
  // fallback that lets a fresh split draw immediately. See regionPeaks.ts.
  const crossfadeBaseRef = useRef<CrossfadeDragBase | null>(null);
  const peakLookupPerSong = useMemo(
    () =>
      songs.map((_song, i) =>
        buildSongPeakLookup(
          allPeaks?.songs[i]?.tracks,
          allPeaks?.files,
          i === state.songIndex ? peaks?.tracks : undefined,
        ),
      ),
    [songs, allPeaks, peaks, state.songIndex],
  );

  const openWavPicker = (songIndex: number, trackIndex: number) => {
    // Embedded in the native app's webview: pop the OS's own "Open Audio
    // File" dialog through Core (shows up in the same window, matches
    // project.loadDialog). A plain browser tab has no native window to show
    // the dialog in, so it keeps the <input type=file> upload fallback.
    if (IS_EMBEDDED) {
      void builder.trackImportWavDialog(songIndex, trackIndex);
      return;
    }
    pendingImportRef.current = { songIndex, trackIndex };
    fileInputRef.current?.click();
  };
  if (rows.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center text-sm text-foreground/40">
        No tracks in this project.
      </div>
    );
  }

  // Solo isolate: any soloed track/bus dims non-soloed rows on the timeline
  // (mirrors TrackHeaderControl / mixer).
  const anySolo =
    state.tracks.some((t) => t.solo) || state.busses.some((b) => b.solo);

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/wav,audio/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          const pending = pendingImportRef.current;
          pendingImportRef.current = null;
          if (!file || !pending) return;
          void builder.trackImportWav(
            pending.songIndex,
            pending.trackIndex,
            file,
          );
        }}
      />
      {rows.map((row, rowIndex) => {
        const track = state.tracks.find(
          (t: TrackRow) => (t.name || t.id) === row.name || t.id === row.name,
        );
        const trackIndex = track
          ? state.tracks.findIndex((t) => t.id === track.id)
          : -1;
        // Orphan rows (no staged track) never count as soloed.
        const soloDimmed = anySolo && !(track?.solo ?? false);
        const trackMuted = track?.mute ?? false;

        return (
          <div
            key={row.name}
            className="relative border-b border-default/15 bg-default/5"
            style={{
              width: contentWidth,
              height: laneHeightPx(verticalZoom),
              cursor: toolCursor(tool, readOnly),
            }}
            onClick={(e) => {
              if (readOnly || tool !== "pencil") return;
              // Empty lane only. Stopping the region's POINTERDOWN does not
              // stop its click, so a pencil click on an existing region used
              // to bubble here and open the file picker -- the pencil's one
              // job, offered in the one place it makes no sense.
              if ((e.target as HTMLElement).closest?.("[data-region-block]"))
                return;
              // No scrollLeft term: this lane IS the full-width content
              // element, so its bounding rect has already moved left by the
              // scroll and `clientX - rect.left` is content space. Adding the
              // scroll offset double-counted it and picked the wrong song
              // once the timeline was scrolled past the first one -- which
              // also made this the only place in the tree that needed a
              // pixel-exact scroll position (see scrollWindow.ts).
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - rect.left;
              // Find song under click
              let songIndex = 0;
              for (let i = 0; i < songOffsets.length; i++) {
                const start = songOffsets[i] * pxPerSec;
                const end = start + songLengths[i] * pxPerSec;
                if (x >= start && x < end) {
                  songIndex = i;
                  break;
                }
                if (i === songOffsets.length - 1) songIndex = i;
              }
              if (trackIndex < 0) return;
              openWavPicker(songIndex, trackIndex);
            }}
          >
            {songs.map((song, i) => {
              const segStart = songOffsets[i] * pxPerSec;
              const segWidth = Math.max(
                1,
                Math.round(songLengths[i] * pxPerSec),
              );
              const segEnd = segStart + segWidth;
              // scrollState is the QUANTIZED window, which is why this can
              // be a plain overlap test with no overscan of its own: the
              // window already carries it. See scrollWindow.ts.
              const viewStart = Math.max(segStart, scrollState.scrollLeft);
              const viewEnd = Math.min(
                segEnd,
                scrollState.scrollLeft + scrollState.viewportWidth,
              );
              if (viewEnd <= viewStart) return null;
              const trackRegions = (song.regions ?? []).filter((r) => {
                if (!r.source.file) return false;
                // A region actively being dragged across tracks renders in
                // whichever row its draft's trackId points at.
                const draftTrackId =
                  regionGeomDraft[regionSelKey(i, r.id)]?.trackId;
                const effectiveTrackId = draftTrackId ?? r.trackId;
                return (
                  effectiveTrackId === track?.id ||
                  effectiveTrackId === row.name
                );
              });
              if (trackRegions.length === 0) return null;

              const segDuration = songLengths[i];
              const peakEntryFor = (r: RegionRow) =>
                peakLookupPerSong[i]?.forRegion(r, track?.id);

              // Adjacent overlapping pairs on this lane. Computed once and
              // used twice: the blocks need it to suppress the fade triangle
              // that CrossfadeOverlay is about to draw for them, and the
              // overlays need it to exist at all.
              const placed = trackRegions
                .map((r) => ({
                  region: r,
                  key: regionSelKey(i, r.id),
                  geom: effectiveRegionGeom(
                    r,
                    regionGeomDraft[regionSelKey(i, r.id)],
                    segDuration,
                  ),
                }))
                .sort((a, b) => a.geom.start - b.geom.start);

              const crossfadePairs: {
                earlier: (typeof placed)[number];
                later: (typeof placed)[number];
                overlap: number;
              }[] = [];
              for (let k = 0; k < placed.length - 1; k++) {
                const earlier = placed[k];
                const later = placed[k + 1];
                const earlierEnd = earlier.geom.start + earlier.geom.duration;
                const overlap = earlierEnd - later.geom.start;
                // Matches MIN_CROSSFADE_SECONDS: below this it is a rounding
                // artefact of snapping, not a join.
                if (overlap < MIN_CROSSFADE_SECONDS) continue;
                // A region buried inside another is not a join.
                if (later.geom.start + later.geom.duration <= earlierEnd)
                  continue;
                crossfadePairs.push({ earlier, later, overlap });
              }
              const crossfadedOut = new Set(
                crossfadePairs.map((p) => p.earlier.region.id),
              );
              const crossfadedIn = new Set(
                crossfadePairs.map((p) => p.later.region.id),
              );

              return (
                <div
                  key={i}
                  className="absolute top-0 bottom-0"
                  style={{ left: segStart, width: segWidth }}
                >
                  {trackRegions.map((songRegion) => {
                    const thisRegionSelKey = regionSelKey(i, songRegion.id);
                    const isRegionSelected =
                      selectedRegionKeys.includes(thisRegionSelKey);
                    const regionUi = getRegionUi(thisRegionSelKey);
                    const geom = effectiveRegionGeom(
                      songRegion,
                      regionGeomDraft[thisRegionSelKey],
                      segDuration,
                    );
                    const leftPx = geom.start * pxPerSec;
                    const regionWidth = Math.max(8, geom.duration * pxPerSec);

                    const peakEntry = peakEntryFor(songRegion);
                    const peaksLoading =
                      Boolean(songRegion.source.file) &&
                      (!peakEntry || peakEntry.levels.length === 0);
                    const fileDuration =
                      peakEntry?.durationSeconds ??
                      songRegion.durationSeconds ??
                      segDuration;

                    const regionAbsLeft = segStart + leftPx;
                    const regionAbsRight = regionAbsLeft + regionWidth;
                    const regViewStart = Math.max(regionAbsLeft, viewStart);
                    const regViewEnd = Math.min(regionAbsRight, viewEnd);
                    const regScrollLeft = Math.max(
                      0,
                      regViewStart - regionAbsLeft,
                    );
                    const regViewportWidth = Math.max(
                      0,
                      regViewEnd - regViewStart,
                    );

                    // Never unmount the region actively being dragged.
                    if (
                      regViewEnd <= regViewStart &&
                      regionDragKey !== thisRegionSelKey
                    ) {
                      return null;
                    }

                    const maxSourceDur = Math.max(
                      0.05,
                      fileDuration - geom.sourceOffset,
                    );

                    const beginDrag = (
                      e: React.PointerEvent,
                      mode: RegionDragMode,
                    ) => {
                      e.stopPropagation();
                      e.preventDefault();

                      // The pencil places new material on empty lanes;
                      // there is nothing for it to do on top of a region, and
                      // dragging one around with it selected would contradict
                      // the cursor.
                      if (!readOnly && tool === "pencil") return;
                      if (!readOnly && tool === "eraser") {
                        void builder.regionRemove(i, songRegion.id);
                        return;
                      }
                      if (!readOnly && tool === "scissors") {
                        const abs =
                          songOffsets[i] +
                          geom.start +
                          Math.max(
                            0.02,
                            Math.min(
                              geom.duration - 0.02,
                              (e.clientX -
                                (
                                  e.currentTarget as HTMLElement
                                ).getBoundingClientRect().left) /
                                pxPerSec,
                            ),
                          );
                        // Drop the optimistic geometry first -- see the same
                        // call in Timeline's splitSelectedAtPlayhead.
                        clearGeomDrafts([thisRegionSelKey]);
                        void splitRegionsAtPlayhead(
                          [thisRegionSelKey],
                          songs,
                          songOffsets,
                          songLengths,
                          abs,
                        );
                        return;
                      }

                      selectRegion(thisRegionSelKey, e);
                      // The stretch tool turns the whole region into one
                      // handle: there is only one thing it can do, so aiming
                      // at a 6px edge to do it would be busywork.
                      if (tool === "stretch") {
                        // Edges only. The middle of a region is not a
                        // handle: with one gesture available, a click
                        // anywhere would rescale whatever it landed on.
                        const rect = (
                          e.currentTarget as HTMLElement
                        ).getBoundingClientRect();
                        const edge = regionStretchEdge(
                          e.clientX - rect.left,
                          rect.width,
                        );
                        if (!edge) return;
                        startRegionDrag(
                          buildRegionDragSession({
                            key: thisRegionSelKey,
                            mode: edge === "start" ? "stretchStart" : "stretch",
                            clientX: e.clientX,
                            clientY: e.clientY,
                            songIndex: i,
                            regionId: songRegion.id,
                            geom,
                            originTrackId:
                              songRegion.trackId || track?.id || row.name,
                            originRowIndex: rowIndex,
                            segDuration: songLengths[i] ?? 0,
                            fileDuration,
                          }),
                        );
                        return;
                      }
                      if (tool !== "pointer") return;
                      const originTrackId =
                        songRegion.trackId || track?.id || row.name;
                      startRegionDrag(
                        buildRegionDragSession({
                          key: thisRegionSelKey,
                          mode,
                          clientX: e.clientX,
                          clientY: e.clientY,
                          songIndex: i,
                          regionId: songRegion.id,
                          geom,
                          originTrackId,
                          originRowIndex: rowIndex,
                          segDuration,
                          fileDuration,
                        }),
                      );
                    };

                    return (
                      <AudioRegionBlock
                        key={songRegion.id}
                        songRegion={songRegion}
                        songName={song.name}
                        songIndex={i}
                        rowName={row.name}
                        rowColor={row.color}
                        dimmed={trackMuted || regionUi.muted || soloDimmed}
                        thisRegionSelKey={thisRegionSelKey}
                        isRegionSelected={isRegionSelected}
                        regionUi={regionUi}
                        geom={geom}
                        leftPx={leftPx}
                        regionWidth={regionWidth}
                        peakLevels={peakEntry?.levels ?? []}
                        peaksLoading={peaksLoading}
                        fileDuration={fileDuration}
                        regScrollLeft={regScrollLeft}
                        regViewportWidth={regViewportWidth}
                        maxSourceDur={maxSourceDur}
                        pxPerSec={pxPerSec}
                        verticalZoom={verticalZoom}
                        gestureActive={gestureActive}
                        readOnly={readOnly}
                        tool={tool}
                        isActivelyDragging={regionDragKey === thisRegionSelKey}
                        onSelectRegion={selectRegion}
                        onBeginDrag={beginDrag}
                        crossfadeIn={crossfadedIn.has(songRegion.id)}
                        crossfadeOut={crossfadedOut.has(songRegion.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (readOnly) return;
                          // Preserve multi-select when right-clicking inside it.
                          if (!selectedRegionKeys.includes(thisRegionSelKey)) {
                            selectRegion(thisRegionSelKey, e);
                          }
                          onRegionContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            songIndex: i,
                            regionId: songRegion.id,
                            selKey: thisRegionSelKey,
                          });
                        }}
                      />
                    );
                  })}

                  {/* Crossfades: one X per adjacent overlapping pair.
                      Recomputed here rather than threaded out of the map
                      above because effectiveRegionGeom is pure and a handful
                      of regions per lane costs nothing -- and because the
                      overlay has to sit ABOVE every block, which it cannot do
                      from inside one of them. */}
                  {crossfadePairs.map(({ earlier, later, overlap }) => {
                    const earlierFile =
                      peakEntryFor(earlier.region)?.durationSeconds ??
                      earlier.region.durationSeconds ??
                      segDuration;
                    const laterFile =
                      peakEntryFor(later.region)?.durationSeconds ??
                      later.region.durationSeconds ??
                      segDuration;
                    // The region block's own inset, so the X is bounded by
                    // the blocks it belongs to instead of running past them
                    // into the lane's padding.
                    const inset = isCompactLane(verticalZoom) ? 2 : 4;

                    const pairId = `${earlier.region.id}|${later.region.id}`;
                    const applyResize = (
                      deltaSeconds: number,
                      phase: "start" | "move" | "end",
                    ) => {
                      // Snapshot on "start" and measure everything against it.
                      // The props below are the LIVE geometry, which this
                      // gesture is itself changing -- applying each move on
                      // top of the previous one compounds, and the crossfade
                      // ran away in two frames.
                      if (phase === "start") {
                        crossfadeBaseRef.current = {
                          pairId,
                          earlier: { ...earlier.geom },
                          later: { ...later.geom },
                          overlap,
                        };
                        return;
                      }
                      const base = crossfadeBaseRef.current;
                      if (!base || base.pairId !== pairId) return;
                      const r = resizeCrossfade(
                        {
                          sourceOffset: base.earlier.sourceOffset,
                          duration: base.earlier.duration,
                          fileDuration: earlierFile,
                        },
                        {
                          sourceOffset: base.later.sourceOffset,
                          duration: base.later.duration,
                          fileDuration: laterFile,
                        },
                        base.overlap,
                        deltaSeconds,
                      );
                      const nextOverlap = base.overlap + r.appliedDelta;
                      const earlierNext = {
                        ...base.earlier,
                        duration: r.earlierDuration,
                        fadeOut: nextOverlap,
                      };
                      const laterNext = {
                        ...base.later,
                        start: base.later.start + r.laterStartDelta,
                        sourceOffset: r.laterSourceOffset,
                        duration: r.laterDuration,
                        fadeIn: nextOverlap,
                      };
                      // Draft first either way: the commit round-trips
                      // through the engine, and without the draft the pair
                      // would snap back for a frame on release.
                      writeGeomDraft(earlier.key, earlierNext);
                      writeGeomDraft(later.key, laterNext);
                      if (phase !== "end") return;
                      crossfadeBaseRef.current = null;
                      // One gesture id -- the two halves of a crossfade are
                      // one edit and have to undo as one.
                      const gestureId = crypto.randomUUID();
                      void builder.regionUpdate({
                        songIndex: i,
                        regionId: earlier.region.id,
                        durationSeconds: earlierNext.duration,
                        fadeOutSeconds: earlierNext.fadeOut,
                        gestureId,
                      });
                      void builder.regionUpdate({
                        songIndex: i,
                        regionId: later.region.id,
                        startSeconds: laterNext.start,
                        sourceOffsetSeconds: laterNext.sourceOffset,
                        durationSeconds: laterNext.duration,
                        fadeInSeconds: laterNext.fadeIn,
                        gestureId,
                      });
                    };

                    return (
                      <CrossfadeOverlay
                        key={`xf-${earlier.region.id}-${later.region.id}`}
                        leftPx={later.geom.start * pxPerSec}
                        widthPx={overlap * pxPerSec}
                        topInset={inset}
                        bottomInset={inset}
                        color={row.color}
                        readOnly={readOnly || tool !== "pointer"}
                        isActive={
                          regionDragKey === later.key ||
                          regionDragKey === earlier.key
                        }
                        pxPerSec={pxPerSec}
                        onResize={applyResize}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
