/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { MidiUmpEventRow } from "@/lib/state/types";
import {
  shapeUmpControllerSelection,
  smoothUmpControllerSelection,
  umpControllerTransformAvailability,
} from "@/screens/editor/pianoroll/logic/umpControllerTransforms";

const MAX_U32 = 0xffff_ffff;
const CURVE_UP_MIDPOINT = Math.round(Math.pow(0.5, 0.25) * MAX_U32);
const CURVE_DOWN_MIDPOINT = Math.round(Math.pow(0.5, 4) * MAX_U32);

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

function pitchBend(
  beat: number,
  value: number,
  group = 0,
  channel = 0,
): MidiUmpEventRow {
  return {
    beat,
    wordCount: 2,
    words: [((0x4 << 28) | (group << 24) | (0x0e << 20) | (channel << 16)) >>> 0,
      value >>> 0],
  };
}

describe("Piano Roll MIDI 2.0 controller transforms", () => {
  it("shapes full-resolution CC data while preserving endpoints and packet identity", () => {
    const first = cc(0, 74, 0, 3, 9, [0xaabb_ccdd]);
    const middle = cc(1, 74, MAX_U32, 3, 9, [0x1234_5678]);
    const last = cc(2, 74, MAX_U32, 3, 9);
    const unselected = cc(3, 74, 0x5555_5555, 3, 9);
    const otherLane = cc(1, 75, 0x7777_7777, 3, 9);
    const opaque = { beat: 1, wordCount: 1, words: [0x1000_0000] };
    const source = [first, middle, last, unselected, otherLane, opaque];

    expect(umpControllerTransformAvailability(source, [0, 1, 2], "umpCc74", 3, 9))
      .toEqual({ curve: true, smooth: true });
    const shaped = shapeUmpControllerSelection(source, [0, 1, 2], "umpCc74", 1, 3, 9);

    expect(shaped).not.toBeNull();
    expect(shaped?.[0]).toBe(first);
    expect(shaped?.[1]).toEqual({ ...middle, words: [middle.words[0], CURVE_UP_MIDPOINT, 0x1234_5678] });
    expect(shaped?.[2]).toBe(last);
    expect(shaped?.[3]).toBe(unselected);
    expect(shaped?.[4]).toBe(otherLane);
    expect(shaped?.[5]).toBe(opaque);
    expect(source[1].words[1]).toBe(MAX_U32);
  });

  it("shapes each UMP group/channel independently without mixing their endpoints", () => {
    const source = [
      cc(0, 1, 0, 0, 0), cc(1, 1, MAX_U32, 0, 0), cc(2, 1, MAX_U32, 0, 0),
      cc(0, 1, MAX_U32, 1, 0), cc(1, 1, 0, 1, 0), cc(2, 1, 0, 1, 0),
      cc(0, 1, 0, 0, 1), cc(1, 1, MAX_U32, 0, 1), cc(2, 1, MAX_U32, 0, 1),
    ];
    const selected = source.map((_event, index) => index);
    const shaped = shapeUmpControllerSelection(source, selected, "umpCc1", 1);

    expect(shaped?.[1].words[1]).toBe(CURVE_UP_MIDPOINT);
    expect(shaped?.[4].words[1]).toBe(MAX_U32 - CURVE_UP_MIDPOINT);
    expect(shaped?.[7].words[1]).toBe(CURVE_UP_MIDPOINT);
    expect(shaped?.[0].words[1]).toBe(0);
    expect(shaped?.[3].words[1]).toBe(MAX_U32);
    expect(shaped?.[6].words[1]).toBe(0);
  });

  it("supports the inverse curve direction without quantizing the UMP range", () => {
    const source = [cc(0, 1, 0), cc(1, 1, MAX_U32), cc(2, 1, MAX_U32)];
    const shaped = shapeUmpControllerSelection(source, [0, 1, 2], "umpCc1", -1);
    expect(shaped?.[1].words[1]).toBe(CURVE_DOWN_MIDPOINT);
    expect(shaped?.[0].words[1]).toBe(0);
    expect(shaped?.[2].words[1]).toBe(MAX_U32);
  });

  it("smooths two time-weighted passes and leaves each channel endpoint fixed", () => {
    const source = [
      cc(0, 11, 0, 2, 0), cc(1, 11, MAX_U32, 2, 0), cc(4, 11, 0, 2, 0),
      cc(8, 11, MAX_U32, 2, 0),
    ];
    const smoothed = smoothUmpControllerSelection(source, [0, 1, 2, 3], "umpCc11");

    expect(smoothed).not.toBeNull();
    expect(smoothed?.[0]).toBe(source[0]);
    expect(smoothed?.[3]).toBe(source[3]);
    expect(smoothed?.[1].words[1]).toBeLessThan(MAX_U32);
    expect(smoothed?.[2].words[1]).toBeGreaterThan(0);
    expect(source[1].words[1]).toBe(MAX_U32);
  });

  it("transforms Pitch Bend across the complete unsigned word without narrowing", () => {
    const source = [
      pitchBend(0, 0),
      pitchBend(1, 0xffff_ffff),
      pitchBend(2, 0xffff_ffff),
    ];
    const shaped = shapeUmpControllerSelection(source, [0, 1, 2], "umpPitchBend", 1);
    expect(shaped?.[1].words[1]).toBe(CURVE_UP_MIDPOINT);
    expect(shaped?.[0].words[1]).toBe(0);
    expect(shaped?.[2].words[1]).toBe(MAX_U32);
  });

  it("keeps binary pedal CCs out of continuous transforms", () => {
    const source = [cc(0, 64, 0), cc(1, 64, MAX_U32), cc(2, 64, MAX_U32)];
    expect(umpControllerTransformAvailability(source, [0, 1, 2], "umpCc64"))
      .toEqual({ curve: false, smooth: false });
    expect(shapeUmpControllerSelection(source, [0, 1, 2], "umpCc64", 0.5)).toBeNull();
    expect(smoothUmpControllerSelection(source, [0, 1, 2], "umpCc64")).toBeNull();
  });

  it("fails closed for stale filters, malformed selection, oversized input and no-op edits", () => {
    const source = [cc(0, 74, 0), cc(1, 74, 0x8000_0000), cc(2, 74, MAX_U32)];
    expect(umpControllerTransformAvailability(source, [0, 1, 2], "umpCc74", 1, 0))
      .toEqual({ curve: false, smooth: false });
    expect(shapeUmpControllerSelection(source, [0, 1, 1], "umpCc74", 1)).toBeNull();
    expect(shapeUmpControllerSelection(source, [0, 1, 2], "umpCc74", 1.1)).toBeNull();
    expect(shapeUmpControllerSelection(source, [0, 1, 2], "umpCc74", 0)).toBeNull();
    expect(shapeUmpControllerSelection(Array(16_385).fill(source[0]), [0, 1, 2], "umpCc74", 1))
      .toBeNull();
    expect(shapeUmpControllerSelection(source, [0, 1, 2], "velocity", 1)).toBeNull();
    const malformed = { ...source[1], words: null as unknown as number[] };
    expect(umpControllerTransformAvailability([source[0], malformed, source[2]], [0, 1, 2], "umpCc74"))
      .toEqual({ curve: false, smooth: false });
  });
});
