/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MidiNoteRow } from "@/lib/state/types";
import {
  applyLegato,
  applyOverlapTrim,
  generateNoteId,
  sliceNote,
} from "@/screens/editor/pianoroll/logic/pianoRollModel";
import { snapPitchToScale } from "@/screens/editor/pianoroll/logic/scales";
import type { ScaleMode } from "@/screens/editor/pianoroll/logic/types";

interface UsePianoRollNoteActionsOptions {
  selectedNoteIds: Set<number>;
  setSelectedNoteIds: Dispatch<SetStateAction<Set<number>>>;
  getEditableNotes: () => MidiNoteRow[];
  commitNotes: (notes: MidiNoteRow[]) => void;
  playheadBeats?: number;
  snap: number;
  snapToScale: boolean;
  rootNote: number;
  scaleMode: ScaleMode;
}

/** Owns note-edit commands shared by the Piano Roll toolbar and shortcuts. */
export function usePianoRollNoteActions({
  selectedNoteIds,
  setSelectedNoteIds,
  getEditableNotes,
  commitNotes,
  playheadBeats,
  snap,
  snapToScale,
  rootNote,
  scaleMode,
}: UsePianoRollNoteActionsOptions) {
  const [noteClipboard, setNoteClipboard] = useState<MidiNoteRow[]>([]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedNoteIds.size === 0) return;
    const remaining = getEditableNotes().filter((note) => !selectedNoteIds.has(note.id));
    commitNotes(remaining);
    setSelectedNoteIds(new Set());
  }, [getEditableNotes, selectedNoteIds, commitNotes, setSelectedNoteIds]);

  const handleCutSelected = useCallback(() => {
    if (selectedNoteIds.size === 0) return;
    const notes = getEditableNotes();
    const copied = notes.filter((note) => selectedNoteIds.has(note.id));
    setNoteClipboard(copied.map((note) => ({ ...note })));
    commitNotes(notes.filter((note) => !selectedNoteIds.has(note.id)));
    setSelectedNoteIds(new Set());
  }, [getEditableNotes, selectedNoteIds, commitNotes, setSelectedNoteIds]);

  const handleCopySelected = useCallback(() => {
    setNoteClipboard(
      getEditableNotes()
        .filter((note) => selectedNoteIds.has(note.id))
        .map((note) => ({ ...note })),
    );
  }, [getEditableNotes, selectedNoteIds]);

  const handlePasteNotes = useCallback(() => {
    if (noteClipboard.length === 0) return;
    const notes = getEditableNotes();
    const sourceStart = Math.min(...noteClipboard.map((note) => note.startBeats));
    const pasteStart = Math.max(0, playheadBeats ?? sourceStart);
    const pasted = noteClipboard.map((note) => ({
      ...note,
      id: generateNoteId(),
      startBeats: pasteStart + note.startBeats - sourceStart,
    }));
    commitNotes([...notes, ...pasted]);
    setSelectedNoteIds(new Set(pasted.map((note) => note.id)));
  }, [noteClipboard, playheadBeats, getEditableNotes, commitNotes, setSelectedNoteIds]);

  const handleSplitAtPlayhead = useCallback(() => {
    const notes = getEditableNotes();
    const beat = Math.max(0, playheadBeats ?? 0);
    const targets = selectedNoteIds.size > 0
      ? notes.filter((note) => selectedNoteIds.has(note.id))
      : notes.filter((note) => beat > note.startBeats && beat < note.startBeats + note.durationBeats);
    if (targets.length === 0) return;
    const targetIds = new Set(targets.map((note) => note.id));
    const updated: MidiNoteRow[] = [];
    const newIds = new Set<number>();
    for (const note of notes) {
      if (!targetIds.has(note.id)) { updated.push(note); continue; }
      const split = sliceNote(note, beat);
      if (!split) { updated.push(note); continue; }
      updated.push(...split);
      newIds.add(split[0].id);
      newIds.add(split[1].id);
    }
    if (updated.length === notes.length) return;
    commitNotes(updated);
    setSelectedNoteIds(newIds);
  }, [playheadBeats, selectedNoteIds, getEditableNotes, commitNotes, setSelectedNoteIds]);

  // Quantize selected notes (or all if none selected)
  const handleQuantize = useCallback(() => {
    if (snap <= 0) return;
    const notes = getEditableNotes();
    const targetIds = selectedNoteIds.size > 0
      ? selectedNoteIds
      : new Set(notes.map((note) => note.id));

    const quantized = notes.map((note) => {
      if (!targetIds.has(note.id)) return note;
      const snappedStart = Math.max(0, Math.round(note.startBeats / snap) * snap);
      const snappedDuration = Math.max(snap, Math.round(note.durationBeats / snap) * snap);
      return { ...note, startBeats: snappedStart, durationBeats: snappedDuration };
    });

    commitNotes(quantized);
  }, [snap, selectedNoteIds, getEditableNotes, commitNotes]);

  // Humanize timing and velocity
  const handleHumanize = useCallback(() => {
    const notes = getEditableNotes();
    const targetIds = selectedNoteIds.size > 0
      ? selectedNoteIds
      : new Set(notes.map((note) => note.id));

    const humanized = notes.map((note) => {
      if (!targetIds.has(note.id)) return note;
      // Timing jitter: +/- 0.02 beats (~10ms @ 120bpm)
      const deltaBeat = (Math.random() - 0.5) * 0.04;
      // Velocity jitter: +/- 0.08
      const deltaVel = (Math.random() - 0.5) * 0.16;
      const newStart = Math.max(0, note.startBeats + deltaBeat);
      const newVel = Math.max(0.1, Math.min(1.0, note.velocity + deltaVel));
      return { ...note, startBeats: newStart, velocity: newVel };
    });

    commitNotes(humanized);
  }, [selectedNoteIds, getEditableNotes, commitNotes]);

  // Transpose selected notes
  const handleTranspose = useCallback((semitones: number) => {
    const notes = getEditableNotes();
    const targetIds = selectedNoteIds.size > 0
      ? selectedNoteIds
      : new Set(notes.map((note) => note.id));

    const transposed = notes.map((note) => {
      if (!targetIds.has(note.id)) return note;
      let newPitch = Math.max(0, Math.min(127, note.pitch + semitones));
      if (snapToScale) newPitch = snapPitchToScale(newPitch, rootNote, scaleMode);
      return { ...note, pitch: newPitch };
    });

    commitNotes(transposed);
  }, [selectedNoteIds, getEditableNotes, snapToScale, rootNote, scaleMode, commitNotes]);

  // Nudge follows the Piano Roll's own snap division (in beats). Like
  // transpose, an empty selection intentionally targets the whole region.
  const handleNudge = useCallback((direction: -1 | 1) => {
    const notes = getEditableNotes();
    const targetIds = selectedNoteIds.size > 0
      ? selectedNoteIds
      : new Set(notes.map((note) => note.id));
    const amount = snap > 0 ? snap : 0.25;
    commitNotes(notes.map((note) => targetIds.has(note.id)
      ? { ...note, startBeats: Math.max(0, note.startBeats + direction * amount) }
      : note));
  }, [selectedNoteIds, getEditableNotes, snap, commitNotes]);

  // Force Legato
  const handleLegato = useCallback(() => {
    const updated = applyLegato(getEditableNotes(), selectedNoteIds);
    commitNotes(updated);
  }, [getEditableNotes, selectedNoteIds, commitNotes]);

  // Overlap Trim
  const handleOverlapTrim = useCallback(() => {
    const updated = applyOverlapTrim(getEditableNotes(), selectedNoteIds);
    commitNotes(updated);
  }, [getEditableNotes, selectedNoteIds, commitNotes]);

  return {
    handleDeleteSelected,
    handleCutSelected,
    handleCopySelected,
    handlePasteNotes,
    handleSplitAtPlayhead,
    handleQuantize,
    handleHumanize,
    handleTranspose,
    handleNudge,
    handleLegato,
    handleOverlapTrim,
  };
}
