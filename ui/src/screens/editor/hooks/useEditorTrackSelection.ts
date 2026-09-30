import { useCallback, useEffect, useRef, useState } from "react";
import { mixer } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";
import {
  resolveTrackSelection,
  type TrackSelectionGesture,
} from "@/screens/editor/timeline/tracks/logic/trackSelection";

/** Owns the editor's range/toggle selection and its synchronization with Core focus. */
export function useEditorTrackSelection(state: WebUiState) {
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const trackSelectionAnchorRef = useRef<string | null>(null);
  const lastProjectNameRef = useRef<string | null>(null);
  const pendingUserTrackSelectRef = useRef<string | null>(null);

  const handleSelectTrack = useCallback((
    trackId: string | null,
    gesture: TrackSelectionGesture = "replace",
  ) => {
    const next = resolveTrackSelection(
      {
        selectedIds: selectedTrackIds,
        primaryId: selectedTrackId,
        anchorId: trackSelectionAnchorRef.current,
      },
      state.tracks.map((track) => track.id),
      trackId,
      gesture,
    );
    pendingUserTrackSelectRef.current =
      next.primaryId && next.primaryId !== state.activeTrackId
        ? next.primaryId
        : null;
    trackSelectionAnchorRef.current = next.anchorId;
    setSelectedTrackId(next.primaryId);
    setSelectedTrackIds(next.selectedIds);
    const focusedIndex = state.tracks.findIndex(
      (track) => track.id === next.primaryId,
    );
    if (focusedIndex >= 0) void mixer.setFocusedTrack(focusedIndex);
    else if (gesture === "toggle") void mixer.setFocusedTrack(-1);
  }, [selectedTrackId, selectedTrackIds, state.activeTrackId, state.tracks]);

  useEffect(() => {
    if (!state.projectName) return;
    const isNewProject = lastProjectNameRef.current !== state.projectName;
    if (isNewProject) {
      lastProjectNameRef.current = state.projectName;
      pendingUserTrackSelectRef.current = null;
      trackSelectionAnchorRef.current = state.activeTrackId || null;
      if (
        state.activeTrackId &&
        state.tracks.some((track) => track.id === state.activeTrackId)
      ) {
        setSelectedTrackId(state.activeTrackId);
        setSelectedTrackIds([state.activeTrackId]);
      }
      return;
    }

    if (
      pendingUserTrackSelectRef.current &&
      state.activeTrackId === pendingUserTrackSelectRef.current
    ) {
      pendingUserTrackSelectRef.current = null;
    }

    if (!pendingUserTrackSelectRef.current && state.activeTrackId) {
      if (
        state.activeTrackId !== selectedTrackId &&
        state.tracks.some((track) => track.id === state.activeTrackId)
      ) {
        setSelectedTrackId(state.activeTrackId);
        setSelectedTrackIds([state.activeTrackId]);
        trackSelectionAnchorRef.current = state.activeTrackId;
      }
    }
  }, [state.activeTrackId, state.projectName, state.tracks, selectedTrackId]);

  useEffect(() => {
    const available = new Set(state.tracks.map((track) => track.id));
    setSelectedTrackIds((current) =>
      current.every((id) => available.has(id))
        ? current
        : current.filter((id) => available.has(id)),
    );
  }, [state.tracks]);

  return { selectedTrackId, selectedTrackIds, handleSelectTrack };
}
