/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { MidiRegionRow } from "@/lib/state/types";
import { PIANO_ROLL_LANE_OPTIONS } from "@/screens/editor/pianoroll/toolbar/logic/options";
import { buildPianoRollPedalProjection } from "@/screens/editor/pianoroll/logic/pedalLane";

function region(overrides: Partial<MidiRegionRow> = {}): MidiRegionRow {
  return {
    id: "midi-region",
    trackId: "track-1",
    name: "Pedals",
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

describe("Piano Roll pedal controller lanes", () => {
  it("offers each standard switch-pedal controller", () => {
    expect(PIANO_ROLL_LANE_OPTIONS.map((option) => option.id)).toEqual(
      expect.arrayContaining(["cc64", "cc65", "cc66", "cc67", "cc68", "cc69"]),
    );
  });

  it("projects selected pedal on/off events and ignores other controllers", () => {
    const projection = buildPianoRollPedalProjection(region({
      events: [cc(1, 66, 1), cc(2, 66, 127), cc(3, 66, 0), cc(4, 64, 127)],
    }), 66, 0, 8);

    expect(projection.transitions).toEqual([
      { beat: 1, down: true },
      { beat: 3, down: false },
    ]);
    expect(projection.spans).toEqual([{ startBeat: 1, endBeat: 3 }]);
    expect(projection.truncated).toBe(false);
  });

  it("carries a held pedal through the visible start of a trimmed region", () => {
    const projection = buildPianoRollPedalProjection(region({
      clipOffsetBeats: 4,
      events: [cc(2, 64, 127), cc(6, 64, 0)],
    }), 64, 0, 8);

    expect(projection.transitions).toEqual([
      { beat: -2, down: true },
      { beat: 2, down: false },
    ]);
    expect(projection.spans).toEqual([{ startBeat: -2, endBeat: 2 }]);
  });

  it("projects pedal spans on each visible MIDI-loop pass", () => {
    const projection = buildPianoRollPedalProjection(region({
      loop: true,
      loopLengthBeats: 4,
      events: [cc(1, 65, 127), cc(2, 65, 0)],
    }), 65, 4, 8);

    expect(projection.spans).toEqual([
      { startBeat: 1, endBeat: 2 },
      { startBeat: 5, endBeat: 6 },
    ]);
  });

  it("keeps the displayed pedal active until every overlapping channel releases", () => {
    const projection = buildPianoRollPedalProjection(region({
      events: [
        cc(1, 64, 127, 0),
        cc(2, 64, 127, 1),
        cc(3, 64, 0, 0),
        cc(4, 64, 0, 1),
      ],
    }), 64, 0, 8);

    expect(projection.transitions).toEqual([
      { beat: 1, down: true },
      { beat: 4, down: false },
    ]);
    expect(projection.spans).toEqual([{ startBeat: 1, endBeat: 4 }]);
  });

  it("bounds tiny-loop expansion and marks the view as limited", () => {
    const projection = buildPianoRollPedalProjection(region({
      durationBeats: 10,
      loop: true,
      loopLengthBeats: 0.001,
      events: [cc(0.0002, 69, 1), cc(0.0004, 69, 0)],
    }), 69, 0, 10);

    expect(projection.truncated).toBe(true);
    expect(projection.spans).toHaveLength(1_200);
  });

  it("reports when an imported region exceeds the bounded source scan", () => {
    const events = Array.from({ length: 16_385 }, (_, index) =>
      cc(index / 100, 64, index % 2 === 0 ? 127 : 0));
    const projection = buildPianoRollPedalProjection(region({ events }), 64, 0, 8);

    expect(projection.truncated).toBe(true);
    expect(projection.transitions.length).toBeLessThanOrEqual(16_384);
  });
});
