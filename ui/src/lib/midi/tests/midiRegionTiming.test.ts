/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { MidiRegionRow } from "@/lib/state/types";
import {
  midiRegionContainsLoopSourceBeat,
  midiRegionLoopOccurrence,
  midiRegionSourceBeat,
} from "@/lib/midi/midiRegionTiming";

const region: MidiRegionRow = {
  id: "r", trackId: "t", name: "loop", startBeats: 0,
  durationBeats: 24, clipOffsetBeats: 4, loop: true,
  loopLengthBeats: 12, loopStartBeats: 4, notes: [],
};

describe("MIDI region source window", () => {
  it("loops only the trimmed source window while preserving source coordinates", () => {
    expect(midiRegionSourceBeat(region, 0)).toBeCloseTo(4);
    expect(midiRegionSourceBeat(region, 11.5)).toBeCloseTo(15.5);
    expect(midiRegionSourceBeat(region, 12)).toBeCloseTo(4);
    expect(midiRegionContainsLoopSourceBeat(region, 3.99)).toBe(false);
    expect(midiRegionContainsLoopSourceBeat(region, 4)).toBe(true);
    expect(midiRegionContainsLoopSourceBeat(region, 16)).toBe(false);
  });

  it("retains split phase independently of the trimmed source boundary", () => {
    const split = { ...region, clipOffsetBeats: 8 };
    expect(midiRegionSourceBeat(split, 0)).toBeCloseTo(8);
    expect(midiRegionSourceBeat(split, 8)).toBeCloseTo(4);
    expect(midiRegionLoopOccurrence(split, 12)).toBeCloseTo(4);
  });

  it("maps the cropped loop's end straight back to the cropped start", () => {
    const trimmed = {
      ...region,
      clipOffsetBeats: 7,
      loopStartBeats: 7,
      loopLengthBeats: 5,
    };
    expect(midiRegionSourceBeat(trimmed, 0)).toBeCloseTo(7);
    expect(midiRegionSourceBeat(trimmed, 4.99)).toBeCloseTo(11.99);
    expect(midiRegionSourceBeat(trimmed, 5)).toBeCloseTo(7);
    expect(midiRegionContainsLoopSourceBeat(trimmed, 6.99)).toBe(false);
    expect(midiRegionContainsLoopSourceBeat(trimmed, 12)).toBe(false);
  });
});
