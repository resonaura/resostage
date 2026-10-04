/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { ImportedMidiFile } from "@/lib/midi/standardMidiFile";

/** Keep a multi-file import within the single-file parser's retained-item budget. */
export const MAX_MIDI_BATCH_CONTENT_ITEMS = 200_000;

/** Count material retained by the import dialog, including normalized note rows. */
export function countMidiContentItems(midi: ImportedMidiFile): number {
  return midi.tracks.reduce((total, track) => total
    + track.notes.length
    + (track.events?.length ?? 0)
    + (track.umpEvents?.length ?? 0), 0);
}

/** Fail before a batch can retain more parsed rows than one bounded MIDI file. */
export function assertMidiBatchContentItemLimit(total: number): void {
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_MIDI_BATCH_CONTENT_ITEMS)
    throw new Error(`The selected MIDI files contain more than ${MAX_MIDI_BATCH_CONTENT_ITEMS.toLocaleString("en-US")} retained items. Import a smaller batch at a time.`);
}
