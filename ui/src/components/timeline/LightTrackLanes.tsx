import { EmptyState } from "@heroui/react";
import type { LightTrackRow, SongRow } from "../../lib/types";
import {
  LightTrackLane,
  type CueSelKey,
  type LightCueDragState,
} from "../light/LightTimeline";
import type { TimelineTool } from "./tools";

export function LightTrackLanes({
  lightEnabled,
  lightTracks,
  lightTrackIds,
  lightTrackColor,
  lightTrueColors,
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  scrollState,
  verticalZoom,
  contentWidth,
  readOnly,
  tool,
  toAbsSec,
  snapLocalSec,
  selectedCueKeys,
  onSelectCue,
  onCopySelectedCues,
  onDeleteSelectedCues,
  lightCueDrag,
  setLightCueDrag,
}: {
  lightEnabled: boolean;
  lightTracks: LightTrackRow[];
  lightTrackIds: string[];
  lightTrackColor: (index: number) => string;
  /** Show the rig's real output colours instead of the theme-tinted ones. */
  lightTrueColors: boolean;
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  verticalZoom: number;
  contentWidth: number;
  readOnly: boolean;
  tool: TimelineTool;
  toAbsSec: (clientX: number) => number;
  snapLocalSec: (songIndex: number, localSec: number) => number;
  selectedCueKeys: CueSelKey[];
  onSelectCue: (
    sel: CueSelKey | null,
    mods?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => void;
  onCopySelectedCues: () => void;
  onDeleteSelectedCues: () => void;
  lightCueDrag: LightCueDragState | null;
  setLightCueDrag: (v: LightCueDragState | null) => void;
}) {
  if (!lightEnabled) {
    return (
      <EmptyState className="flex h-24 items-center justify-center px-6 text-center text-xs">
        Lighting is disabled. Enable it in Settings &gt; Project to author light
        cues.
      </EmptyState>
    );
  }
  if (lightTracks.length === 0) {
    return (
      <EmptyState className="flex h-24 items-center justify-center px-6 text-center text-xs">
        No light tracks yet — add one from the sidebar, then use the Pencil tool
        and click an empty lane to place a cue.
      </EmptyState>
    );
  }
  return (
    <>
      {lightTracks.map((t, i) => (
        <LightTrackLane
          key={t.id}
          track={t}
          trackIndex={i}
          trackIds={lightTrackIds}
          color={lightTrackColor(i)}
          songs={songs}
          songOffsets={songOffsets}
          songLengths={songLengths}
          pxPerSec={pxPerSec}
          scrollState={scrollState}
          lightTrueColors={lightTrueColors}
          verticalZoom={verticalZoom}
          contentWidth={contentWidth}
          readOnly={readOnly}
          tool={tool}
          toAbsSec={toAbsSec}
          snapLocalSec={snapLocalSec}
          selectedKeys={selectedCueKeys}
          onSelect={onSelectCue}
          onCopySelected={onCopySelectedCues}
          onDeleteSelected={onDeleteSelectedCues}
          activeDrag={lightCueDrag}
          onActiveDragChange={setLightCueDrag}
        />
      ))}
      <div className="h-6 shrink-0" />
    </>
  );
}
