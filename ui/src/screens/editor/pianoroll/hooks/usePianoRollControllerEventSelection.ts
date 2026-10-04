/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MidiClipEventRow, MidiNoteRow } from "@/lib/state/types";
import {
  collectControllerEventSourceIndices,
  removeControllerEvents,
} from "@/screens/editor/pianoroll/logic/controllerLane";
import {
  controllerEventTransformAvailability,
  shapeControllerEventSelection,
  smoothControllerEventSelection,
} from "@/screens/editor/pianoroll/logic/controllerEventTransforms";
import type { PianoRollBottomLane, PianoRollControllerLaneMode } from "@/screens/editor/pianoroll/logic/types";

interface UsePianoRollControllerEventSelectionOptions {
  regionId: string;
  resetKey?: string;
  authoritativeEvents: MidiClipEventRow[];
  editableEvents: MidiClipEventRow[];
  bottomLane: PianoRollBottomLane;
  controllerLaneMode: PianoRollControllerLaneMode;
  canEditControllerEvents: boolean;
  commitEvents: (events: MidiClipEventRow[]) => void;
  selectedNoteIds: Set<number>;
  setSelectedNoteIds: Dispatch<SetStateAction<Set<number>>>;
  getEditableNotes: () => MidiNoteRow[];
  deleteSelectedNotes: () => void;
}

function sameEvent(left: MidiClipEventRow | undefined, right: MidiClipEventRow | undefined): boolean {
  return Boolean(left && right && left.beat === right.beat && left.status === right.status
    && left.data.length === right.data.length
    && left.data.every((byte, index) => byte === right.data[index]));
}

/** Owns raw controller-event selection and the lane-aware Delete/Select All commands. */
export function usePianoRollControllerEventSelection({
  regionId,
  resetKey,
  authoritativeEvents,
  editableEvents,
  bottomLane,
  controllerLaneMode,
  canEditControllerEvents,
  commitEvents,
  selectedNoteIds,
  setSelectedNoteIds,
  getEditableNotes,
  deleteSelectedNotes,
}: UsePianoRollControllerEventSelectionOptions) {
  const [selectedControllerEventIndices, setSelectedControllerEventIndices] = useState<Set<number>>(
    new Set(),
  );
  const previousSnapshotRef = useRef({ regionId, resetKey, events: authoritativeEvents });

  useEffect(() => {
    const previous = previousSnapshotRef.current;
    if (previous.regionId !== regionId || previous.resetKey !== resetKey) {
      setSelectedControllerEventIndices(new Set());
    } else if (previous.events !== authoritativeEvents) {
      const selectedEventChanged = [...selectedControllerEventIndices].some((index) =>
        !sameEvent(previous.events[index], authoritativeEvents[index]));
      if (selectedEventChanged) setSelectedControllerEventIndices(new Set());
    }
    previousSnapshotRef.current = { regionId, resetKey, events: authoritativeEvents };
  }, [regionId, resetKey, authoritativeEvents, selectedControllerEventIndices]);

  useEffect(() => {
    if (!canEditControllerEvents || bottomLane === "velocity" || controllerLaneMode !== "events")
      setSelectedControllerEventIndices(new Set());
  }, [canEditControllerEvents, bottomLane, controllerLaneMode]);

  const handleDeleteSelected = useCallback(() => {
    if (canEditControllerEvents && selectedControllerEventIndices.size > 0) {
      const next = removeControllerEvents(
        editableEvents,
        [...selectedControllerEventIndices],
        bottomLane,
      );
      if (next) commitEvents(next);
      setSelectedControllerEventIndices(new Set());
      return;
    }
    deleteSelectedNotes();
  }, [
    canEditControllerEvents,
    selectedControllerEventIndices,
    editableEvents,
    bottomLane,
    commitEvents,
    deleteSelectedNotes,
  ]);

  const handleSelectAll = useCallback(() => {
    if (canEditControllerEvents) {
      const indices = collectControllerEventSourceIndices(editableEvents, bottomLane);
      if (!indices) return;
      setSelectedNoteIds(new Set());
      setSelectedControllerEventIndices(new Set(indices));
      return;
    }
    setSelectedControllerEventIndices(new Set());
    setSelectedNoteIds(new Set(getEditableNotes().map((note) => note.id)));
  }, [
    canEditControllerEvents,
    editableEvents,
    bottomLane,
    getEditableNotes,
    setSelectedNoteIds,
  ]);

  const transformAvailability = useMemo(() => canEditControllerEvents
    ? controllerEventTransformAvailability(
      editableEvents,
      [...selectedControllerEventIndices],
      bottomLane,
    )
    : { curve: false, smooth: false }, [
    canEditControllerEvents,
    editableEvents,
    selectedControllerEventIndices,
    bottomLane,
  ]);

  const handleSetSelectedCurve = useCallback((curve: number) => {
    if (!canEditControllerEvents) return;
    const next = shapeControllerEventSelection(
      editableEvents,
      [...selectedControllerEventIndices],
      bottomLane,
      curve,
    );
    if (next) commitEvents(next);
  }, [canEditControllerEvents, editableEvents, selectedControllerEventIndices, bottomLane, commitEvents]);

  const handleSmoothSelectedEvents = useCallback(() => {
    if (!canEditControllerEvents) return;
    const next = smoothControllerEventSelection(
      editableEvents,
      [...selectedControllerEventIndices],
      bottomLane,
    );
    if (next) commitEvents(next);
  }, [canEditControllerEvents, editableEvents, selectedControllerEventIndices, bottomLane, commitEvents]);

  return {
    selectedControllerEventIndices,
    setSelectedControllerEventIndices,
    handleDeleteSelected,
    handleSelectAll,
    canShapeSelectedControllerEvents: transformAvailability.curve,
    canSmoothSelectedControllerEvents: transformAvailability.smooth,
    handleSetSelectedCurve,
    handleSmoothSelectedEvents,
    hasSelection: selectedControllerEventIndices.size > 0 || selectedNoteIds.size > 0,
  };
}
