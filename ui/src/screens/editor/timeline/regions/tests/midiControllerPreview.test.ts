/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { MidiRegionRow } from "@/lib/state/types";
import {
  buildMidiControllerMarkerBins,
  buildMidiControllerPreview,
  midiControllerLabel,
} from "@/screens/editor/timeline/regions/logic/midiControllerPreview";

function region(overrides: Partial<MidiRegionRow> = {}): MidiRegionRow {
  return {
    id: "region",
    trackId: "track",
    name: "MIDI",
    startBeats: 0,
    durationBeats: 8,
    clipOffsetBeats: 0,
    loop: false,
    loopLengthBeats: 4,
    notes: [],
    ...overrides,
  };
}

describe("MIDI controller region preview", () => {
  it("shows switch-pedal spans per channel and treats any non-zero value as on", () => {
    const preview = buildMidiControllerPreview(region({
      events: [
        { beat: 1, status: 0xb0, data: [64, 1] },
        { beat: 2, status: 0xb2, data: [65, 127] },
        { beat: 3, status: 0xb0, data: [64, 0] },
        { beat: 5, status: 0xb2, data: [65, 0] },
      ],
    }), 8);

    expect(preview.pedals).toEqual([
      { start: 1, end: 3, channel: 0, controller: 64 },
      { start: 2, end: 5, channel: 2, controller: 65 },
    ]);
    expect(midiControllerLabel(64)).toBe("CC 64 · Sustain");
    expect(midiControllerLabel(1)).toBe("CC 1");
  });

  it("carries a pedal held before the visible trim into the region start", () => {
    const preview = buildMidiControllerPreview(region({
      clipOffsetBeats: 5,
      events: [
        { beat: 4, status: 0xb0, data: [64, 127] },
        { beat: 6, status: 0xb0, data: [64, 100] },
        { beat: 7, status: 0xb0, data: [64, 0] },
      ],
    }), 8);

    expect(preview.pedals).toEqual([
      { start: 0, end: 2, channel: 0, controller: 64 },
    ]);
  });

  it("expands pedal events through the trimmed source loop window", () => {
    const preview = buildMidiControllerPreview(region({
      durationBeats: 12,
      clipOffsetBeats: 8,
      loop: true,
      loopLengthBeats: 4,
      loopStartBeats: 8,
      events: [
        { beat: 8, status: 0xb0, data: [64, 127] },
        { beat: 9, status: 0xb0, data: [64, 0] },
        { beat: 2, status: 0xb0, data: [64, 127] },
      ],
    }), 12);

    expect(preview.events.map((event) => event.beat)).toEqual([0, 1, 4, 5, 8, 9]);
    expect(preview.pedals).toEqual([
      { start: 0, end: 1, channel: 0, controller: 64 },
      { start: 4, end: 5, channel: 0, controller: 64 },
      { start: 8, end: 9, channel: 0, controller: 64 },
    ]);
  });

  it("keeps arbitrary CC visible without mislabeling it as a pedal", () => {
    const preview = buildMidiControllerPreview(region({
      events: [
        { beat: 1, status: 0xb0, data: [1, 12] },
        { beat: 1.01, status: 0xb1, data: [74, 99] },
      ],
    }), 8);

    expect(preview.pedals).toEqual([]);
    expect(buildMidiControllerMarkerBins(preview.events, 8, 100)).toEqual([
      {
        beat: 0.96,
        eventCount: 2,
        minValue: 12,
        maxValue: 99,
        controllers: [1, 74],
        channels: [0, 1],
      },
    ]);
  });

  it("caps both loop expansion and horizontal markers", () => {
    const events = Array.from({ length: 6000 }, (_, index) => ({
      beat: (index % 4) / 4,
      status: 0xb0,
      data: [index % 128, index % 128],
    }));
    const preview = buildMidiControllerPreview(region({
      durationBeats: 16,
      loop: true,
      loopLengthBeats: 4,
      loopStartBeats: 0,
      events,
    }), 16);

    expect(preview.events).toHaveLength(10_000);
    expect(preview.truncated).toBe(true);
    expect(preview.pedals).toEqual([]);
    const markerBins = buildMidiControllerMarkerBins(preview.events, 16, 50);
    expect(markerBins.length).toBeGreaterThan(0);
    expect(markerBins.length).toBeLessThanOrEqual(50);
  });

  it("keeps an unmatched pedal-down state held to the visible region end", () => {
    const preview = buildMidiControllerPreview(region({
      events: [{ beat: 2, status: 0xb0, data: [66, 3] }],
    }), 8);

    expect(preview.pedals).toEqual([
      { start: 2, end: 8, channel: 0, controller: 66 },
    ]);
  });
});
