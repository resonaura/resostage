/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MidiNoteRow, MidiRegionRow } from "@/lib/state/types";
import { midiRegionSourceBeat } from "@/lib/midi/midiRegionTiming";
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
  region?: MidiRegionRow;
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
  region,
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
    // Split must work ONLY when exactly ONE note is selected
    if (selectedNoteIds.size !== 1) return;
    if (playheadBeats === undefined || !Number.isFinite(playheadBeats)) return;

    const selectedId = selectedNoteIds.values().next().value;
    const notes = getEditableNotes();
    const note = notes.find((n) => n.id === selectedId);
    if (!note) return;

    const sourceBeat = region ? midiRegionSourceBeat(region, playheadBeats) : playheadBeats;
    const noteEnd = note.startBeats + note.durationBeats;

    let cutBeat: number;
    if (sourceBeat > note.startBeats + 0.03125 && sourceBeat < noteEnd - 0.03125) {
      if (snap > 0) {
        const snapped = Math.round(sourceBeat / snap) * snap;
        cutBeat = (snapped > note.startBeats + 0.03125 && snapped < noteEnd - 0.03125) ? snapped : sourceBeat;
      } else {
        cutBeat = sourceBeat;
      }
    } else {
      // Fallback if playhead is outside note body: split note at midpoint (snapped to grid if active)
      const mid = note.startBeats + note.durationBeats / 2;
      if (snap > 0) {
        const snapped = Math.round(mid / snap) * snap;
        cutBeat = (snapped > note.startBeats + 0.03125 && snapped < noteEnd - 0.03125) ? snapped : mid;
      } else {
        cutBeat = mid;
      }
    }

    const split = sliceNote(note, cutBeat);
    if (!split) return;

    const [noteA, noteB] = split;
    const updated = notes.map((n) => (n.id === note.id ? noteA : n)).concat(noteB);
    commitNotes(updated);
    setSelectedNoteIds(new Set([noteB.id]));
  }, [selectedNoteIds, playheadBeats, region, snap, getEditableNotes, commitNotes, setSelectedNoteIds]);

  // Quantize selected notes (or all if none selected)
  const handleQuantize = useCallback((step?: number) => {
    const effectiveSnap = step ?? (snap > 0 ? snap : 0.25);
    if (!Number.isFinite(effectiveSnap) || effectiveSnap <= 0) return;
    const notes = getEditableNotes();
    const targetIds = selectedNoteIds.size > 0
      ? selectedNoteIds
      : new Set(notes.map((note) => note.id));

    const quantized = notes.map((note) => {
      if (!targetIds.has(note.id)) return note;
      const rawStart = Math.max(0, Math.round(note.startBeats / effectiveSnap) * effectiveSnap);
      const rawDuration = Math.max(effectiveSnap, Math.round(note.durationBeats / effectiveSnap) * effectiveSnap);
      const snappedStart = Math.round(rawStart * 10000) / 10000;
      const snappedDuration = Math.round(rawDuration * 10000) / 10000;
      return { ...note, startBeats: snappedStart, durationBeats: snappedDuration };
    });

    if (quantized.some((note, index) => note.startBeats !== notes[index].startBeats
      || note.durationBeats !== notes[index].durationBeats)) commitNotes(quantized);
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
      const newStart = Math.max(0, Math.round((note.startBeats + deltaBeat) * 10000) / 10000);
      const newVel = Math.max(0.1, Math.min(1.0, Math.round((note.velocity + deltaVel) * 1000) / 1000));
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
      ? { ...note, startBeats: Math.max(0, Math.round((note.startBeats + direction * amount) * 10000) / 10000) }
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
