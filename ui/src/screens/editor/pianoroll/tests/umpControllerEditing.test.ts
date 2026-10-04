/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { MidiUmpEventRow } from "@/lib/state/types";
import {
  applyPianoRollUmpControllerDraft,
  createPianoRollUmpControllerEvent,
  createPianoRollUmpControllerDraftRow,
  editPianoRollUmpControllerPoints,
  pianoRollUmpValueFromDisplayValue,
  pianoRollUmpValueFromY,
  readPianoRollUmpControllerDraft,
  removePianoRollUmpControllerEvents,
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
      { ...cc(6, 74, 5), configurationHeader: true },
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

  it("keeps MIDI Clip configuration packets opaque to Piano Roll controller editing", () => {
    const setup = { ...cc(0, 74, 0x1234_5678), configurationHeader: true };
    const source = [setup, cc(1, 74, 0x8765_4321)];
    const rows = readPianoRollUmpControllerDraft(source);
    expect(rows.map((row) => row.sourceIndex)).toEqual([1]);
    const edited = applyPianoRollUmpControllerDraft(source, [{ ...rows[0], value: 0xfedc_ba98 }]);
    expect(edited).toEqual([setup, { ...source[1], words: [source[1].words[0], 0xfedc_ba98] }]);
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

  it("maps controller display values to full-resolution MIDI 2.0 values", () => {
    expect(pianoRollUmpValueFromDisplayValue("umpCc74", 0)).toBe(0);
    expect(pianoRollUmpValueFromDisplayValue("umpCc74", 127)).toBe(0xffff_ffff);
    expect(pianoRollUmpValueFromDisplayValue("umpPitchBend", -8192)).toBe(0);
    expect(pianoRollUmpValueFromDisplayValue("umpPitchBend", 0)).toBe(0x8000_0000);
    expect(pianoRollUmpValueFromDisplayValue("umpPitchBend", 8191)).toBeLessThan(0xffff_ffff);
    expect(pianoRollUmpValueFromDisplayValue("umpCc6", 64)).toBeNull();
  });

  it("maps lane coordinates to the complete unsigned UMP range", () => {
    expect(pianoRollUmpValueFromY(28, 10, 100)).toBe(0xffff_ffff);
    expect(pianoRollUmpValueFromY(94, 10, 100)).toBe(0);
    expect(pianoRollUmpValueFromY(61, 10, 100)).toBeGreaterThan(0);
    expect(pianoRollUmpValueFromY(61, 10, 100)).toBeLessThan(0xffff_ffff);
  });

  it("edits only recognized UMP point values and beats", () => {
    const original = cc(1, 74, 0x1234_5678, 3, 9);
    original.words.push(0xaabb_ccdd);
    const opaque = { beat: 2, wordCount: 1, words: [0x1000_0000] };
    const source = [original, opaque];
    const updated = editPianoRollUmpControllerPoints(source, [{
      sourceIndex: 0, beat: 3.25, value: 0xfedc_ba98,
    }]);

    expect(updated).not.toBeNull();
    expect(updated?.[0]).toEqual({
      ...original, beat: 3.25, words: [original.words[0], 0xfedc_ba98, 0xaabb_ccdd],
    });
    expect(updated?.[1]).toBe(opaque);
    expect(original.beat).toBe(1);
    expect(editPianoRollUmpControllerPoints(source, [{
      sourceIndex: 1, beat: 3, value: 1,
    }])).toBeNull();
  });

  it("creates and removes direct UMP points without altering opaque entries", () => {
    const source = [cc(1, 74, 0x1234_5678, 2, 3), { beat: 2, wordCount: 1, words: [0x1000_0000] }];
    const created = createPianoRollUmpControllerEvent(source, "umpCc74", 3.5, 0xffff_ffff, 5, 12);
    expect(created).toEqual([
      ...source,
      { beat: 3.5, words: [((0x4 << 28) | (5 << 24) | (0x0b << 20)
        | (12 << 16) | (74 << 8)) >>> 0, 0xffff_ffff], wordCount: 2 },
    ]);
    expect(createPianoRollUmpControllerEvent(source, "umpCc6", 3, 1, 0, 0)).toBeNull();
    expect(removePianoRollUmpControllerEvents(created!, [0])).toEqual([
      source[1], created![2],
    ]);
    expect(removePianoRollUmpControllerEvents(created!, [1])).toBeNull();
  });

  it("compares full UMP words while tolerating Core event ordering", () => {
    const first = cc(1, 74, 0x1234_5678);
    const second = pitchBend(2, 0x8765_4321);
    expect(sameEditablePianoRollUmpEvents([first, second], [second, first])).toBe(true);
    expect(sameEditablePianoRollUmpEvents([first], [cc(1, 74, 0x1234_5679)])).toBe(false);
    expect(sameEditablePianoRollUmpEvents(
      [{ ...first, presentationOrder: 4 }], [{ ...first, presentationOrder: 5 }],
    )).toBe(false);
    expect(sameEditablePianoRollUmpEvents(
      [{ ...first, configurationHeader: true }], [first],
    )).toBe(false);
    expect(sameEditablePianoRollUmpEvents(
      [first], [{ ...first, configurationHeader: false, profileConfigurationHeader: false }],
    )).toBe(true);
  });
});
