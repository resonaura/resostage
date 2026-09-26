import { Plus, Music, Mic, Sliders } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui";
import { ContextMenu, ContextMenuItem } from "../ContextMenu";
import type {
  LightFixtureRow,
  LightTrackRow,
  TrackRow,
  WebUiState,
} from "../../lib/types";
import { builder, lighting } from "../../lib/api";
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
}) {
  const [addTrackMenu, setAddTrackMenu] = useState<{ x: number; y: number } | null>(null);

  const handleAddTrack = async (kind: "audio" | "instrument", channels = 2) => {
    setAddTrackMenu(null);
    const songIndex = state.songIndex >= 0 ? state.songIndex : 0;
    await builder.trackAdd(songIndex, { kind, channels });
    if (kind === "instrument") {
      // Create an initial pattern region for the new instrument track
      const newTrackId = `trk${state.tracks.length + 1}`;
      void builder.midiRegionAdd({
        songIndex,
        trackId: newTrackId,
        name: `Pattern ${state.tracks.length + 1}`,
        startBeats: 0,
        durationBeats: 16,
        loop: true,
        loopLengthBeats: 16,
      });
    }
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
    >
      {/* Ruler spacer header */}
      <div
        className={`${laneHeaderCls} text-[10px] tracking-wider text-foreground/40`}
        style={{ height: RULER_HEIGHT }}
      >
        Songs
      </div>
      {/* Section-marker lane spacer */}
      <div
        className={`${laneHeaderCls} text-[9px] text-foreground/25`}
        style={{ height: SECTION_LANE_HEIGHT }}
      >
        Sections
      </div>
      {/* Event lane spacer */}
      <div
        className={`${laneHeaderCls} text-[9px] text-foreground/25`}
        style={{ height: EVENT_LANE_HEIGHT }}
      >
        Events
      </div>
      {/* Cross-mode hint strip */}
      {showHintSpacer && (
        <div
          className={`${laneHeaderCls} justify-between text-[9px] text-foreground/25`}
          style={{ height: hintHeight }}
        >
          <span>{effectiveViewMode === "light" ? "Audio ref" : "Light"}</span>
          {effectiveViewMode === "light" && lightEnabled ? (
            <Button
              size="sm"
              variant="accent-soft"
              aria-label="Add light track"
              className="h-5 gap-0.5 px-1.5 text-[9px] normal-case tracking-normal"
              onPress={() => void lighting.trackAdd()}
            >
              <Plus size={10} /> Track
            </Button>
          ) : effectiveViewMode === "audio" ? (
            <button
              type="button"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setAddTrackMenu({ x: rect.left, y: rect.bottom + 2 });
              }}
              title="Add Track (Audio or Software Instrument)"
              className="flex h-5 items-center gap-0.5 px-1.5 text-[9px] font-semibold text-accent hover:bg-accent/15 rounded transition-colors"
            >
              <Plus size={10} /> Track
            </button>
          ) : null}
        </div>
      )}

      <div className="flex-1 overflow-hidden min-h-0">
        <div ref={sidebarContentRef} className="will-change-transform">
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
                  const rect = (e.target as HTMLElement).getBoundingClientRect();
                  setAddTrackMenu({ x: rect.left, y: rect.bottom + 2 });
                }}
              >
                <Plus size={12} /> Add Track
              </Button>
            </div>
          ) : (
            <>
              {rows.map((row) =>
                row.headerIndex !== null && state.tracks[row.headerIndex] ? (
                  <TrackHeaderControl
                    key={row.name}
                    track={state.tracks[row.headerIndex] as TrackRow}
                    index={row.headerIndex}
                    color={row.color}
                    verticalZoom={verticalZoom}
                    anySolo={anySolo}
                    isRecording={state.recording ?? false}
                    isSelected={state.tracks[row.headerIndex]?.id === selectedTrackId}
                    onSelect={() => {
                      if (row.headerIndex !== null) {
                        onSelectTrack?.(state.tracks[row.headerIndex]?.id ?? null);
                      }
                    }}
                  />
                ) : (
                  <TimelineRowLabel
                    key={row.name}
                    name={row.name}
                    color={row.color}
                    verticalZoom={verticalZoom}
                  />
                ),
              )}
              <div className="p-2">
                <button
                  type="button"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setAddTrackMenu({ x: rect.left, y: rect.bottom + 2 });
                  }}
                  className="flex h-7 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-default/30 bg-surface/30 text-[10px] font-semibold text-foreground/50 hover:border-accent/40 hover:bg-accent/10 hover:text-accent transition-all"
                  title="Add Audio or Software Instrument Track"
                >
                  <Plus size={12} /> Add Track
                </button>
              </div>
            </>
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
    </div>
  );
}
