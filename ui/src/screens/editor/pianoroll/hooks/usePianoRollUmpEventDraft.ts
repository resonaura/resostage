/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiUmpEventRow } from "@/lib/state/types";
import {
  copyPianoRollUmpEvents,
  sameEditablePianoRollUmpEvents,
} from "@/screens/editor/pianoroll/logic/umpControllerEditing";
import {
  usePianoRollReliableCollectionDraft,
} from "@/screens/editor/pianoroll/hooks/usePianoRollReliableCollectionDraft";

/** Keeps exact UMP words until Core publishes their authoritative region echo. */
export function usePianoRollUmpEventDraft({
  regionId,
  resetKey,
  events,
  onEventsChange,
  confirmationTimeoutMs = 8000,
}: {
  regionId: string;
  resetKey?: string;
  events: MidiUmpEventRow[];
  onEventsChange?: (events: MidiUmpEventRow[]) => void | Promise<void>;
  confirmationTimeoutMs?: number;
}) {
  const draft = usePianoRollReliableCollectionDraft({
    regionId,
    resetKey,
    value: events,
    onChange: onEventsChange,
    copy: copyPianoRollUmpEvents,
    equals: sameEditablePianoRollUmpEvents,
    confirmationTimeoutMs,
    unavailableMessage: "MIDI 2.0 event editing is unavailable for this region.",
    confirmationMessage: "Core has not confirmed this MIDI 2.0 edit. It may still be queued; wait before retrying.",
    rejectionMessage: "Core rejected this MIDI 2.0 edit. Your draft is preserved.",
  });

  return {
    editableEvents: draft.editableValue,
    commitEvents: draft.commitValue,
    discardDraft: draft.discardDraft,
    retryDraft: draft.retryDraft,
    error: draft.error,
    status: draft.status,
    canRetry: draft.canRetry,
  };
}
