import type {
  AllPeaksResponse,
  PeaksResponse,
  RegionRow,
  SongRow,
  TrackRow,
  WebUiState,
} from "../../lib/types";
import { laneHeightPx } from "../TrackWaveformLane";
import { AudioRegionBlock, buildRegionDragSession } from "./AudioRegionBlock";
import {
  effectiveRegionGeom,
  type RegionDragMode,
  type RegionDragSession,
  type RegionGeomDraft,
} from "./regionDrag";
import {
  regionSelKey,
  type RegionSelKey,
  type RegionUiState,
} from "./regionUtils";
import type { TimelineRow } from "./rows";

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
      {rows.map((row, rowIndex) => {
        const track = state.tracks.find(
          (t: TrackRow) => (t.name || t.id) === row.name || t.id === row.name,
        );
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
                if (!r.file) return false;
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

              // Per-region entries (allPeaks) are keyed by region id; the
              // coarser per-track fallback (peaks) is keyed by track id.
              const peaksForSong =
                allPeaks?.songs[i]?.tracks ??
                (i === state.songIndex ? peaks?.tracks : undefined);
              const segDuration = songLengths[i];

              const peakEntryFor = (r: RegionRow) =>
                peaksForSong?.find((p) => {
                  const withTrackId = p as { trackId?: string };
                  if (withTrackId.trackId !== undefined) return p.id === r.id;
                  return p.id === track?.id;
                });

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
                      Boolean(songRegion.file) &&
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
                      selectRegion(thisRegionSelKey, e);
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
