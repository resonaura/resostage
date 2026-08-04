import type {
  LightFixtureRow,
  LightTrackRow,
  TrackRow,
  WebUiState,
} from "../../lib/types";
import {
  LightTrackHeader,
  AUDIO_HINT_HEIGHT,
  LIGHT_HINT_HEIGHT,
} from "../light/LightTimeline";
import { laneHeightPx } from "../TrackWaveformLane";
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
  setCueSelection: (v: null) => void;
  sidebarContentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const anySolo =
    state.tracks.some((t) => t.solo) || state.busses.some((b) => b.solo);
  const laneH = laneHeightPx(verticalZoom);

  return (
    <div
      className="shrink-0 flex flex-col border-r border-default/30 bg-background-secondary z-20 select-none"
      style={{ width: SIDEBAR_WIDTH }}
    >
      <div
        className="shrink-0 border-b border-default/30 bg-background-tertiary"
        style={{ height: RULER_HEIGHT }}
      />
      <div
        className="shrink-0 border-b border-default/30 bg-surface/20"
        style={{ height: SECTION_LANE_HEIGHT }}
      />
      <div
        className="shrink-0 border-b border-default/30 bg-surface/30"
        style={{ height: EVENT_LANE_HEIGHT }}
      />
      {(effectiveViewMode === "audio" ? hasLightContent : true) && (
        <div
          className="shrink-0 border-b border-default/20"
          style={{
            height:
              effectiveViewMode === "audio"
                ? LIGHT_HINT_HEIGHT
                : AUDIO_HINT_HEIGHT,
          }}
        />
      )}

      <div className="flex-1 overflow-hidden min-h-0">
        <div ref={sidebarContentRef} className="will-change-transform">
          {effectiveViewMode === "light" ? (
            !lightEnabled ? (
              <div className="px-3 py-4 text-[11px] text-foreground/40">
                Lighting disabled
              </div>
            ) : lightTracks.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-foreground/40">
                No light tracks
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
          ) : (
            rows.map((row) =>
              row.headerIndex !== null && state.tracks[row.headerIndex] ? (
                <TrackHeaderControl
                  key={row.name}
                  track={state.tracks[row.headerIndex] as TrackRow}
                  index={row.headerIndex}
                  color={row.color}
                  verticalZoom={verticalZoom}
                  anySolo={anySolo}
                />
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
    </div>
  );
}
