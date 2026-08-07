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
import { laneHeightPx } from "./laneDimensions";
import { AudioRegionBlock } from "./AudioRegionBlock";
import {
  buildRegionDragSession,
  effectiveRegionGeom,
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
  regionDragKey,
  selectedRegionKeys,
  getRegionUi,
  gestureActive,
  readOnly,
  tool = "pointer",
  selectRegion,
  startRegionDrag,
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
  regionDragKey: RegionSelKey | null;
  selectedRegionKeys: RegionSelKey[];
  getRegionUi: (key: RegionSelKey) => RegionUiState;
  gestureActive: boolean;
  readOnly: boolean;
  tool?: TimelineTool;
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
              // Empty-lane pencil only — region blocks stopPropagation on
              // their own handlers so this won't fire when clicking a region.
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - rect.left + scrollState.scrollLeft;
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
                        isActivelyDragging={regionDragKey === thisRegionSelKey}
                        onSelectRegion={selectRegion}
                        onBeginDrag={beginDrag}
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
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
