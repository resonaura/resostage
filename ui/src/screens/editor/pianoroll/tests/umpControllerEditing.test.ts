/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { MidiUmpEventRow } from "@/lib/state/types";
import {
  applyPianoRollUmpControllerDraft,
  createPianoRollUmpControllerDraftRow,
  readPianoRollUmpControllerDraft,
  sameEditablePianoRollUmpEvents,
  validatePianoRollUmpControllerDraft,
} from "@/screens/editor/pianoroll/logic/umpControllerEditing";

function cc(
  beat: number,
  controller: number,
  value: number,
  group = 0,
  channel = 0,
): MidiUmpEventRow {
  return {
    beat,
    wordCount: 2,
    words: [((0x4 << 28) | (group << 24) | (0x0b << 20)
      | (channel << 16) | (controller << 8)) >>> 0, value >>> 0],
  };
}

function pitchBend(beat: number, value: number, group = 0, channel = 0): MidiUmpEventRow {
  return {
    beat,
    wordCount: 2,
    words: [((0x4 << 28) | (group << 24) | (0x0e << 20) | (channel << 16)) >>> 0, value >>> 0],
  };
}

describe("Piano Roll MIDI 2.0 controller editing", () => {
  it("lists only supported standard CC and channel Pitch Bend packets", () => {
    const events = [
      cc(1, 74, 0x1234_5678, 3, 9),
      pitchBend(2, 0x8765_4321, 1, 4),
      cc(3, 6, 0x8000_0000),
      { ...cc(4, 11, 3), words: [0x20b00b00, 3] },
      { ...cc(5, 12, 3), words: [0x40b10c01, 3] },
    ];
    const rows = readPianoRollUmpControllerDraft(events);
    expect(rows).toEqual([
      { id: "source-0", sourceIndex: 0, kind: "cc", beat: 1, group: 3, channel: 9, controller: 74, value: 0x1234_5678 },
      { id: "source-1", sourceIndex: 1, kind: "pitchBend", beat: 2, group: 1, channel: 4, controller: 0, value: 0x8765_4321 },
    ]);
  });

  it("edits only semantic fields and preserves opaque packets and trailing words", () => {
    const original = cc(1.25, 74, 0x1234_5678, 2, 3);
    original.words.push(0xaabb_ccdd);
    const reserved = cc(1.5, 6, 0x9988_7766);
    const unknown = { beat: 2, wordCount: 1, words: [0x1000_0000] };
    const source = [original, reserved, unknown];
    const rows = readPianoRollUmpControllerDraft(source);
    rows[0] = { ...rows[0], beat: 3.5 };

    const updated = applyPianoRollUmpControllerDraft(source, rows);
    expect(updated).not.toBeNull();
    expect(updated?.[0]).toEqual({ ...original, beat: 3.5 });
    expect(updated?.[0].words).toEqual(original.words);
    expect(updated?.[1]).toBe(reserved);
    expect(updated?.[2]).toBe(unknown);
  });

  it("changes only selected packet header fields and its 32-bit value word", () => {
    const source = [cc(1, 74, 0x1234_5678, 2, 3)];
    const [row] = readPianoRollUmpControllerDraft(source);
    const updated = applyPianoRollUmpControllerDraft(source, [{
      ...row,
      group: 8,
      channel: 12,
      controller: 75,
      value: 0xfedc_ba98,
    }]);
    const expectedHeader = (((source[0].words[0] & ~0x0f0f_ff00)
      | (8 << 24) | (12 << 16) | (75 << 8)) >>> 0);
    expect(updated).toEqual([{
      ...source[0],
      words: [expectedHeader, 0xfedc_ba98],
    }]);
  });

  it("adds and removes supported events without rewriting the remaining source packets", () => {
    const opaque = { beat: 4, wordCount: 1, words: [0x1000_0000] };
    const source = [cc(1, 1, 123), opaque, pitchBend(2, 0x8000_0000)];
    const rows = readPianoRollUmpControllerDraft(source);
    const newCc = createPianoRollUmpControllerDraftRow("new-1", "cc", 5, { group: 3, channel: 2 });
    newCc.controller = 74;
    newCc.value = 0x0102_0304;
    const updated = applyPianoRollUmpControllerDraft(source, [rows[1], newCc]);

    expect(updated).toEqual([
      opaque,
      source[2],
      {
        beat: 5,
        wordCount: 2,
        words: [((0x4 << 28) | (3 << 24) | (0x0b << 20)
          | (2 << 16) | (74 << 8)) >>> 0, 0x0102_0304],
      },
    ]);
  });

  it("rejects compound CCs, invalid ranges, duplicate sources and oversized collections", () => {
    const source = [cc(1, 74, 10)];
    const row = readPianoRollUmpControllerDraft(source)[0];
    expect(validatePianoRollUmpControllerDraft(source, [{ ...row, controller: 6 }]))
      .toMatch(/compound/);
    expect(validatePianoRollUmpControllerDraft(source, [{ ...row, value: 0x1_0000_0000 }]))
      .toMatch(/32-bit/);
    expect(validatePianoRollUmpControllerDraft(source, [row, row]))
      .toMatch(/changed/);
    expect(applyPianoRollUmpControllerDraft(Array(16_385).fill(source[0]), []))
      .toBeNull();
  });

  it("preserves legacy source beats beyond the editor range unless the beat changes", () => {
    const source = [cc(2_000_000, 74, 10)];
    const [row] = readPianoRollUmpControllerDraft(source);
    expect(applyPianoRollUmpControllerDraft(source, [{ ...row, value: 11 }])?.[0].beat)
      .toBe(2_000_000);
    expect(applyPianoRollUmpControllerDraft(source, [{ ...row, beat: 2_000_001 }]))
      .toBeNull();
  });

  it("compares full UMP words while tolerating Core event ordering", () => {
    const first = cc(1, 74, 0x1234_5678);
    const second = pitchBend(2, 0x8765_4321);
    expect(sameEditablePianoRollUmpEvents([first, second], [second, first])).toBe(true);
    expect(sameEditablePianoRollUmpEvents([first], [cc(1, 74, 0x1234_5679)])).toBe(false);
  });
});
