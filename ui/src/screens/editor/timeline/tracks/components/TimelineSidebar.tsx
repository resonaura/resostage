/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui";
import type {
  LightFixtureRow,
  LightTrackRow,
  TrackRow,
  PluginParameterList,
  WebUiState,
} from "@/lib/state/types";
import { builder, lighting } from "@/lib/state/api";
import { LightTrackHeader } from "@/screens/editor/timeline/tracks/components/LightTrackHeader";
import {
  AUDIO_HINT_HEIGHT,
  LIGHT_HINT_HEIGHT,
} from "@/screens/editor/timeline/layout/logic/hintStripDimensions";
import { laneHeightPx } from "@/screens/editor/timeline/layout/logic/laneDimensions";
import { EVENT_LANE_HEIGHT } from "@/screens/editor/timeline/events/logic/constants";
import { RULER_HEIGHT } from "@/screens/editor/timeline/ruler/logic/constants";
import { SECTION_LANE_HEIGHT } from "@/screens/editor/timeline/sections/logic/constants";
import { SIDEBAR_WIDTH } from "@/screens/editor/timeline/tracks/logic/constants";
import type { TimelineRow } from "@/screens/editor/timeline/layout/logic/rows";
import { TimelineRowLabel } from "@/screens/editor/timeline/tracks/components/TimelineRowLabel";
import type { TimelineViewMode } from "@/screens/editor/timeline/toolbar/logic/types";
import { TrackHeaderControl } from "@/screens/editor/timeline/tracks/components/TrackHeaderControl";
import { AutomationTrackHeader } from "@/screens/editor/timeline/automation/components/AutomationTrackHeader";
import { useAutomationTouchRecorder } from "@/screens/editor/timeline/automation/hooks/useAutomationTouchRecorder";
import { createSongTempoMap } from "@/lib/midi/tempoMap";
import { getAutomationLanesForTrack } from "@/screens/editor/timeline/automation/logic/automationTargets";
import {
  trackSelectionGesture,
  type TrackSelectionGesture,
} from "@/screens/editor/timeline/tracks/logic/trackSelection";
import { useTrackReorder } from "@/screens/editor/timeline/tracks/hooks/useTrackReorder";
import {
  TimelineSidebarMenus,
  type SidebarLightTrackMenuState,
  type SidebarMenuPosition,
  type SidebarRenameState,
  type SidebarTrackMenuState,
} from "@/screens/editor/timeline/tracks/components/TimelineSidebarMenus";

const laneHeaderCls =
  "shrink-0 border-b border-default/30 px-2.5 font-bold uppercase flex items-center bg-background-tertiary";

export function TimelineSidebar({
  state,
  rows,
  verticalZoom,
  effectiveViewMode,
  lightTracks,
  lightFixtures,
  lightEnabled,
  lightTrackColor,
  hasLightContent,
  sidePanelTrackIndex,
  setSidePanelTrackIndex,
  setCueSelection,
  sidebarContentRef,
  selectedTrackId,
  selectedTrackIds,
  onSelectTrack,
  onWheel,
  onAutoScroll,
  onTrackReorderPreview,
  showAutomation = false,
  activeAutomationLaneIds,
  automationParameters,
  onSelectAutomationLane,
}: {
  state: WebUiState;
  rows: TimelineRow[];
  verticalZoom: number;
  effectiveViewMode: TimelineViewMode;
  lightTracks: LightTrackRow[];
  lightFixtures: LightFixtureRow[];
  lightEnabled: boolean;
  lightTrackColor: (index: number) => string;
  hasLightContent: boolean;
  sidePanelTrackIndex: number | null;
  setSidePanelTrackIndex: (i: number | null) => void;
  setCueSelection: (v: null) => void; // clears primary; parent also clears multi
  sidebarContentRef: React.RefObject<HTMLDivElement | null>;
  selectedTrackId?: string | null;
  selectedTrackIds?: string[];
  onSelectTrack?: (id: string | null, gesture?: TrackSelectionGesture) => void;
  onWheel?: (e: React.WheelEvent) => void;
  onAutoScroll?: (deltaY: number) => void;
  showAutomation?: boolean;
  activeAutomationLaneIds?: Record<string, string>;
  automationParameters?: Readonly<Record<string, PluginParameterList>>;
  onSelectAutomationLane?: (trackId: string, laneId: string) => void;
  onTrackReorderPreview?: (preview: {
    index: number;
    kind: "audio" | "light";
    dropSlot: number;
  } | null) => void;
}) {
  const [addTrackMenu, setAddTrackMenu] =
    useState<SidebarMenuPosition | null>(null);
  const [trackMenu, setTrackMenu] =
    useState<SidebarTrackMenuState | null>(null);
  const [renamingTrack, setRenamingTrack] =
    useState<SidebarRenameState | null>(null);
  const [lightTrackMenu, setLightTrackMenu] =
    useState<SidebarLightTrackMenuState | null>(null);
  const [renamingLightTrack, setRenamingLightTrack] =
    useState<SidebarRenameState | null>(null);

  const songIndex = state.songIndex ?? 0;
  const currentSong = state.songs[songIndex];
  const songBpm = currentSong?.bpm ?? 120;
  const songTempoMap = useMemo(
    () => currentSong ? createSongTempoMap(currentSong) : null,
    [currentSong],
  );
  const getCurrentBeats = () =>
    Math.max(0, songTempoMap?.secondsToBeats(state.playheadSeconds ?? 0)
      ?? ((state.playheadSeconds ?? 0) * songBpm) / 60);
  const projectIdentity = state.stateSessionId
    && Number.isSafeInteger(state.projectEpoch)
    && state.projectEpoch! >= 0
    ? `${state.stateSessionId}:${state.projectEpoch}`
    : null;
  const automationCycleRange = useMemo(() => {
    const cycle = state.cycle;
    if (!cycle?.active || cycle.skip || cycle.songIndex !== songIndex || !songTempoMap)
      return null;
    const leftSeconds = Math.min(cycle.startSeconds, cycle.endSeconds);
    const rightSeconds = Math.max(cycle.startSeconds, cycle.endSeconds);
    if (rightSeconds <= leftSeconds) return null;
    return {
      leftBeats: Math.max(0, songTempoMap.secondsToBeats(leftSeconds)),
      rightBeats: Math.max(0, songTempoMap.secondsToBeats(rightSeconds)),
    };
  }, [state.cycle, songIndex, songTempoMap]);

  const touchRecorder = useAutomationTouchRecorder({
    songIndex,
    projectIdentity,
    lanes: currentSong?.automationLanes ?? [],
    isPlaying: Boolean(state.playing),
    getCurrentBeats,
    cycleRange: automationCycleRange,
    cyclePassSequence: state.cyclePassSequence,
  });

  const {
    containerRef,
    handleTrackPointerDown,
    handleTrackPointerMove,
    handleTrackPointerUp,
    handleTrackPointerCancel,
  } = useTrackReorder({
    tracks: state.tracks,
    songIndex: state.songIndex,
    sidebarContentRef,
    onSelectTrack,
    setSidePanelTrackIndex,
    setCueSelection,
    onAutoScroll,
    onTrackReorderPreview,
  });

  const handleAddTrack = async (kind: "audio" | "instrument", channels = 2) => {
    setAddTrackMenu(null);
    const songIndex = state.songIndex >= 0 ? state.songIndex : 0;
    await builder.trackAdd(songIndex, { kind, channels });
  };

  const handleAddBus = () => {
    setAddTrackMenu(null);
    void builder.busAdd();
  };

  const anySolo =
    state.tracks.some((t) => t.solo) || state.busses.some((b) => b.solo);
  const selectedAudioTrackIds =
    selectedTrackIds && selectedTrackIds.length > 0
      ? selectedTrackIds
      : selectedTrackId
        ? [selectedTrackId]
        : [];
  const selectedAudioTrackIdSet = new Set(selectedAudioTrackIds);
  const contextTrackIndices = trackMenu
    ? selectedAudioTrackIdSet.has(trackMenu.track.id)
      ? state.tracks.flatMap((track, index) =>
          selectedAudioTrackIdSet.has(track.id) ? [index] : [],
        )
      : [trackMenu.trackIndex]
    : [];
  const laneH = laneHeightPx(verticalZoom);

  // Keep spacer height in lockstep with the body's hint strip so rows align.
  const showHintSpacer = effectiveViewMode === "audio" ? hasLightContent : true;
  const hintHeight =
    effectiveViewMode === "light" ? AUDIO_HINT_HEIGHT : LIGHT_HINT_HEIGHT;

  return (
    <div
      ref={containerRef}
      className="shrink-0 flex flex-col border-r border-default/30 bg-background-secondary z-20 select-none relative"
      style={{ width: SIDEBAR_WIDTH }}
      onWheel={onWheel}
    >
      {/* Ruler spacer header / Tracks Header: always sticky at top matching SongRulerHeader */}
      <div
        className="shrink-0 border-b border-default/30 px-2.5 font-bold uppercase flex items-center justify-between text-[10px] tracking-wider text-foreground/60 bg-background-secondary"
        style={{ height: RULER_HEIGHT }}
      >
        <span className="font-semibold uppercase tracking-wider text-foreground/50">
          {effectiveViewMode === "light" ? "Light Tracks" : "Tracks"}
        </span>
        {effectiveViewMode === "light" && lightEnabled ? (
          <Button
            size="sm"
            variant="accent-soft"
            aria-label="Add light track"
            className="h-5 gap-1 px-2 text-[9px] font-semibold normal-case tracking-normal"
            onPress={() => void lighting.trackAdd()}
          >
            <Plus size={11} /> Track
          </Button>
        ) : effectiveViewMode === "audio" ? (
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setAddTrackMenu({ x: rect.left, y: rect.bottom + 2 });
            }}
            title="Add Track (Audio, Software Instrument, or Aux Bus)"
            className="flex h-5 items-center gap-1 px-2 text-[9px] font-semibold text-accent bg-accent/10 hover:bg-accent/20 rounded transition-colors"
          >
            <Plus size={11} /> Track
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-hidden min-h-0">
        <div ref={sidebarContentRef} className="will-change-transform">
          {/* Section-marker lane spacer — inside sidebarContentRef so it scrolls in lockstep with right pane */}
          <div
            className={`${laneHeaderCls} text-[9px] text-foreground/25`}
            style={{ height: SECTION_LANE_HEIGHT }}
          >
            Sections
          </div>
          {/* Event lane spacer — inside sidebarContentRef so it scrolls in lockstep with right pane */}
          <div
            className={`${laneHeaderCls} text-[9px] text-foreground/25`}
            style={{ height: EVENT_LANE_HEIGHT }}
          >
            Events
          </div>
          {/* Cross-mode hint strip */}
          {showHintSpacer && (
            <div
              className={`${laneHeaderCls} text-[9px] text-foreground/25`}
              style={{ height: hintHeight }}
            >
              <span>{effectiveViewMode === "light" ? "Audio ref" : "Light"}</span>
            </div>
          )}

          {effectiveViewMode === "light" ? (
            !lightEnabled ? (
              <div className="flex h-24 items-center justify-center px-3 text-center text-[10px] leading-relaxed text-foreground/40">
                Turn on Light System in the Light tab to author cues
              </div>
            ) : lightTracks.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-3 py-5 text-center text-[10px] text-foreground/40">
                No light tracks
                <span>Use the Track button above to add one</span>
              </div>
            ) : (
              lightTracks.map((t) => {
                const i = state.lighting.tracks?.findIndex((track) => track.id === t.id) ?? 0;

                return (
                  <div key={t.id} className="relative">
                    <div
                      data-light-track-index={i}
                      onPointerDown={(e) => handleTrackPointerDown(e, i, "light")}
                      onPointerMove={handleTrackPointerMove}
                      onPointerUp={handleTrackPointerUp}
                      onPointerCancel={handleTrackPointerCancel}
                      onLostPointerCapture={handleTrackPointerCancel}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSidePanelTrackIndex(i);
                        setCueSelection(null);
                        setLightTrackMenu({
                          x: e.clientX,
                          y: e.clientY,
                          index: i,
                          track: t,
                        });
                      }}
                      className="relative"
                    >
                      <LightTrackHeader
                        track={t}
                        index={i}
                        fixtures={lightFixtures}
                        color={lightTrackColor(i)}
                        height={laneH}
                        selected={sidePanelTrackIndex === i}
                        onSelect={() => {
                          setSidePanelTrackIndex(i);
                          setCueSelection(null);
                        }}
                      />
                    </div>
                  </div>
                );
              })
            )
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-4 gap-2 text-center text-xs text-foreground/40">
              <span>No tracks</span>
              <Button
                size="sm"
                variant="accent-soft"
                className="gap-1 text-[11px]"
                onPress={(e) => {
                  const rect = (
                    e.target as HTMLElement
                  ).getBoundingClientRect();
                  setAddTrackMenu({ x: rect.left, y: rect.bottom + 2 });
                }}
              >
                <Plus size={12} /> Add Track
              </Button>
            </div>
          ) : (
            rows.map((row) => {
              if (row.headerIndex === null || !state.tracks[row.headerIndex]) {
                return (
                  <TimelineRowLabel
                    key={row.name}
                    name={row.name}
                    color={row.color}
                    verticalZoom={verticalZoom}
                  />
                );
              }

              const trackIdx = row.headerIndex;
              return (
                <div key={row.name} className="relative">
                  <div
                    data-track-index={trackIdx}
                    onPointerDown={(e) =>
                      handleTrackPointerDown(e, trackIdx, "audio")
                    }
                    onPointerMove={handleTrackPointerMove}
                    onPointerUp={handleTrackPointerUp}
                    onPointerCancel={handleTrackPointerCancel}
                    onLostPointerCapture={handleTrackPointerCancel}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setTrackMenu({
                        x: e.clientX,
                        y: e.clientY,
                        trackIndex: trackIdx,
                        track: state.tracks[trackIdx] as TrackRow,
                      });
                      const trackId = state.tracks[trackIdx]?.id ?? null;
                      if (
                        !trackId ||
                        !selectedAudioTrackIdSet.has(trackId) ||
                        e.shiftKey ||
                        e.metaKey ||
                        e.ctrlKey
                      ) onSelectTrack?.(trackId, trackSelectionGesture(e));
                    }}
                    className="relative"
                  >
                    <AutomationTrackHeader height={laneH} visible={showAutomation}
                      songIndex={state.songIndex ?? 0} track={state.tracks[trackIdx]}
                      lanes={getAutomationLanesForTrack(state.tracks[trackIdx], state.songs[state.songIndex ?? 0]?.automationLanes ?? [])}
                      activeLaneId={activeAutomationLaneIds?.[state.tracks[trackIdx]?.id ?? ""]}
                      parameters={automationParameters} buses={state.busses}
                      onSelectLane={(laneId) => {
                        const tid = state.tracks[trackIdx]?.id;
                        if (tid) onSelectAutomationLane?.(tid, laneId);
                      }}>
                    <TrackHeaderControl
                      track={state.tracks[trackIdx] as TrackRow}
                      index={trackIdx}
                      color={row.color}
                      verticalZoom={verticalZoom}
                      anySolo={anySolo}
                      isRecording={state.recording ?? false}
                      isSelected={
                        selectedAudioTrackIdSet.has(state.tracks[trackIdx]?.id)
                      }
                      isFocused={
                        state.tracks[trackIdx]?.id === state.activeTrackId
                      }
                      onSelect={(gesture) => {
                        onSelectTrack?.(
                          state.tracks[trackIdx]?.id ?? null,
                          gesture,
                        );
                      }}
                      onGainDragStart={(initialGain) => {
                        const trk = state.tracks[trackIdx];
                        if (trk) {
                          touchRecorder.startGesture(
                            {
                              domain: "strip",
                              entityId: trk.stripId || trk.id,
                              parameterId: "faderGainDb",
                            },
                            initialGain,
                          );
                        }
                      }}
                      onGainDragMove={(g) => {
                        const trk = state.tracks[trackIdx];
                        if (trk) {
                          touchRecorder.recordValue(
                            {
                              domain: "strip",
                              entityId: trk.stripId || trk.id,
                              parameterId: "faderGainDb",
                            },
                            g,
                          );
                        }
                      }}
                      onGainDragEnd={(finalGain) => {
                        const trk = state.tracks[trackIdx];
                        if (trk) {
                          touchRecorder.finishGesture(
                            {
                              domain: "strip",
                              entityId: trk.stripId || trk.id,
                              parameterId: "faderGainDb",
                            },
                            finalGain,
                          );
                        }
                      }}
                      onGainDragCancel={() => {
                        const trk = state.tracks[trackIdx];
                        if (trk) {
                          touchRecorder.cancelGesture({
                            domain: "strip",
                            entityId: trk.stripId || trk.id,
                            parameterId: "faderGainDb",
                          });
                        }
                      }}
                      onPanDragStart={(initialPan) => {
                        const trk = state.tracks[trackIdx];
                        if (trk) {
                          touchRecorder.startGesture(
                            {
                              domain: "strip",
                              entityId: trk.stripId || trk.id,
                              parameterId: "pan",
                            },
                            initialPan,
                          );
                        }
                      }}
                      onPanDragMove={(p) => {
                        const trk = state.tracks[trackIdx];
                        if (trk) {
                          touchRecorder.recordValue(
                            {
                              domain: "strip",
                              entityId: trk.stripId || trk.id,
                              parameterId: "pan",
                            },
                            p,
                          );
                        }
                      }}
                      onPanDragEnd={(finalPan) => {
                        const trk = state.tracks[trackIdx];
                        if (trk) {
                          touchRecorder.finishGesture(
                            {
                              domain: "strip",
                              entityId: trk.stripId || trk.id,
                              parameterId: "pan",
                            },
                            finalPan,
                          );
                        }
                      }}
                      onPanDragCancel={() => {
                        const trk = state.tracks[trackIdx];
                        if (trk) {
                          touchRecorder.cancelGesture({
                            domain: "strip",
                            entityId: trk.stripId || trk.id,
                            parameterId: "pan",
                          });
                        }
                      }}
                    />
                    </AutomationTrackHeader>
                  </div>
                </div>
              );
            })
          )}
          <div className="shrink-0" style={{ height: laneH }} />
        </div>
      </div>

      <TimelineSidebarMenus
        state={state}
        lightTracks={lightTracks}
        contextTrackIndices={contextTrackIndices}
        addTrackMenu={addTrackMenu}
        setAddTrackMenu={setAddTrackMenu}
        trackMenu={trackMenu}
        setTrackMenu={setTrackMenu}
        lightTrackMenu={lightTrackMenu}
        setLightTrackMenu={setLightTrackMenu}
        renamingTrack={renamingTrack}
        setRenamingTrack={setRenamingTrack}
        renamingLightTrack={renamingLightTrack}
        setRenamingLightTrack={setRenamingLightTrack}
        onAddTrack={handleAddTrack}
        onAddBus={handleAddBus}
      />
    </div>
  );
}
