/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MidiUmpEventRow } from "@/lib/state/types";
import {
  collectPianoRollUmpControllerSourceIndices,
  decodePianoRollUmpControllerPoint,
  isPianoRollUmpControllerLane,
  MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS,
} from "@/screens/editor/pianoroll/logic/umpControllerLane";
import type { PianoRollBottomLane } from "@/screens/editor/pianoroll/logic/types";

const MAX_CLIPBOARD_WORDS = 65_536;
const MAX_SOURCE_BEAT = 1_000_000;
const UINT32_MAX = 0xffff_ffff;

export interface PianoRollUmpControllerClipboardEvent {
  offsetBeats: number;
  wordCount: number;
  words: number[];
}

/** Internal, format-preserving clipboard for recognized Piano Roll UMP events. */
export interface PianoRollUmpControllerClipboard {
  lane: PianoRollBottomLane;
  spanBeats: number;
  events: PianoRollUmpControllerClipboardEvent[];
}

export interface PianoRollUmpControllerPasteResult {
  events: MidiUmpEventRow[];
  pastedSourceIndices: number[];
}

export interface PianoRollUmpControllerLoopWindow {
  startBeat: number;
  lengthBeats: number;
}

function positiveModulo(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function cloneClipboard(
  clipboard: PianoRollUmpControllerClipboard,
): PianoRollUmpControllerClipboard {
  return {
    lane: clipboard.lane,
    spanBeats: clipboard.spanBeats,
    events: clipboard.events.map((event) => ({ ...event, words: [...event.words] })),
  };
}

/** Copy selected recognized lane points with exact packet words and relative beats. */
export function copyPianoRollUmpControllerSelection(
  source: MidiUmpEventRow[],
  sourceIndices: number[],
  lane: PianoRollBottomLane,
  groupFilter: number | null = null,
  channelFilter: number | null = null,
): PianoRollUmpControllerClipboard | null {
  if (!isPianoRollUmpControllerLane(lane)
      || source.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS
      || sourceIndices.length === 0
      || sourceIndices.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS)
    return null;

  const uniqueIndices = new Set(sourceIndices);
  if (uniqueIndices.size !== sourceIndices.length) return null;
  const visibleIndices = new Set(collectPianoRollUmpControllerSourceIndices(
    source, lane, groupFilter, channelFilter,
  ));
  const selected: Array<{ beat: number; wordCount: number; words: number[] }> = [];
  let wordCount = 0;
  for (const sourceIndex of uniqueIndices) {
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= source.length
        || !visibleIndices.has(sourceIndex)) return null;
    const event = source[sourceIndex];
    const decoded = event && decodePianoRollUmpControllerPoint(event, sourceIndex, lane);
    if (!event || !decoded || (groupFilter !== null && decoded.group !== groupFilter)
        || (channelFilter !== null && decoded.channel !== channelFilter)
        || !Array.isArray(event.words)
        || event.words.some((word) => !Number.isInteger(word) || word < 0 || word > UINT32_MAX))
      return null;
    wordCount += event.words.length;
    if (wordCount > MAX_CLIPBOARD_WORDS) return null;
    selected.push({ beat: event.beat, wordCount: event.wordCount, words: [...event.words] });
  }

  selected.sort((left, right) => left.beat - right.beat);
  const firstBeat = selected[0].beat;
  const lastBeat = selected[selected.length - 1].beat;
  return {
    lane,
    spanBeats: lastBeat - firstBeat,
    events: selected.map((event) => ({
      offsetBeats: event.beat - firstBeat,
      wordCount: event.wordCount,
      words: event.words,
    })),
  };
}

/** Paste exact packets at a source beat, rejecting incompatible or oversized data. */
export function pastePianoRollUmpControllerClipboard(
  source: MidiUmpEventRow[],
  clipboard: PianoRollUmpControllerClipboard | null,
  lane: PianoRollBottomLane,
  sourceBeat: number,
  groupFilter: number | null = null,
  channelFilter: number | null = null,
  loopWindow?: PianoRollUmpControllerLoopWindow,
): PianoRollUmpControllerPasteResult | null {
  if (!clipboard || !isPianoRollUmpControllerLane(lane) || lane !== clipboard.lane
      || source.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS
      || source.length + clipboard.events.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS
      || !Number.isFinite(sourceBeat) || sourceBeat < 0
      || clipboard.events.length === 0 || clipboard.events.length > MAX_PIANO_ROLL_UMP_CONTROLLER_EVENTS
      || !Number.isFinite(clipboard.spanBeats) || clipboard.spanBeats < 0)
    return null;
  if (loopWindow && (!Number.isFinite(loopWindow.startBeat) || loopWindow.startBeat < 0
      || !Number.isFinite(loopWindow.lengthBeats) || loopWindow.lengthBeats <= 0)) return null;
  const pasteSourceBeat = loopWindow
    ? loopWindow.startBeat + positiveModulo(sourceBeat - loopWindow.startBeat, loopWindow.lengthBeats)
    : sourceBeat;

  let wordCount = 0;
  const additions: MidiUmpEventRow[] = [];
  for (const entry of clipboard.events) {
    if (!Number.isFinite(entry.offsetBeats) || entry.offsetBeats < 0
        || entry.offsetBeats > clipboard.spanBeats
        || !Number.isInteger(entry.wordCount) || entry.wordCount !== 2
        || !Array.isArray(entry.words) || entry.words.length < entry.wordCount
        || entry.words.some((word) => !Number.isInteger(word) || word < 0 || word > UINT32_MAX))
      return null;
    wordCount += entry.words.length;
    const beat = loopWindow
      ? loopWindow.startBeat + positiveModulo(
        pasteSourceBeat - loopWindow.startBeat + entry.offsetBeats,
        loopWindow.lengthBeats,
      )
      : pasteSourceBeat + entry.offsetBeats;
    if (wordCount > MAX_CLIPBOARD_WORDS || !Number.isFinite(beat) || beat > MAX_SOURCE_BEAT)
      return null;
    const event = { beat, wordCount: entry.wordCount, words: [...entry.words] };
    const decoded = decodePianoRollUmpControllerPoint(event, -1, lane);
    if (!decoded || (groupFilter !== null && decoded.group !== groupFilter)
        || (channelFilter !== null && decoded.channel !== channelFilter)) return null;
    additions.push(event);
  }

  const pastedSourceIndices = additions.map((_event, index) => source.length + index);
  return { events: [...source, ...additions], pastedSourceIndices };
}

let activeClipboard: PianoRollUmpControllerClipboard | null = null;

export function setPianoRollUmpControllerClipboard(
  clipboard: PianoRollUmpControllerClipboard | null,
): void {
  activeClipboard = clipboard ? cloneClipboard(clipboard) : null;
}

export function getPianoRollUmpControllerClipboard(): PianoRollUmpControllerClipboard | null {
  return activeClipboard ? cloneClipboard(activeClipboard) : null;
}

export function hasPianoRollUmpControllerClipboard(): boolean {
  return activeClipboard !== null && activeClipboard.events.length > 0;
}

export function clearPianoRollUmpControllerClipboard(): void {
  activeClipboard = null;
}
