/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Button } from "@/components/ui";
import { Music, Plus } from "lucide-react";
import { emptyProjectActions, EmptyProjectState } from "@/screens/editor/project/components/EmptyProjectState";
import { builder, timelineHistory, transport } from "@/lib/state/api";
import { getTrackColor } from "@/lib/theme";
import { songDurationSeconds } from "@/screens/editor/timeline/layout/logic/rows";
import type {
  MidiNoteRow,
  PeaksResponse,
  WebUiState,
} from "@/lib/state/types";
import { MidiRegionSidePanel } from "@/screens/editor/pianoroll/components/MidiRegionSidePanel";
import { PianoRoll } from "@/screens/editor/pianoroll/components/PianoRoll";
import type { PendingMidiRegionCreation } from "@/screens/editor/hooks/useMidiRegionEditorState";

interface PianoRollEditorTabProps {
  state: WebUiState;
  peaks: PeaksResponse | null;
  selectedTrackId: string | null;
  selectedMidiTrackId: string | null;
  setSelectedMidiTrackId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedMidiRegionId: string | null;
  setSelectedMidiRegionId: React.Dispatch<React.SetStateAction<string | null>>;
  visibleMidiRegionIds: string[];
  setVisibleMidiRegionIds: React.Dispatch<React.SetStateAction<string[]>>;
  pendingMidiRegionCreates: Map<string, PendingMidiRegionCreation>;
  onSelectTrack: (trackId: string | null) => void;
}

export function PianoRollEditorTab({
  state,
  peaks,
  selectedTrackId,
  selectedMidiTrackId,
  setSelectedMidiTrackId,
  selectedMidiRegionId,
  setSelectedMidiRegionId,
  visibleMidiRegionIds,
  setVisibleMidiRegionIds,
  pendingMidiRegionCreates,
  onSelectTrack,
}: PianoRollEditorTabProps) {
  const currentSong = state.songs[state.songIndex];
  if (!currentSong) {
    return (
      <EmptyProjectState
        title="No song active"
        description="Select or create a song to edit MIDI notes."
        actions={emptyProjectActions({
          onCreateSong: () => builder.songAdd(),
        })}
      />
    );
  }

  const midiRegions = currentSong.midiRegions || [];

  // Piano Roll is strictly for Software Instrument / MIDI tracks
  const availableTracks = state.tracks.filter(
    (track) =>
      track.kind === "instrument" ||
      track.kind === "midi" ||
      midiRegions.some((region) => region.trackId === track.id),
  );

  if (availableTracks.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-purple-500/20 bg-purple-500/10 text-purple-400">
          <Music size={24} />
        </div>
        <div className="text-sm font-semibold text-foreground/90">
          No Instrument Tracks in Project
        </div>
        <div className="max-w-sm text-xs text-foreground/50">
          Piano Roll is dedicated to editing MIDI notes and melodies for
          Software Instruments. Audio tracks contain recorded audio waveforms
          and cannot be edited in Piano Roll.
        </div>
        <Button
          size="sm"
          variant="outline"
          className="border-purple-500/40 text-purple-300 hover:bg-purple-500/15"
          onPress={() =>
            void builder.trackAdd(state.songIndex, {
              kind: "instrument",
              name: "Classic Electric Piano",
            })
          }
        >
          <Plus size={14} className="mr-1" />
          Create Instrument Track
        </Button>
      </div>
    );
  }

  const activeTrack =
    availableTracks.find((track) => track.id === selectedTrackId) ||
    availableTracks.find((track) => track.id === selectedMidiTrackId) ||
    availableTracks.find((track) => track.id === state.activeTrackId) ||
    availableTracks[0];

  const trackIndex = state.tracks.findIndex(
    (track) => track.id === activeTrack?.id,
  );
  const trackColor = trackIndex >= 0 ? getTrackColor(trackIndex) : "#0485f7";

  const trackRegions = midiRegions.filter(
    (region) => region.trackId === (activeTrack?.id || ""),
  );

  const activeRegion = (selectedMidiRegionId
    ? trackRegions.find((region) => region.id === selectedMidiRegionId)
    : trackRegions[0]) ||
    trackRegions[0] || {
      id: `midi::region:${activeTrack?.id || "default"}:1`,
      trackId: activeTrack?.id || "audio::track:1",
      name: `${activeTrack?.name || "Track"} Pattern`,
      startBeats: 0,
      durationBeats: 16,
      clipOffsetBeats: 0,
      loop: true,
      loopLengthBeats: 16,
      loopStartBeats: 0,
      notes: [],
    };

  const effectiveVisibleRegionIds = visibleMidiRegionIds.includes(activeRegion.id)
    ? visibleMidiRegionIds
    : [activeRegion.id, ...visibleMidiRegionIds];
  const companionRegions = trackRegions.filter(
    (region) =>
      region.id !== activeRegion.id &&
      effectiveVisibleRegionIds.includes(region.id),
  );
  const playheadBeats =
    currentSong.bpm > 0
      ? (state.playheadSeconds * currentSong.bpm) / 60.0
      : 0;

  const handleNotesChange = (updatedNotes: MidiNoteRow[]) => {
    // Keep the lossless MIDI 2.0 shadow values in sync with the
    // editable normalized fields. Otherwise Piano Roll velocity
    // edits would play correctly via MIDI 1.0 but export the stale
    // imported 16-bit value as MIDI 2.0.
    const previousNotes = new Map(
      activeRegion.notes.map((note) => [note.id, note]),
    );
    const notesToSave = updatedNotes.map((note) => {
      const previous = previousNotes.get(note.id);
      if (!note.midi2 || !previous) return note;
      const midi2 = { ...note.midi2 };
      if (note.velocity !== previous.velocity)
        midi2.velocity = Math.max(
          0,
          Math.min(0xffff, Math.round(note.velocity * 0xffff)),
        );
      if (note.releaseVelocity !== previous.releaseVelocity)
        midi2.releaseVelocity = Math.max(
          0,
          Math.min(0xffff, Math.round(note.releaseVelocity * 0xffff)),
        );
      return { ...note, midi2 };
    });
    const exists = midiRegions.some((region) => region.id === activeRegion.id);
    if (!exists) {
      const pending = pendingMidiRegionCreates.get(activeRegion.id);
      if (pending) {
        pending.notes = notesToSave;
        pending.followupEdit = true;
        return;
      }
      // The placeholder ID is UI-only; Core assigns the durable ID.
      // Include the first notes in Add and defer any follow-up edits
      // until telemetry reveals that durable ID.
      pendingMidiRegionCreates.set(activeRegion.id, {
        songIndex: state.songIndex,
        trackId: activeRegion.trackId,
        notes: notesToSave,
        followupEdit: false,
        startedAt: Date.now(),
      });
      void builder.midiRegionAdd({
        songIndex: state.songIndex,
        trackId: activeRegion.trackId,
        name: activeRegion.name,
        startBeats: activeRegion.startBeats,
        durationBeats: activeRegion.durationBeats,
        clipOffsetBeats: activeRegion.clipOffsetBeats,
        loop: activeRegion.loop,
        loopLengthBeats: activeRegion.loopLengthBeats,
        loopStartBeats: activeRegion.loopStartBeats ?? 0,
        muted: Boolean(activeRegion.muted),
        color: activeRegion.color,
        notes: notesToSave,
      });
    } else {
      // If Core's add has reached the UI state but the reconciliation
      // effect has not run yet, discard the queued stale snapshot;
      // this authoritative update already contains the newest edit.
      for (const [placeholderId, pending] of pendingMidiRegionCreates) {
        if (
          pending.songIndex === state.songIndex &&
          pending.trackId === activeRegion.trackId
        )
          pendingMidiRegionCreates.delete(placeholderId);
      }
      void builder.midiRegionUpdate({
        songIndex: state.songIndex,
        regionId: activeRegion.id,
        notes: notesToSave,
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-row gap-1.5 overflow-hidden">
      <PianoRoll
        region={activeRegion}
        companionRegions={companionRegions}
        activeMidiNotes={state.activeMidiNotes}
        track={activeTrack}
        tracks={state.tracks}
        onSelectTrack={(trackId) => {
          setSelectedMidiTrackId(trackId);
          onSelectTrack(trackId);
          const firstRegion = midiRegions.find(
            (region) => region.trackId === trackId,
          );
          setSelectedMidiRegionId(firstRegion ? firstRegion.id : null);
          setVisibleMidiRegionIds(firstRegion ? [firstRegion.id] : []);
        }}
        regions={trackRegions.length > 0 ? trackRegions : [activeRegion]}
        onSelectRegion={(regionId) => {
          setSelectedMidiRegionId(regionId);
          setVisibleMidiRegionIds((current) =>
            current.includes(regionId) ? current : [...current, regionId],
          );
        }}
        selectedRegionIds={effectiveVisibleRegionIds}
        onToggleRegionVisible={(regionId, visible) => {
          setVisibleMidiRegionIds((current) => {
            const withPrimary = current.includes(activeRegion.id)
              ? current
              : [activeRegion.id, ...current];
            if (visible)
              return withPrimary.includes(regionId)
                ? withPrimary
                : [...withPrimary, regionId];
            return withPrimary.filter(
              (id) => id !== regionId || id === activeRegion.id,
            );
          });
        }}
        trackColor={trackColor}
        playheadBeats={playheadBeats - activeRegion.startBeats}
        timeSignatureNumerator={currentSong.tsNum || 4}
        isPlaying={state.playing}
        onSeek={(regionRelativeBeats) => {
          const songBeats = Math.max(
            0,
            regionRelativeBeats + activeRegion.startBeats,
          );
          const bpm = currentSong.bpm > 0 ? currentSong.bpm : 120;
          const seekSec = (songBeats * 60.0) / bpm;
          void transport.seek(seekSec, state.songIndex);
        }}
        onNotesChange={handleNotesChange}
        projectCycle={state.cycle}
        projectSongIndex={state.songIndex}
        projectSong={currentSong}
        projectSongLength={songDurationSeconds(currentSong, peaks?.tracks)}
        canUndo={Boolean(state.canUndo)}
        canRedo={Boolean(state.canRedo)}
        undoLabel={state.undoLabel}
        redoLabel={state.redoLabel}
        onUndo={() => void timelineHistory.undo()}
        onRedo={() => void timelineHistory.redo()}
        onRegionChange={(updated) => {
          if (!midiRegions.some((region) => region.id === updated.id))
            return;
          void builder.midiRegionUpdate({
            songIndex: state.songIndex,
            regionId: updated.id,
            durationBeats: updated.durationBeats,
            loop: updated.loop,
            loopLengthBeats: updated.loopLengthBeats,
            automationLanes: updated.automationLanes,
          });
        }}
      />
      <MidiRegionSidePanel
        songIndex={state.songIndex}
        region={activeRegion}
        track={activeTrack ?? null}
        trackIndex={trackIndex}
        persisted={midiRegions.some((region) => region.id === activeRegion.id)}
      />
    </div>
  );
}
