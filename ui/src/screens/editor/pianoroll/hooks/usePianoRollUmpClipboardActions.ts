/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MidiRegionRow, MidiUmpEventRow } from "@/lib/state/types";
import { midiRegionSourceBeat } from "@/lib/midi/midiRegionTiming";
import {
  copyPianoRollUmpControllerSelection,
  getPianoRollUmpControllerClipboard,
  pastePianoRollUmpControllerClipboard,
  setPianoRollUmpControllerClipboard,
} from "@/screens/editor/pianoroll/logic/umpControllerClipboard";
import { removePianoRollUmpControllerEvents } from "@/screens/editor/pianoroll/logic/umpControllerEditing";
import type { PianoRollBottomLane } from "@/screens/editor/pianoroll/logic/types";

interface UsePianoRollUmpClipboardActionsOptions {
  enabled: boolean;
  region: MidiRegionRow;
  events: MidiUmpEventRow[];
  selectedSourceIndices: Set<number>;
  lane: PianoRollBottomLane;
  groupFilter: number | null;
  channelFilter: number | null;
  playheadBeats?: number;
  commitEvents: (events: MidiUmpEventRow[]) => void;
  setSelectedSourceIndices: Dispatch<SetStateAction<Set<number>>>;
}

/** Copy/cut/paste UMP lane packets through the reliable MIDI-region draft. */
export function usePianoRollUmpClipboardActions({
  enabled,
  region,
  events,
  selectedSourceIndices,
  lane,
  groupFilter,
  channelFilter,
  playheadBeats,
  commitEvents,
  setSelectedSourceIndices,
}: UsePianoRollUmpClipboardActionsOptions) {
  const makeClipboard = useCallback(() => enabled
    ? copyPianoRollUmpControllerSelection(
      events,
      [...selectedSourceIndices],
      lane,
      groupFilter,
      channelFilter,
    )
    : null, [enabled, events, selectedSourceIndices, lane, groupFilter, channelFilter]);

  const handleCopy = useCallback(() => {
    const clipboard = makeClipboard();
    if (clipboard) setPianoRollUmpControllerClipboard(clipboard);
  }, [makeClipboard]);

  const handleCut = useCallback(() => {
    const clipboard = makeClipboard();
    if (!clipboard) return;
    const remaining = removePianoRollUmpControllerEvents(events, [...selectedSourceIndices]);
    if (!remaining) return;
    setPianoRollUmpControllerClipboard(clipboard);
    commitEvents(remaining);
    setSelectedSourceIndices(new Set());
  }, [makeClipboard, events, selectedSourceIndices, commitEvents, setSelectedSourceIndices]);

  const handlePaste = useCallback(() => {
    if (!enabled) return;
    const clipboard = getPianoRollUmpControllerClipboard();
    if (!clipboard) return;
    const displayBeat = Number.isFinite(playheadBeats) ? Math.max(0, playheadBeats ?? 0) : 0;
    const sourceBeat = midiRegionSourceBeat(region, displayBeat);
    const loopWindow = region.loop && region.loopLengthBeats > 0
      ? {
        startBeat: region.loopStartBeats ?? 0,
        lengthBeats: region.loopLengthBeats,
      }
      : undefined;
    const pasted = pastePianoRollUmpControllerClipboard(
      events, clipboard, lane, sourceBeat, groupFilter, channelFilter, loopWindow,
    );
    if (!pasted) return;
    commitEvents(pasted.events);
    setSelectedSourceIndices(new Set(pasted.pastedSourceIndices));
  }, [enabled, region, playheadBeats, events, lane, groupFilter, channelFilter,
    commitEvents, setSelectedSourceIndices]);

  return { handleCopy, handleCut, handlePaste };
}
