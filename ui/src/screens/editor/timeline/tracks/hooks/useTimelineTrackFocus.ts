import { useEffect, useRef } from "react";
import type { LightTrackRow, TrackRow } from "../../../../../lib/state/types";
import type { CueSelKey } from "../../../../light/components/LightTimeline";

interface TimelineTrackFocusOptions {
  tracks: TrackRow[];
  lightTracks: LightTrackRow[];
  projectName: string | null;
  selectedTrackId?: string | null;
  onSelectTrackId?: (id: string | null) => void;
  setSidePanelTrackIndex: (index: number | null) => void;
  setCueSelection: (key: CueSelKey | null) => void;
  setSelectedCueKeys: (keys: CueSelKey[]) => void;
  scrollToTrackIndex: (index: number) => void;
}

/** Focus and reveal tracks added to the active project or selected on load. */
export function useTimelineTrackFocus({
  tracks,
  lightTracks,
  projectName,
  selectedTrackId,
  onSelectTrackId,
  setSidePanelTrackIndex,
  setCueSelection,
  setSelectedCueKeys,
  scrollToTrackIndex,
}: TimelineTrackFocusOptions) {
  // Auto-focus and scroll to new track on creation.
  const prevTrackCountRef = useRef(tracks.length);
  useEffect(() => {
    if (tracks.length > prevTrackCountRef.current) {
      const newTrackIdx = tracks.length - 1;
      const newTrack = tracks[newTrackIdx];
      if (newTrack) {
        onSelectTrackId?.(newTrack.id);
        scrollToTrackIndex(newTrackIdx);
      }
    }
    prevTrackCountRef.current = tracks.length;
  }, [tracks.length, tracks, onSelectTrackId, scrollToTrackIndex]);

  // Auto-focus and scroll to new light track on creation.
  const prevLightTrackCountRef = useRef(lightTracks.length);
  useEffect(() => {
    if (lightTracks.length > prevLightTrackCountRef.current) {
      const newIdx = lightTracks.length - 1;
      setSidePanelTrackIndex(newIdx);
      setCueSelection(null);
      setSelectedCueKeys([]);
      scrollToTrackIndex(newIdx);
    }
    prevLightTrackCountRef.current = lightTracks.length;
  }, [
    lightTracks.length,
    scrollToTrackIndex,
    setCueSelection,
    setSelectedCueKeys,
    setSidePanelTrackIndex,
  ]);

  // Auto-scroll to the active track on project load.
  const lastProjectNameRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectName) return;
    const isNewProject = lastProjectNameRef.current !== projectName;
    if (isNewProject) {
      lastProjectNameRef.current = projectName;
      if (selectedTrackId) {
        const index = tracks.findIndex((track) => track.id === selectedTrackId);
        if (index >= 0) scrollToTrackIndex(index);
      }
    }
  }, [projectName, selectedTrackId, tracks, scrollToTrackIndex]);
}
