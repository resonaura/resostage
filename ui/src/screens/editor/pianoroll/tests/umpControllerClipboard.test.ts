/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { MidiUmpEventRow } from "@/lib/state/types";
import {
  clearPianoRollUmpControllerClipboard,
  copyPianoRollUmpControllerSelection,
  getPianoRollUmpControllerClipboard,
  hasPianoRollUmpControllerClipboard,
  pastePianoRollUmpControllerClipboard,
  setPianoRollUmpControllerClipboard,
} from "@/screens/editor/pianoroll/logic/umpControllerClipboard";

const MAX_U32 = 0xffff_ffff;

function cc(
  beat: number,
  controller: number,
  value: number,
  group = 0,
  channel = 0,
  trailingWords: number[] = [],
): MidiUmpEventRow {
  return {
    beat,
    wordCount: 2,
    words: [((0x4 << 28) | (group << 24) | (0x0b << 20)
      | (channel << 16) | (controller << 8)) >>> 0, value >>> 0, ...trailingWords],
  };
}

function pitchBend(beat: number, value: number, group = 0, channel = 0): MidiUmpEventRow {
  return {
    beat,
    wordCount: 2,
    words: [((0x4 << 28) | (group << 24) | (0x0e << 20) | (channel << 16)) >>> 0,
      value >>> 0],
  };
}

afterEach(() => clearPianoRollUmpControllerClipboard());

describe("Piano Roll MIDI 2.0 UMP event clipboard", () => {
  it("copies selected packets with relative beats and exact trailing words", () => {
    const first = cc(2, 74, 0x1234_5678, 3, 9, [0xaabb_ccdd]);
    const opaque: MidiUmpEventRow = { beat: 3, wordCount: 1, words: [0x1000_0000] };
    const last = cc(5, 74, MAX_U32, 3, 9);
    const unselected = cc(8, 74, 0x9876_5432, 3, 9);
    const otherChannel = cc(6, 74, 22, 3, 8);
    const source = [first, opaque, last, unselected, otherChannel];
    const clipboard = copyPianoRollUmpControllerSelection(source, [2, 0], "umpCc74", 3, 9);

    expect(clipboard).toEqual({
      lane: "umpCc74",
      spanBeats: 3,
      events: [
        { offsetBeats: 0, wordCount: 2, words: first.words },
        { offsetBeats: 3, wordCount: 2, words: last.words },
      ],
    });
    expect(clipboard?.events[0].words).not.toBe(first.words);
    expect(source[0]).toBe(first);
  });

  it("rejects stale, duplicate, filtered, reserved and empty selections", () => {
    const source = [cc(1, 74, 1, 2, 3), cc(2, 74, 2, 2, 4), cc(3, 6, 3, 2, 3)];
    expect(copyPianoRollUmpControllerSelection(source, [], "umpCc74")).toBeNull();
    expect(copyPianoRollUmpControllerSelection(source, [0, 0], "umpCc74")).toBeNull();
    expect(copyPianoRollUmpControllerSelection(source, [0, 1], "umpCc74", 2, 3)).toBeNull();
    expect(copyPianoRollUmpControllerSelection(source, [1], "umpCc74", 2, 3)).toBeNull();
    expect(copyPianoRollUmpControllerSelection(source, [2], "umpCc6")).toBeNull();
    expect(copyPianoRollUmpControllerSelection(source, [99], "umpCc74")).toBeNull();
  });

  it("pastes a cloned packet set at the requested beat without changing source data", () => {
    const first = cc(2, 74, 0x1234_5678, 3, 9, [0xaabb_ccdd]);
    const last = cc(5, 74, MAX_U32, 3, 9);
    const clipboard = copyPianoRollUmpControllerSelection([first, last], [0, 1], "umpCc74", 3, 9);
    const opaque: MidiUmpEventRow = { beat: 1, wordCount: 1, words: [0x1000_0000] };
    const source = [opaque];
    const pasted = pastePianoRollUmpControllerClipboard(
      source, clipboard, "umpCc74", 7, 3, 9,
    );

    expect(pasted?.pastedSourceIndices).toEqual([1, 2]);
    expect(pasted?.events).toEqual([
      opaque,
      { ...first, beat: 7, words: [...first.words] },
      { ...last, beat: 10, words: [...last.words] },
    ]);
    expect(pasted?.events[0]).toBe(opaque);
    expect(source).toEqual([opaque]);
  });

  it("keeps MIDI 2.0 Pitch Bend packets in their own lane and retains group/channel", () => {
    const first = pitchBend(4, 0x0000_0001, 5, 7);
    const second = pitchBend(6, 0xffff_fffe, 5, 7);
    const clipboard = copyPianoRollUmpControllerSelection(
      [first, second], [0, 1], "umpPitchBend", 5, 7,
    );
    expect(pastePianoRollUmpControllerClipboard(
      [], clipboard, "umpCc74", 0,
    )).toBeNull();
    expect(pastePianoRollUmpControllerClipboard(
      [], clipboard, "umpPitchBend", 0, 5, 7,
    )?.events).toEqual([
      { ...first, beat: 0, words: [...first.words] },
      { ...second, beat: 2, words: [...second.words] },
    ]);
  });

  it("wraps looped paste offsets into the region's source loop window", () => {
    const first = cc(2, 74, 0x1234_5678, 3, 9);
    const second = cc(2.75, 74, 0x8765_4321, 3, 9);
    const clipboard = copyPianoRollUmpControllerSelection(
      [first, second], [0, 1], "umpCc74", 3, 9,
    );
    const pasted = pastePianoRollUmpControllerClipboard(
      [], clipboard, "umpCc74", 5.5, 3, 9, { startBeat: 4, lengthBeats: 2 },
    );

    expect(pasted?.events.map((event) => event.beat)).toEqual([5.5, 4.25]);
    expect(pasted?.events.map((event) => event.words)).toEqual([first.words, second.words]);
  });

  it("rejects incompatible filters, malformed clipboard words and capacity overflow", () => {
    const source = [cc(1, 74, 1, 2, 3), cc(2, 74, 2, 2, 3)];
    const clipboard = copyPianoRollUmpControllerSelection(source, [0], "umpCc74", 2, 3);
    expect(pastePianoRollUmpControllerClipboard([], clipboard, "umpCc74", 1, 1, 3)).toBeNull();
    expect(pastePianoRollUmpControllerClipboard([], clipboard, "umpCc74", 1, 2, 2)).toBeNull();
    expect(pastePianoRollUmpControllerClipboard([], {
      ...clipboard!, events: [{ ...clipboard!.events[0], words: [0x40b04a00, -1] }],
    }, "umpCc74", 1)).toBeNull();
    expect(pastePianoRollUmpControllerClipboard(
      Array(16_384).fill(source[0]), clipboard, "umpCc74", 1,
    )).toBeNull();
    expect(pastePianoRollUmpControllerClipboard([], clipboard, "umpCc74", 1_000_001)).toBeNull();
    expect(pastePianoRollUmpControllerClipboard(
      [], clipboard, "umpCc74", 1, null, null, { startBeat: 0, lengthBeats: 0 },
    )).toBeNull();
  });

  it("stores a defensive module clipboard that survives screen unmounts", () => {
    const clipboard = copyPianoRollUmpControllerSelection(
      [cc(1, 74, 20)], [0], "umpCc74",
    );
    expect(hasPianoRollUmpControllerClipboard()).toBe(false);
    setPianoRollUmpControllerClipboard(clipboard);
    expect(hasPianoRollUmpControllerClipboard()).toBe(true);
    const read = getPianoRollUmpControllerClipboard();
    if (read) read.events[0].words[1] = 99;
    expect(getPianoRollUmpControllerClipboard()?.events[0].words[1]).toBe(20);
    setPianoRollUmpControllerClipboard(null);
    expect(hasPianoRollUmpControllerClipboard()).toBe(false);
  });
});
