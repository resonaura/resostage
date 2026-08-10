import { Plus } from "lucide-react";
import { Button } from "../ui";
import type {
  LightFixtureRow,
  LightTrackRow,
  TrackRow,
  WebUiState,
} from "../../lib/types";
import { lighting } from "../../lib/api";
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
}) {
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
      {/* Cross-mode hint strip: Audio mode → dimmed light strip label;
          Light mode → audio reference + persistent "add track" control. */}
      {showHintSpacer && (
        <div
          className={`${laneHeaderCls} justify-between text-[9px] text-foreground/25`}
          style={{ height: hintHeight }}
        >
          <span>{effectiveViewMode === "light" ? "Audio ref" : "Light"}</span>
          {effectiveViewMode === "light" && lightEnabled && (
            <Button
              size="sm"
              variant="accent-soft"
              aria-label="Add light track"
              className="h-5 gap-0.5 px-1.5 text-[9px] normal-case tracking-normal"
              onPress={() => void lighting.trackAdd()}
            >
              <Plus size={10} /> Track
            </Button>
          )}
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
            <div className="flex h-20 items-center justify-center px-2 text-[10px] text-foreground/40">
              No tracks
            </div>
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
