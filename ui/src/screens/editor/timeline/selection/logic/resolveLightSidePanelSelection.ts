import type { LightSidePanelSelection } from "../../../../light/components/LightSidePanel";
import type { CueSelKey } from "../../../../light/components/LightTimeline";
import type { TimelineViewMode } from "../../toolbar/logic/types";
import type { LightTrackRow, SongRow } from "../../../../../lib/state/types";

interface ResolveLightSidePanelSelectionArgs {
  viewMode: TimelineViewMode;
  cueSelection: CueSelKey | null;
  sidePanelTrackIndex: number | null;
  songs: SongRow[];
  tracks: LightTrackRow[];
}

/** Resolve the light inspector's primary cue, selected track, or default track. */
export function resolveLightSidePanelSelection({
  viewMode,
  cueSelection,
  sidePanelTrackIndex,
  songs,
  tracks,
}: ResolveLightSidePanelSelectionArgs): LightSidePanelSelection | null {
  if (viewMode !== "light") return null;

  if (cueSelection) {
    const song = songs[cueSelection.songIndex];
    const cue = song?.lightCues?.find((item) => item.id === cueSelection.cueId);
    if (cue) {
      const trackIndex = tracks.findIndex((track) => track.id === cue.trackId);
      if (trackIndex >= 0) {
        return {
          type: "cue",
          songIndex: cueSelection.songIndex,
          cue,
          trackIndex,
          track: tracks[trackIndex],
        };
      }
    }
  }

  if (sidePanelTrackIndex !== null && tracks[sidePanelTrackIndex]) {
    return {
      type: "track",
      trackIndex: sidePanelTrackIndex,
      track: tracks[sidePanelTrackIndex],
    };
  }

  if (sidePanelTrackIndex === null && tracks.length > 0) {
    return { type: "track", trackIndex: 0, track: tracks[0] };
  }

  return null;
}
