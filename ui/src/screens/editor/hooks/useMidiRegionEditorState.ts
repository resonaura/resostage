/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useRef, useState } from "react";
import { builder } from "@/lib/state/api";
import { subscribeHistoryBoundary } from "@/lib/state/historyNavigation";
import type { MidiNoteRow, WebUiState } from "@/lib/state/types";

export interface PendingMidiRegionCreation {
  songIndex: number;
  trackId: string;
  notes: MidiNoteRow[];
  followupEdit: boolean;
  startedAt: number;
}

/** Tracks the selected/visible MIDI regions and reconciles provisional IDs with Core. */
export function useMidiRegionEditorState(state: WebUiState) {
  const [selectedMidiTrackId, setSelectedMidiTrackId] = useState<string | null>(
    null,
  );
  const [selectedMidiRegionId, setSelectedMidiRegionId] = useState<
    string | null
  >(null);
  const pendingMidiRegionCreatesRef = useRef(
    new Map<string, PendingMidiRegionCreation>(),
  );
  const [visibleMidiRegionIds, setVisibleMidiRegionIds] = useState<string[]>(
    [],
  );
  const midiRecordingWasActiveRef = useRef(false);
  const midiRecordingBaselineRef = useRef<Map<string, number>>(new Map());
  const awaitingRecordedMidiRef = useRef(false);

  useEffect(() => subscribeHistoryBoundary(() => {
    // A provisional create/follow-up from before Undo must never recreate
    // notes after the authoritative region has been removed by history.
    pendingMidiRegionCreatesRef.current.clear();
    awaitingRecordedMidiRef.current = false;
  }), []);

  useEffect(() => {
    const pendingCreates = pendingMidiRegionCreatesRef.current;
    for (const [placeholderId, pending] of pendingCreates) {
      const created = state.songs[pending.songIndex]?.midiRegions?.find(
        (region) => region.trackId === pending.trackId,
      );
      if (created) {
        pendingCreates.delete(placeholderId);
        // Edits made before Core returned the durable region ID are collapsed
        // to the latest note set, then applied to that newly-created region.
        if (pending.followupEdit) {
          void builder.midiRegionUpdate({
            songIndex: pending.songIndex,
            regionId: created.id,
            notes: pending.notes,
          });
        }
      } else if (Date.now() - pending.startedAt > 30_000) {
        pendingCreates.delete(placeholderId);
      }
    }
  }, [state.songs]);

  useEffect(() => {
    const focused = state.tracks.find(
      (track) =>
        track.id === state.activeTrackId &&
        (track.kind === "instrument" ||
          track.kind === "midi" ||
          track.kind === "externalMidi"),
    );
    if (!focused) return;

    const regions = state.songs[state.songIndex]?.midiRegions ?? [];
    const firstRegion = regions.find((region) => region.trackId === focused.id);
    setSelectedMidiTrackId(focused.id);
    setSelectedMidiRegionId((current) =>
      current && regions.some(
        (region) => region.id === current && region.trackId === focused.id,
      )
        ? current
        : firstRegion?.id ?? null,
    );
    setVisibleMidiRegionIds((current) => {
      const onFocusedTrack = current.filter((id) =>
        regions.some(
          (region) => region.id === id && region.trackId === focused.id,
        ),
      );
      if (!firstRegion || onFocusedTrack.includes(firstRegion.id))
        return onFocusedTrack;
      return [firstRegion.id, ...onFocusedTrack];
    });
  }, [state.activeTrackId, state.songIndex, state.songs, state.tracks]);

  useEffect(() => {
    const recording = state.recording ?? false;
    const song = state.songs[state.songIndex];
    if (recording && !midiRecordingWasActiveRef.current) {
      midiRecordingBaselineRef.current = new Map(
        (song?.midiRegions ?? []).map((region) => [
          region.id,
          region.notes.length,
        ]),
      );
      awaitingRecordedMidiRef.current = false;
    } else if (!recording && midiRecordingWasActiveRef.current) {
      awaitingRecordedMidiRef.current = true;
    }
    midiRecordingWasActiveRef.current = recording;

    if (!recording && awaitingRecordedMidiRef.current) {
      const added = (song?.midiRegions ?? []).filter(
        (region) =>
          !midiRecordingBaselineRef.current.has(region.id) ||
          midiRecordingBaselineRef.current.get(region.id) !==
            region.notes.length,
      );
      const primary = added[added.length - 1];
      if (primary) {
        setSelectedMidiTrackId(primary.trackId);
        setSelectedMidiRegionId(primary.id);
        setVisibleMidiRegionIds(added.map((region) => region.id));
        awaitingRecordedMidiRef.current = false;
      }
    }
  }, [state.recording, state.songIndex, state.songs]);

  return {
    selectedMidiTrackId,
    setSelectedMidiTrackId,
    selectedMidiRegionId,
    setSelectedMidiRegionId,
    visibleMidiRegionIds,
    setVisibleMidiRegionIds,
    pendingMidiRegionCreatesRef,
  };
}
