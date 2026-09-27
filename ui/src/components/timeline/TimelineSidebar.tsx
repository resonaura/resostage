import { Plus, Music, Mic, Sliders } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../common/ContextMenu";
import { InlineNamePrompt } from "../common/InlineNamePrompt";
import type {
  LightFixtureRow,
  LightTrackRow,
  TrackRow,
  WebUiState,
} from "../../lib/state/types";
import { builder, lighting, mixer } from "../../lib/state/api";
import {
  LightTrackHeader,
  AUDIO_HINT_HEIGHT,
  LIGHT_HINT_HEIGHT,
} from "../light/LightTimeline";
import { laneHeightPx } from "./laneDimensions";
import {
  EVENT_LANE_HEIGHT,
  RULER_HEIGHT,
  SECTION_LANE_HEIGHT,
  SIDEBAR_WIDTH,
} from "./constants";
import type { TimelineRow } from "./rows";
import { TimelineRowLabel } from "./TimelineRowLabel";
import type { TimelineViewMode } from "./TimelineToolbar";
import { TrackHeaderControl } from "./TrackHeaderControl";

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
  onSelectTrack,
  onWheel,
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
  onSelectTrack?: (id: string | null) => void;
  onWheel?: (e: React.WheelEvent) => void;
}) {
  const [addTrackMenu, setAddTrackMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const [trackMenu, setTrackMenu] = useState<{
    x: number;
    y: number;
    trackIndex: number;
    track: TrackRow;
  } | null>(null);
  const [renamingTrack, setRenamingTrack] = useState<{
    x: number;
    y: number;
    index: number;
    name: string;
  } | null>(null);

  const [lightTrackMenu, setLightTrackMenu] = useState<{
    x: number;
    y: number;
    index: number;
    track: LightTrackRow;
  } | null>(null);
  const [renamingLightTrack, setRenamingLightTrack] = useState<{
    x: number;
    y: number;
    index: number;
    name: string;
  } | null>(null);

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
  const laneH = laneHeightPx(verticalZoom);

  // Keep spacer height in lockstep with the body's hint strip so rows align.
  const showHintSpacer = effectiveViewMode === "audio" ? hasLightContent : true;
  const hintHeight =
    effectiveViewMode === "light" ? AUDIO_HINT_HEIGHT : LIGHT_HINT_HEIGHT;

  return (
    <div
      className="shrink-0 flex flex-col border-r border-default/30 bg-background-secondary z-20 select-none"
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
              lightTracks.map((t, i) => (
                <LightTrackHeader
                  key={t.id}
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
                />
              ))
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
            rows.map((row) =>
              row.headerIndex !== null && state.tracks[row.headerIndex] ? (
                <div
                  key={row.name}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (row.headerIndex !== null) {
                      setTrackMenu({
                        x: e.clientX,
                        y: e.clientY,
                        trackIndex: row.headerIndex,
                        track: state.tracks[row.headerIndex] as TrackRow,
                      });
                      void mixer.setFocusedTrack(row.headerIndex);
                      onSelectTrack?.(
                        state.tracks[row.headerIndex]?.id ?? null,
                      );
                    }
                  }}
                >
                  <TrackHeaderControl
                    track={state.tracks[row.headerIndex] as TrackRow}
                    index={row.headerIndex}
                    color={row.color}
                    verticalZoom={verticalZoom}
                    anySolo={anySolo}
                    isRecording={state.recording ?? false}
                    isSelected={
                      state.tracks[row.headerIndex]?.id === selectedTrackId
                    }
                    onSelect={() => {
                      if (row.headerIndex !== null) {
                        void mixer.setFocusedTrack(row.headerIndex);
                        onSelectTrack?.(
                          state.tracks[row.headerIndex]?.id ?? null,
                        );
                      }
                    }}
                  />
                </div>
              ) : (
                <TimelineRowLabel
                  key={row.name}
                  name={row.name}
                  color={row.color}
                  verticalZoom={verticalZoom}
                />
              ),
            )
          )}
          <div className="shrink-0" style={{ height: laneH }} />
        </div>
      </div>

      {addTrackMenu && (
        <ContextMenu
          x={addTrackMenu.x}
          y={addTrackMenu.y}
          width={220}
          onClose={() => setAddTrackMenu(null)}
        >
          <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-foreground/40 border-b border-default/20">
            Create New Track
          </div>
          <ContextMenuItem onClick={() => void handleAddTrack("instrument", 2)}>
            <div className="flex items-center gap-2">
              <Music size={14} className="text-purple-400" />
              <span>Software Instrument Track</span>
            </div>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handleAddTrack("audio", 2)}>
            <div className="flex items-center gap-2">
              <Mic size={14} className="text-blue-400" />
              <span>Audio Track (Stereo)</span>
            </div>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handleAddTrack("audio", 1)}>
            <div className="flex items-center gap-2">
              <Mic size={14} className="text-teal-400" />
              <span>Audio Track (Mono)</span>
            </div>
          </ContextMenuItem>
          <div className="my-1 border-t border-default/20" />
          <ContextMenuItem onClick={handleAddBus}>
            <div className="flex items-center gap-2">
              <Sliders size={14} className="text-orange-400" />
              <span>Aux / Send Bus</span>
            </div>
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Audio / Instrument Track Context Menu */}
      {trackMenu && (
        <ContextMenu
          x={trackMenu.x}
          y={trackMenu.y}
          width={210}
          onClose={() => setTrackMenu(null)}
        >
          <ContextMenuItem
            onClick={() => {
              const tm = trackMenu;
              setTrackMenu(null);
              setRenamingTrack({
                x: tm.x,
                y: tm.y,
                index: tm.trackIndex,
                name: tm.track.name || tm.track.id,
              });
            }}
          >
            Rename…
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            disabled={trackMenu.trackIndex === 0}
            onClick={() => {
              const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
              void builder.trackMove(songIdx, trackMenu.trackIndex, -1);
              setTrackMenu(null);
            }}
          >
            Move Up
          </ContextMenuItem>
          <ContextMenuItem
            disabled={trackMenu.trackIndex >= state.tracks.length - 1}
            onClick={() => {
              const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
              void builder.trackMove(songIdx, trackMenu.trackIndex, 1);
              setTrackMenu(null);
            }}
          >
            Move Down
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            onClick={() => {
              void mixer.setTrackGain(trackMenu.trackIndex, 0);
              void mixer.setTrackPan(trackMenu.trackIndex, 0);
              setTrackMenu(null);
            }}
          >
            Reset Gain & Pan
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void mixer.setTrackMute(trackMenu.trackIndex, false);
              void mixer.setTrackSolo(trackMenu.trackIndex, false);
              setTrackMenu(null);
            }}
          >
            Clear Mute & Solo
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              const isPol =
                (trackMenu.track.polarity ??
                  (trackMenu.track.phaseInvert ? "both" : "none")) !== "none";
              const nextPol = isPol
                ? "none"
                : trackMenu.track.channels === 1
                  ? "left"
                  : "both";
              void mixer.setTrackTrim(
                trackMenu.trackIndex,
                trackMenu.track.inputTrimDb ?? 0,
                nextPol !== "none",
                nextPol,
              );
              setTrackMenu(null);
            }}
          >
            Phase Invert (Ø)
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            danger
            onClick={() => {
              const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
              void builder.trackRemove(songIdx, trackMenu.trackIndex);
              setTrackMenu(null);
            }}
          >
            Delete Track
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Light Track Context Menu */}
      {lightTrackMenu && (
        <ContextMenu
          x={lightTrackMenu.x}
          y={lightTrackMenu.y}
          width={200}
          onClose={() => setLightTrackMenu(null)}
        >
          <ContextMenuItem
            onClick={() => {
              const lm = lightTrackMenu;
              setLightTrackMenu(null);
              setRenamingLightTrack({
                x: lm.x,
                y: lm.y,
                index: lm.index,
                name: lm.track.name || `Light Track ${lm.index + 1}`,
              });
            }}
          >
            Rename…
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            disabled={lightTrackMenu.index === 0}
            onClick={() => {
              void lighting.trackMove(lightTrackMenu.index, -1);
              setLightTrackMenu(null);
            }}
          >
            Move Up
          </ContextMenuItem>
          <ContextMenuItem
            disabled={lightTrackMenu.index >= lightTracks.length - 1}
            onClick={() => {
              void lighting.trackMove(lightTrackMenu.index, 1);
              setLightTrackMenu(null);
            }}
          >
            Move Down
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            onClick={() => {
              void lighting.trackAdd();
              setLightTrackMenu(null);
            }}
          >
            Add Light Track
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            danger
            onClick={() => {
              void lighting.trackRemove(lightTrackMenu.index);
              setLightTrackMenu(null);
            }}
          >
            Delete Track
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Rename Prompt for Audio / Instrument Track */}
      {renamingTrack && (
        <InlineNamePrompt
          x={renamingTrack.x}
          y={renamingTrack.y}
          value={renamingTrack.name}
          placeholder="Track name"
          onChange={(val) =>
            setRenamingTrack((prev) => (prev ? { ...prev, name: val } : null))
          }
          onCommit={() => {
            const name = renamingTrack.name.trim();
            if (name.length > 0) {
              const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
              void builder.trackUpdate({
                songIndex: songIdx,
                index: renamingTrack.index,
                name,
              });
            }
            setRenamingTrack(null);
          }}
          onCancel={() => setRenamingTrack(null)}
        />
      )}

      {/* Rename Prompt for Light Track */}
      {renamingLightTrack && (
        <InlineNamePrompt
          x={renamingLightTrack.x}
          y={renamingLightTrack.y}
          value={renamingLightTrack.name}
          placeholder="Light track name"
          onChange={(val) =>
            setRenamingLightTrack((prev) =>
              prev ? { ...prev, name: val } : null,
            )
          }
          onCommit={() => {
            const name = renamingLightTrack.name.trim();
            if (name.length > 0) {
              void lighting.trackUpdate({
                index: renamingLightTrack.index,
                name,
              });
            }
            setRenamingLightTrack(null);
          }}
          onCancel={() => setRenamingLightTrack(null)}
        />
      )}
    </div>
  );
}
