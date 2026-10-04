/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { ImportedMidiFile } from "@/lib/midi/standardMidiFile";
import { MAX_MIDI_EVENT_PAYLOAD_BYTES, MAX_MIDI_REGION_EVENT_DATA_BYTES } from "@/lib/midi/standardMidiFile";
import type { ImportedMidiTrack } from "@/lib/midi/standardMidiFile";
import { utf8ByteLength } from "@/lib/state/commandQueue";
import type { MidiClipEventRow, MidiNoteRow, MidiUmpEventRow } from "@/lib/state/types";

/** Keep a multi-file import within the single-file parser's retained-item budget. */
export const MAX_MIDI_BATCH_CONTENT_ITEMS = 200_000;
/** Bound project track creation when preserving many files' source tracks. */
export const MAX_MIDI_BATCH_IMPORT_TRACKS = 256;
/** Bound parsed byte-array expansion across the entire selected file batch. */
export const MAX_MIDI_BATCH_EVENT_DATA_BYTES = MAX_MIDI_REGION_EVENT_DATA_BYTES;
/** Keep in sync with core/app/server/CommandBodyLimits.h. */
export const MAX_MIDI_REGION_REQUEST_BYTES = 16 * 1024 * 1024;

export interface MidiRegionImportPatch {
  songIndex: number;
  trackId: string;
  name: string;
  startBeats: number;
  durationBeats: number;
  loop: false;
  loopLengthBeats: number;
  notes: MidiNoteRow[];
  events: MidiClipEventRow[];
  umpEvents: MidiUmpEventRow[];
}

/** Count retained musical and timing rows held while a multi-file batch is prepared. */
export function countMidiContentItems(midi: ImportedMidiFile): number {
  const contentItems = midi.tracks.reduce((total, track) => total
    + track.notes.length
    + (track.events?.length ?? 0)
    + (track.umpEvents?.length ?? 0), 0);
  // Format 2 owns independent timing maps per sequence. Formats 0/1 and MIDI
  // Clip expose their effective maps at file level; counting their per-track
  // mirrors too would count the same retained source events twice.
  const timingItems = midi.format === 2
    ? midi.tracks.reduce((total, track) => total
      + (track.tempoEvents?.length ?? 0)
      + (track.meterEvents?.length ?? 0), 0)
    : midi.tempoEvents.length + midi.meterEvents.length;
  return contentItems + timingItems;
}

/** Count raw MIDI 1.0 event bytes retained by all tracks in one imported file. */
export function countMidiEventDataBytes(midi: ImportedMidiFile): number {
  return midi.tracks.reduce((total, track) => total
    + (track.events ?? []).reduce((trackTotal, event) => trackTotal + event.data.length, 0), 0);
}

/** Keep this collection within the bounds the Core builder can preserve. */
export function assertMidiRegionEventDataLimits(
  tracks: ReadonlyArray<ImportedMidiTrack>,
  sourceName: string,
): void {
  let totalBytes = 0;
  for (const track of tracks) {
    for (const event of track.events ?? []) {
      if (event.data.length > MAX_MIDI_EVENT_PAYLOAD_BYTES)
        throw new Error(`${sourceName}: one MIDI event exceeds the 65,536-byte project limit`);
      if (event.data.length > MAX_MIDI_REGION_EVENT_DATA_BYTES - totalBytes)
        throw new Error(`${sourceName}: MIDI event data exceeds the 8 MiB per-region project limit`);
      totalBytes += event.data.length;
    }
  }
}

/** Fail before parsing can retain more byte arrays than one bounded file. */
export function assertMidiBatchEventDataLimit(total: number): void {
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_MIDI_BATCH_EVENT_DATA_BYTES)
    throw new Error(`The selected MIDI files contain more than ${MAX_MIDI_BATCH_EVENT_DATA_BYTES.toLocaleString("en-US")} raw event bytes. Import a smaller batch at a time.`);
}

/** Assemble and preflight one region before any project mutation is submitted. */
export function buildMidiRegionImportPatch(input: {
  songIndex: number;
  trackId: string;
  name: string;
  sourceName: string;
  startBeats: number;
  durationBeats: number;
  tracks: ReadonlyArray<ImportedMidiTrack>;
}): MidiRegionImportPatch {
  assertMidiRegionEventDataLimits(input.tracks, input.sourceName);

  let noteId = 1;
  const patch: MidiRegionImportPatch = {
    songIndex: input.songIndex,
    trackId: input.trackId,
    name: input.name,
    startBeats: input.startBeats,
    durationBeats: input.durationBeats,
    loop: false,
    loopLengthBeats: input.durationBeats,
    notes: input.tracks.flatMap((track) => track.notes.map((note) => ({ ...note, id: noteId++ }))),
    events: input.tracks.flatMap((track) => track.events ?? []),
    umpEvents: input.tracks.flatMap((track) => track.umpEvents ?? []),
  };
  const serialized = JSON.stringify(patch);
  if (utf8ByteLength(serialized) > MAX_MIDI_REGION_REQUEST_BYTES)
    throw new Error(`${input.sourceName}: converted MIDI region exceeds Core's 16 MiB request limit`);
  return patch;
}

/** Fail before a batch can retain more parsed rows than one bounded MIDI file. */
export function assertMidiBatchContentItemLimit(total: number): void {
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_MIDI_BATCH_CONTENT_ITEMS)
    throw new Error(`The selected MIDI files contain more than ${MAX_MIDI_BATCH_CONTENT_ITEMS.toLocaleString("en-US")} retained items. Import a smaller batch at a time.`);
}

/** Avoid queuing an unreasonable number of structural mutations in one import. */
export function assertMidiBatchImportTrackLimit(total: number): void {
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_MIDI_BATCH_IMPORT_TRACKS)
    throw new Error(`A MIDI import can create at most ${MAX_MIDI_BATCH_IMPORT_TRACKS} tracks. Choose combine mode or import a smaller batch.`);
}
