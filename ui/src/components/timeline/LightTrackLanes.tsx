import type { LightTrackRow, SongRow } from "../../lib/types";
import {
  LightTrackLane,
  type CueSelKey,
  type LightCueDragState,
} from "../light/LightTimeline";

export function LightTrackLanes({
  lightEnabled,
  lightTracks,
  lightTrackIds,
  lightTrackColor,
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  scrollState,
  verticalZoom,
  contentWidth,
  readOnly,
  toAbsSec,
  snapLocalSec,
  cueSelection,
  setCueSelection,
  lightCueDrag,
  setLightCueDrag,
}: {
  lightEnabled: boolean;
  lightTracks: LightTrackRow[];
  lightTrackIds: string[];
  lightTrackColor: (index: number) => string;
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  verticalZoom: number;
  contentWidth: number;
  readOnly: boolean;
  toAbsSec: (clientX: number) => number;
  snapLocalSec: (songIndex: number, localSec: number) => number;
  cueSelection: CueSelKey | null;
  setCueSelection: (v: CueSelKey | null) => void;
  lightCueDrag: LightCueDragState | null;
  setLightCueDrag: (v: LightCueDragState | null) => void;
}) {
  if (!lightEnabled) {
    return (
      <div className="flex h-24 items-center justify-center px-6 text-center text-xs text-foreground/40">
        Lighting is disabled. Enable it in Settings &gt; Project to author light
        cues.
      </div>
    );
  }
  if (lightTracks.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center px-6 text-center text-xs text-foreground/40">
        No light tracks yet — add one from the sidebar, then click an empty lane
        to place a cue.
      </div>
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
          verticalZoom={verticalZoom}
          contentWidth={contentWidth}
          readOnly={readOnly}
          toAbsSec={toAbsSec}
          snapLocalSec={snapLocalSec}
          selected={cueSelection}
          onSelect={setCueSelection}
          activeDrag={lightCueDrag}
          onActiveDragChange={setLightCueDrag}
        />
      ))}
      <div className="h-6 shrink-0" />
    </>
  );
}
