import type { RefObject } from "react";
import type { PluginCatalogEntry } from "@/lib/state/api";
import type { BusRow, WebUiState } from "@/lib/state/types";
import { ConsolePane } from "@/screens/mixer/components/ConsolePane";
import type { WindowResult } from "@/screens/mixer/logic/horizontalWindow";
import { TrackStrip } from "@/screens/mixer/strips/TrackStrip";
import type { TrackStripProps } from "@/screens/mixer/strips/types";
import type { MixerDensity } from "@/screens/mixer/logic/constants";
import type { StripMenuTarget } from "@/screens/mixer/strips/StripContextMenu";

type TrackRackState = Pick<
  WebUiState,
  "tracks" | "busses" | "meters" | "settings" | "recording"
>;

/** The horizontally virtualized track strips in the mixer. */
export function MixerTrackRack({
  state,
  compact,
  density,
  contentRef,
  window,
  destinationBusses,
  auxBusses,
  anySoloInGroup,
  pluginCatalog,
  isRecording,
  targetPluginSlots,
  onDirectOutput,
  onOpenPlugins,
  onMenuTarget,
  songIndex,
}: {
  state: TrackRackState;
  compact: boolean;
  density: MixerDensity;
  contentRef: RefObject<HTMLDivElement | null>;
  window: WindowResult;
  destinationBusses: BusRow[];
  auxBusses: BusRow[];
  anySoloInGroup: boolean;
  pluginCatalog: PluginCatalogEntry[];
  isRecording: boolean;
  targetPluginSlots: number;
  onDirectOutput: TrackStripProps["onDirectOutput"];
  onOpenPlugins: (stripId: string, stripName: string) => void;
  onMenuTarget: (target: StripMenuTarget) => void;
  songIndex: number;
}) {
  return (
    <ConsolePane
      compact={compact}
      className={`flex min-h-0 pr-1 ${compact ? "shrink-0" : "flex-1"}`}
    >
      {/* Spacers stand in for the strips that are not mounted, so the
          scroll extent and every strip's position are unchanged.
          The leading one also carries the ref: it is the row's first
          child, so its left edge IS the row's left edge, which is the
          offset the window is computed from. */}
      <div
        ref={contentRef}
        className="h-full shrink-0"
        style={{ width: window.padStartPx }}
        aria-hidden
      />
      {state.tracks.slice(window.start, window.end).map((track, offset) => {
        const index = window.start + offset;
        return (
          <div
            key={track.id}
            className="mr-2 flex h-full min-h-0 shrink-0"
            onContextMenu={(event) => {
              event.preventDefault();
              onMenuTarget({
                kind: "track",
                x: event.clientX,
                y: event.clientY,
                index,
                track,
                songIndex,
              });
            }}
          >
            <TrackStrip
              t={track}
              index={index}
              destinationBusses={destinationBusses}
              allBusses={state.busses}
              auxBusses={auxBusses}
              meters={state.meters}
              settings={state.settings}
              anySoloInGroup={anySoloInGroup}
              pluginCatalog={pluginCatalog}
              isRecording={isRecording}
              density={density}
              targetPluginSlots={targetPluginSlots}
              onDirectOutput={onDirectOutput}
              onOpenPlugins={onOpenPlugins}
            />
          </div>
        );
      })}
      <div
        className="h-full shrink-0"
        style={{ width: window.padEndPx }}
        aria-hidden
      />
    </ConsolePane>
  );
}
