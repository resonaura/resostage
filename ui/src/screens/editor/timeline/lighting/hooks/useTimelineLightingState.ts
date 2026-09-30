import { useEffect, useMemo } from "react";
import type { LightCueValue } from "@/lib/light/lightCueInterpolation";
import type { WebUiState } from "@/lib/state/types";
import { getLightColor } from "@/screens/light/logic/lightColors";
import type { LightSidePanelSelection } from "@/screens/light/components/LightSidePanel";
import type { CueSelKey } from "@/screens/light/components/LightTimeline";
import { resolveLightSidePanelSelection } from "@/screens/editor/timeline/selection/logic/resolveLightSidePanelSelection";
import { previewDropReorder } from "@/screens/editor/timeline/tracks/logic/dropPreview";
import type { TimelineViewMode } from "@/screens/editor/timeline/toolbar/logic/types";

export interface TimelineTrackReorderPreview {
  index: number;
  kind: "audio" | "light";
  dropSlot: number;
}

export function useTimelineLightingState({
  state,
  songs,
  effectiveViewMode,
  trackReorderPreview,
  cueSelection,
  sidePanelTrackIndex,
  setCueSelection,
}: {
  state: WebUiState;
  songs: WebUiState["songs"];
  effectiveViewMode: TimelineViewMode;
  trackReorderPreview: TimelineTrackReorderPreview | null;
  cueSelection: CueSelKey | null;
  sidePanelTrackIndex: number | null;
  setCueSelection: React.Dispatch<React.SetStateAction<CueSelKey | null>>;
}) {
  // Light-mode derived data (Feature 6). Guarded with optional chaining so an
  // older WebUiState snapshot without the lighting fields still renders.
  const lightTracks = useMemo(
    () => state.lighting.tracks ?? [],
    [state.lighting.tracks],
  );
  const previewLightTracks = useMemo(() => {
    if (trackReorderPreview?.kind !== "light") return lightTracks;
    const { index, dropSlot } = trackReorderPreview;
    return previewDropReorder(lightTracks, index, dropSlot);
  }, [lightTracks, trackReorderPreview]);
  const lightTrackIds = useMemo(
    () => lightTracks.map((track) => track.id),
    [lightTracks],
  );
  const lightFixtures = useMemo(
    () => state.lighting?.fixtures ?? [],
    [state.lighting?.fixtures],
  );
  const lightEnabled = Boolean(state.lighting?.enabled);
  const lightTrackColor = (index: number) => getLightColor(Math.max(0, index));
  const lightTrackColorForId = (trackId: string) =>
    lightTrackColor(lightTracks.findIndex((track) => track.id === trackId));
  const hasLightContent =
    lightEnabled &&
    (lightTracks.length > 0 ||
      songs.some((song) => (song.lightCues ?? []).length > 0));

  // Live 3D stage colors come only from the core binary LED stream
  // (LightSidePanel). Do not re-resolve cues on the frontend.
  const previewColors = useMemo(
    () => ({}) as Record<string, LightCueValue>,
    [],
  );

  // Derived side-panel selection (after songs, lightTracks, cueSelection are defined).
  const sidePanelSelection: LightSidePanelSelection | null =
    resolveLightSidePanelSelection({
      viewMode: effectiveViewMode,
      cueSelection,
      sidePanelTrackIndex,
      songs,
      tracks: lightTracks,
    });

  // Drop cue selection when the cue itself disappears (delete / reload).
  useEffect(() => {
    if (!cueSelection) return;
    const song = songs[cueSelection.songIndex];
    const cue = song?.lightCues?.find((item) => item.id === cueSelection.cueId);
    if (!cue) setCueSelection(null);
  }, [songs, cueSelection, setCueSelection]);

  return {
    lightTracks,
    previewLightTracks,
    lightTrackIds,
    lightFixtures,
    lightEnabled,
    lightTrackColor,
    lightTrackColorForId,
    hasLightContent,
    previewColors,
    sidePanelSelection,
  };
}
