/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it, vi } from "vitest";
import type { MidiRegionRow } from "@/lib/state/types";
import {
  buildPianoRollControllerProjection,
  clampControllerDisplayBeat,
  collectPianoRollControllerNumbers,
  createControllerEvent,
  editControllerEvent,
  removeControllerEvent,
  sameEditableMidiEvents,
} from "@/screens/editor/pianoroll/logic/controllerLane";
import { pianoRollLaneOptions } from "@/screens/editor/pianoroll/toolbar/logic/options";

function region(overrides: Partial<MidiRegionRow> = {}): MidiRegionRow {
  return {
    id: "midi-region",
    trackId: "track-1",
    name: "Controller Events",
    startBeats: 0,
    durationBeats: 8,
    clipOffsetBeats: 0,
    loop: false,
    loopLengthBeats: 0,
    notes: [],
    ...overrides,
  };
}

function cc(beat: number, controller: number, value: number, channel = 0) {
  return { beat, status: 0xb0 | channel, data: [controller, value] };
}

function pitchBend(beat: number, value: number, channel = 0) {
  const unsigned = Math.max(0, Math.min(16_383, value + 8192));
  return {
    beat,
    status: 0xe0 | channel,
    data: [unsigned & 0x7f, (unsigned >> 7) & 0x7f],
  };
}

describe("Piano Roll raw MIDI controller lanes", () => {
  it("keeps snapped controller events inside the region's half-open range", () => {
    expect(clampControllerDisplayBeat(8, 8, 0.25)).toBe(7.75);
    expect(clampControllerDisplayBeat(7.8, 8, 0)).toBeLessThan(8);
    expect(clampControllerDisplayBeat(0.2, 0.1, 0.25)).toBe(0);
  });

  it("adds only valid imported controllers to the lane picker", () => {
    const options = pianoRollLaneOptions([74, 74, 1, -1, 128], "cc74");
    const ids = options.map((option) => option.id);
    expect(ids.filter((id) => id === "cc74")).toHaveLength(1);
    expect(ids.filter((id) => id === "cc1")).toHaveLength(1);
    expect(ids).not.toContain("cc-1");
    expect(ids).not.toContain("cc128");
    expect(options.find((option) => option.id === "cc74")?.label).toBe("CC 74");
  });

  it("projects selected CC values in trimmed region-local time and preserves channel", () => {
    const projection = buildPianoRollControllerProjection(region({
      clipOffsetBeats: 4,
      events: [cc(2, 74, 12), cc(5, 74, 98, 3), cc(6, 1, 64)],
    }), "cc74", 0, 8);

    expect(projection.events).toEqual([
      { beat: 1, value: 98, channel: 3, sourceEventIndex: 1 },
    ]);
    expect(projection.truncated).toBe(false);
  });

  it("expands selected CC events through the region's MIDI loop", () => {
    const projection = buildPianoRollControllerProjection(region({
      loop: true,
      loopLengthBeats: 4,
      events: [cc(1, 74, 32), cc(2, 74, 96), cc(3, 1, 5)],
    }), "cc74", 4, 8);

    expect(projection.events).toEqual([
      { beat: 5, value: 32, channel: 0, sourceEventIndex: 0 },
      { beat: 6, value: 96, channel: 0, sourceEventIndex: 1 },
    ]);
  });

  it("projects 14-bit pitch bend with the center at zero", () => {
    const projection = buildPianoRollControllerProjection(region({
      events: [pitchBend(1, -8192, 1), pitchBend(2, 0, 1), pitchBend(3, 8191, 1), cc(4, 74, 100)],
    }), "pitchBend", 0, 8);

    expect(projection.events).toEqual([
      { beat: 1, value: -8192, channel: 1, sourceEventIndex: 0 },
      { beat: 2, value: 0, channel: 1, sourceEventIndex: 1 },
      { beat: 3, value: 8191, channel: 1, sourceEventIndex: 2 },
    ]);
  });

  it("bounds imported-event scans and loop expansion", () => {
    const sourceLimited = buildPianoRollControllerProjection(region({
      events: Array.from({ length: 16_385 }, (_, index) => cc(index / 100, 74, index % 128)),
    }), "cc74", 0, 8);
    expect(sourceLimited.truncated).toBe(true);
    expect(sourceLimited.events.length).toBeLessThanOrEqual(12_000);

    const loopLimited = buildPianoRollControllerProjection(region({
      durationBeats: 10,
      loop: true,
      loopLengthBeats: 0.001,
      events: [cc(0.0002, 74, 1)],
    }), "cc74", 0, 10);
    expect(loopLimited.truncated).toBe(true);
    expect(loopLimited.events).toHaveLength(1_200);
  });

  it("caps the scan without cloning the source event array", () => {
    const events = Array.from({ length: 16_385 }, (_, index) => cc(index / 100, 74, index % 128));
    const copySource = vi.spyOn(events, "slice");
    const projection = buildPianoRollControllerProjection(region({ events }), "cc74", 0, 8);

    expect(projection.truncated).toBe(true);
    expect(copySource).not.toHaveBeenCalled();
  });

  it("collects lane options without cloning the bounded event prefix", () => {
    const events = [cc(0, 74, 1), cc(1, 11, 2), pitchBend(2, 0)];
    const copySource = vi.spyOn(events, "slice");

    expect(collectPianoRollControllerNumbers(events)).toEqual(new Set([74, 11]));
    expect(copySource).not.toHaveBeenCalled();
  });

  it("creates and edits CC events without changing channel or unrelated bytes", () => {
    const original = [
      cc(1, 74, 20, 3),
      { beat: 2, status: 0x91, data: [60, 100] },
    ];
    expect(createControllerEvent("cc74", 1.5, 90, 3)).toEqual(cc(1.5, 74, 90, 3));
    expect(editControllerEvent(original, 0, "cc74", 2.5, 96)).toEqual([
      cc(2.5, 74, 96, 3),
      original[1],
    ]);
    expect(editControllerEvent(original, 1, "cc74", 3, 64)).toBeNull();
  });

  it("encodes pedals as off/on, clamps pitch bend, and deletes only the selected event", () => {
    expect(createControllerEvent("cc64", 1, 63)).toEqual(cc(1, 64, 0));
    expect(createControllerEvent("cc64", 1, 64)).toEqual(cc(1, 64, 127));
    expect(createControllerEvent("pitchBend", 1, 90_000, 2)).toEqual(pitchBend(1, 8191, 2));

    const source = [cc(1, 64, 127), cc(2, 74, 50), pitchBend(3, 0)];
    expect(removeControllerEvent(source, 0, "cc64")).toEqual(source.slice(1));
    expect(removeControllerEvent(source, 1, "cc64")).toBeNull();
  });

  it("compares full event snapshots across Core's stable time sort", () => {
    const left = [cc(2, 74, 80), cc(1, 74, 20)];
    const echoed = [cc(1, 74, 20), cc(2, 74, 80)];
    expect(sameEditableMidiEvents(left, echoed)).toBe(true);
    expect(sameEditableMidiEvents(left, [cc(1, 74, 21), cc(2, 74, 80)])).toBe(false);
    expect(sameEditableMidiEvents([cc(1, 74, 20), cc(1, 74, 20)], [cc(1, 74, 20)])).toBe(false);
  });
});
