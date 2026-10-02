/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useMemo, useState } from "react";
import { MEDIA_FILE_ACCEPT } from "@/transfer/audio/logic/mediaFormats";
import type {
  AllPeaksResponse,
  PeaksResponse,
  RegionRow,
  SongRow,
  TrackRow,
  WebUiState,
  AutomationLaneRow,
} from "@/lib/state/types";
import { AutomationLaneOverlay } from "@/screens/editor/timeline/automation/components/AutomationLaneOverlay";
import { laneHeightPx } from "@/screens/editor/timeline/layout/logic/laneDimensions";
import { AudioRegionBlock } from "@/screens/editor/timeline/regions/components/AudioRegionBlock";
import { MidiRegionBlock } from "@/screens/editor/timeline/regions/components/MidiRegionBlock";
import { LiveRecordingRegion } from "@/screens/editor/timeline/regions/components/LiveRecordingRegion";
import {
  MidiRegionContextMenu,
  type MidiRegionContextMenuState,
} from "@/screens/editor/timeline/regions/components/MidiRegionContextMenu";
import { CrossfadePairOverlay } from "@/screens/editor/timeline/crossfade/components/CrossfadePairOverlay";
import { buildCrossfadeLayout } from "@/screens/editor/timeline/crossfade/logic/crossfadeLayout";
import {
  effectiveRegionGeom,
  type RegionGeom,
  type RegionDragSession,
  type RegionGeomDraft,
} from "@/screens/editor/timeline/regions/logic/regionDrag";
import { buildSongPeakLookup } from "@/screens/editor/timeline/regions/logic/regionPeaks";
import {
  regionSelKey,
  type RegionSelKey,
  type RegionUiState,
} from "@/screens/editor/timeline/regions/logic/regionUtils";
import type { TimelineRow } from "@/screens/editor/timeline/layout/logic/rows";
import { toolCursor, type TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";
import { useAudioRegionDragStart } from "@/screens/editor/timeline/regions/hooks/useAudioRegionDragStart";
import { useMidiRegionDragStart } from "@/screens/editor/timeline/regions/hooks/useMidiRegionDragStart";
import { useEmptyTrackLaneClick } from "@/screens/editor/timeline/tracks/hooks/useEmptyTrackLaneClick";
import { useTrackAudioImport } from "@/screens/editor/timeline/tracks/hooks/useTrackAudioImport";

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
  snapToGrid = true,
  showAutomation = false,
  activeAutomationLaneIds,
  selectRegion,
  startRegionDrag,
  writeGeomDraft,
  onRegionContextMenu,
  onOpenMidiRegion,
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
  snapToGrid?: boolean;
  showAutomation?: boolean;
  activeAutomationLaneIds?: Record<string, string>;
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
  onOpenMidiRegion?: (trackId: string, regionId: string) => void;
}) {
  const [midiContextMenu, setMidiContextMenu] =
    useState<MidiRegionContextMenuState | null>(null);

  const { fileInputRef, openTrackAudioImport, handleFileChange } =
    useTrackAudioImport();
  const handleEmptyLaneClick = useEmptyTrackLaneClick({
    songs,
    songOffsets,
    songLengths,
    pxPerSec,
    snapToGrid,
    readOnly,
    tool,
    openTrackAudioImport,
  });
  const startMidiRegionDrag = useMidiRegionDragStart({
    songs,
    songOffsets,
    songLengths,
    pxPerSec,
    readOnly,
    tool,
    clearGeomDrafts,
    startRegionDrag,
  });
  const startAudioRegionDrag = useAudioRegionDragStart({
    songs,
    songOffsets,
    songLengths,
    pxPerSec,
    readOnly,
    tool,
    clearGeomDrafts,
    selectRegion,
    startRegionDrag,
  });

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
        accept={MEDIA_FILE_ACCEPT}
        className="hidden"
        onChange={handleFileChange}
      />
      {rows.map((row, rowIndex) => {
        const track =
          row.headerIndex !== null && state.tracks[row.headerIndex]
            ? state.tracks[row.headerIndex]
            : state.tracks.find(
                (t: TrackRow) =>
                  (t.name || t.id) === row.name || t.id === row.name,
              );
        const trackIndex = track
          ? state.tracks.findIndex((t) => t.id === track.id)
          : -1;
        // Orphan rows (no staged track) never count as soloed.
        const soloDimmed = anySolo && !track?.solo && !track?.soloSafe;
        const trackMuted = track?.mute ?? false;
        const invertPolarity = Boolean(
          track?.phaseInvert || (track?.polarity && track.polarity !== "none"),
        );

        return (
          <div
            key={track?.id ?? `${row.name}-${rowIndex}`}
            className="relative border-b border-default/15 bg-default/5"
            style={{
              width: contentWidth,
              height: laneHeightPx(verticalZoom),
              cursor: toolCursor(tool, readOnly),
            }}
            onClick={(event) =>
              handleEmptyLaneClick(event, row, track, trackIndex)
            }
          >
            {(() => {
              const activeRecording = state.liveRecordings?.find(
                (r) =>
                  (r.trackId === track?.id || r.trackId === row.name) &&
                  (r.state === 1 || r.state === 0),
              );
              if (!activeRecording) return null;
              return (
                <LiveRecordingRegion
                  recording={activeRecording}
                  songOffsetSec={songOffsets[state.songIndex] ?? 0}
                  sampleRate={state.sampleRate || 48000}
                  pxPerSec={pxPerSec}
                  laneHeight={laneHeightPx(verticalZoom)}
                  bpm={state.bpm || songs[state.songIndex]?.bpm || 120}
                  rowColor={row.color}
                  viewport={scrollState}
                />
              );
            })()}
            {songs.map((song, i) => {
              const segStart = songOffsets[i] * pxPerSec;
              const segWidth = Math.max(
                1,
                Math.round(songLengths[i] * pxPerSec),
              );
              const segEnd = segStart + segWidth;
              // scrollState is the QUANTIZED window, which is why this can
              // be a plain overlap test with no overscan of its own: the
              // window already carries it. See layout/logic/scrollWindow.ts.
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
              const midiRegions = (song.midiRegions ?? []).filter((region) => {
                const draftTrackId =
                  regionGeomDraft[regionSelKey(i, region.id)]?.trackId;
                const effectiveTrackId = draftTrackId ?? region.trackId;
                return (
                  effectiveTrackId === track?.id ||
                  effectiveTrackId === row.name
                );
              });
              if (trackRegions.length === 0 && midiRegions.length === 0 && !showAutomation)
                return null;

              const segDuration = songLengths[i];
              const peakEntryFor = (r: RegionRow) =>
                peakLookupPerSong[i]?.forRegion(r, track?.id);

              const trackLanes = (song.automationLanes ?? []).filter(
                (l) => l.target.entityId === track?.id || l.target.entityId === row.name,
              );
              const activeLaneId = track ? activeAutomationLaneIds?.[track.id] : undefined;
              const activeLane: AutomationLaneRow =
                trackLanes.find((l) => l.id === activeLaneId) ??
                trackLanes[0] ?? {
                  id: `temp:${track?.id ?? row.name}:gain`,
                  target: {
                    domain: "strip",
                    entityId: track?.id ?? row.name,
                    parameterId: "faderGainDb",
                    valueType: "decibels",
                    defaultValue: 0,
                    minValue: -60,
                    maxValue: 12,
                  },
                  scope: "track",
                  writeMode: "read",
                  enabled: true,
                  muted: false,
                  points: [
                    { timeBeats: 0, value: 0, curve: 0 },
                    {
                      timeBeats: Math.max(
                        4,
                        (song.bpm > 0 ? song.bpm : 120) * (segDuration / 60),
                      ),
                      value: 0,
                      curve: 0,
                    },
                  ],
                };

              // Adjacent overlapping pairs on this lane. Computed once and
              // used twice: the blocks need it to suppress the fade triangle
              // that CrossfadeOverlay is about to draw for them, and the
              // overlays need it to exist at all.
              const {
                pairs: crossfadePairs,
                crossfadedIn,
                crossfadedOut,
              } = buildCrossfadeLayout(
                trackRegions.map((r) => ({
                  region: r,
                  key: regionSelKey(i, r.id),
                  geom: effectiveRegionGeom(
                    r,
                    regionGeomDraft[regionSelKey(i, r.id)],
                    segDuration,
                  ),
                })),
              );

              return (
                <div
                  key={i}
                  className="absolute top-0 bottom-0"
                  style={{ left: segStart, width: segWidth }}
                >
                  {midiRegions.map((midiRegion) => {
                    const midiSelKey = regionSelKey(i, midiRegion.id);
                    const midiGeomDraft = regionGeomDraft[midiSelKey];
                    return (
                      <MidiRegionBlock
                        key={`midi:${midiRegion.id}`}
                        midiRegion={midiRegion}
                        songIndex={i}
                        songBpm={song.bpm > 0 ? song.bpm : 120}
                        rowName={row.name}
                        rowColor={row.color}
                        laneHeight={laneHeightPx(verticalZoom)}
                        verticalZoom={verticalZoom}
                        pxPerSec={pxPerSec}
                        dimmed={trackMuted || midiRegion.muted || soloDimmed || showAutomation}
                        isSelected={selectedRegionKeys.includes(midiSelKey)}
                        readOnly={readOnly}
                        tool={tool}
                        tracks={state.tracks}
                        geomDraft={midiGeomDraft}
                        isDragging={regionDragKey === midiSelKey}
                        onSelect={(e) => selectRegion(midiSelKey, e)}
                        onBeginDrag={(event, mode) =>
                          startMidiRegionDrag({
                            event,
                            mode,
                            region: midiRegion,
                            songIndex: i,
                            songBpm: song.bpm,
                            rowIndex,
                            fallbackTrackId: track?.id || row.name,
                          })
                        }
                        onOpenPianoRoll={onOpenMidiRegion}
                        onContextMenu={(e, region) => {
                          setMidiContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            songIndex: i,
                            region,
                          });
                        }}
                      />
                    );
                  })}
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

                    return (
                      <AudioRegionBlock
                        key={songRegion.id}
                        songRegion={songRegion}
                        songName={song.name}
                        songIndex={i}
                        rowName={row.name}
                        rowColor={row.color}
                        dimmed={trackMuted || regionUi.muted || soloDimmed || showAutomation}
                        invertPolarity={invertPolarity}
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
                        onBeginDrag={(event, mode) =>
                          startAudioRegionDrag({
                            event,
                            mode,
                            regionId: songRegion.id,
                            selectionKey: thisRegionSelKey,
                            songIndex: i,
                            rowIndex,
                            fallbackTrackId:
                              songRegion.trackId || track?.id || row.name,
                            geom,
                            fileDuration,
                          })
                        }
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
                      Computed once above and used twice: the blocks suppress
                      their own fade handles underneath, while these overlays
                      are drawn above every region they join. */}
                  {crossfadePairs.map((pair) => (
                    <CrossfadePairOverlay
                      key={`xf-${pair.earlier.region.id}-${pair.later.region.id}`}
                      songIndex={i}
                      pair={pair}
                      earlierFileDuration={
                        peakEntryFor(pair.earlier.region)?.durationSeconds ??
                        pair.earlier.region.durationSeconds ??
                        segDuration
                      }
                      laterFileDuration={
                        peakEntryFor(pair.later.region)?.durationSeconds ??
                        pair.later.region.durationSeconds ??
                        segDuration
                      }
                      pxPerSec={pxPerSec}
                      verticalZoom={verticalZoom}
                      color={row.color}
                      readOnly={readOnly}
                      tool={tool}
                      regionDragKey={regionDragKey}
                      writeGeomDraft={writeGeomDraft}
                    />
                  ))}
                  {showAutomation && (
                    <AutomationLaneOverlay
                      songIndex={i}
                      lane={activeLane}
                      bpm={song.bpm > 0 ? song.bpm : 120}
                      pxPerSec={pxPerSec}
                      widthPx={segWidth}
                      heightPx={laneHeightPx(verticalZoom)}
                      color={row.color}
                      snapToGrid={snapToGrid}
                      tool={tool}
                      readOnly={readOnly}
                      scrollLeft={Math.max(0, scrollState.scrollLeft - segStart)}
                      viewportWidth={scrollState.viewportWidth}
                    />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <MidiRegionContextMenu
        menu={midiContextMenu}
        onClose={() => setMidiContextMenu(null)}
        onOpenMidiRegion={onOpenMidiRegion}
      />
    </>
  );
}
