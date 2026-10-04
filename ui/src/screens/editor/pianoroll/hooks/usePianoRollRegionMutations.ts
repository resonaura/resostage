/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback } from "react";
import { builder } from "@/lib/state/api";
import type { MidiClipEventRow, MidiNoteRow, MidiRegionRow, WebUiState } from "@/lib/state/types";
import type { PendingMidiRegionCreation } from "@/screens/editor/hooks/useMidiRegionEditorState";

interface PianoRollRegionMutationOptions {
  state: WebUiState;
  activeRegion: MidiRegionRow;
  midiRegions: MidiRegionRow[];
  pendingMidiRegionCreates: Map<string, PendingMidiRegionCreation>;
}

type MidiRegionContentPatch = {
  notes?: MidiNoteRow[];
  events?: MidiClipEventRow[];
};

/** Owns reliable MIDI region content writes shared by note and event editors. */
export function usePianoRollRegionMutations({
  state,
  activeRegion,
  midiRegions,
  pendingMidiRegionCreates,
}: PianoRollRegionMutationOptions) {
  const submitContent = useCallback((patch: MidiRegionContentPatch): Promise<void> => {
    const exists = midiRegions.some((region) => region.id === activeRegion.id);
    if (!exists) {
      const pending = pendingMidiRegionCreates.get(activeRegion.id);
      if (pending) {
        if (patch.notes) pending.notes = patch.notes;
        if (patch.events) pending.events = patch.events;
        pending.followupEdit = true;
        return pending.completion;
      }

      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const completion = new Promise<void>((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      const notes = patch.notes ?? activeRegion.notes;
      const events = patch.events ?? activeRegion.events ?? [];
      pendingMidiRegionCreates.set(activeRegion.id, {
        songIndex: state.songIndex,
        trackId: activeRegion.trackId,
        notes,
        events,
        followupEdit: false,
        startedAt: Date.now(),
        completion,
        resolve,
        reject,
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
        notes,
        events,
      }).catch((error: unknown) => {
        pendingMidiRegionCreates.delete(activeRegion.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      return completion;
    }

    // A create admitted just before the state echo is superseded by this
    // complete region-scoped content update. Settle its waiter only after the
    // newer reliable update completes, preserving the existing editor contract.
    const superseded: PendingMidiRegionCreation[] = [];
    for (const [placeholderId, pending] of pendingMidiRegionCreates) {
      if (pending.songIndex === state.songIndex && pending.trackId === activeRegion.trackId) {
        superseded.push(pending);
        pendingMidiRegionCreates.delete(placeholderId);
      }
    }
    return builder.midiRegionUpdate({
      songIndex: state.songIndex,
      regionId: activeRegion.id,
      ...patch,
    }).then(() => {
      superseded.forEach((pending) => pending.resolve());
    }, (error: unknown) => {
      superseded.forEach((pending) => pending.reject(error instanceof Error ? error : new Error(String(error))));
      throw error;
    });
  }, [activeRegion, midiRegions, pendingMidiRegionCreates, state.songIndex]);

  const handleNotesChange = useCallback((updatedNotes: MidiNoteRow[]): Promise<void> => {
    // Keep the lossless MIDI 2.0 shadow values in sync with the
    // editable normalized fields. Otherwise Piano Roll velocity
    // edits would play correctly via MIDI 1.0 but export the stale
    // imported 16-bit value as MIDI 2.0.
    const previousNotes = new Map(
      activeRegion.notes.map((note) => [note.id, note]),
    );
    const notes = updatedNotes.map((note) => {
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
    return submitContent({ notes });
  }, [activeRegion.notes, submitContent]);

  const handleEventsChange = useCallback((events: MidiClipEventRow[]): Promise<void> =>
    submitContent({ events }), [submitContent]);

  return { handleNotesChange, handleEventsChange };
}
