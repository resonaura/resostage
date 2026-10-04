/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it, vi } from "vitest";
import type { MidiRegionRow, MidiUmpEventRow } from "@/lib/state/types";
import { drawPianoRollBottomLane } from "@/screens/editor/pianoroll/logic/render/bottomLane";
import type { PianoRollBottomLane } from "@/screens/editor/pianoroll/logic/types";

function region(events: NonNullable<MidiRegionRow["events"]>): MidiRegionRow {
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
    events,
  };
}

function context() {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setLineDash: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

const theme = {
  background: "#080808",
  backgroundSecondary: "#101010",
  backgroundTertiary: "#181818",
  surface: "#202020",
  border: "#303030",
  foreground: "#eeeeee",
  muted: "#888888",
  accent: "#0088ff",
  accentForeground: "#ffffff",
};

function draw(
  ctx: CanvasRenderingContext2D,
  midiRegion: MidiRegionRow,
  lane: PianoRollBottomLane,
  selectedControllerEventIndices = new Set<number>(),
  umpGroupFilter: number | null = null,
  umpChannelFilter: number | null = null,
) {
  drawPianoRollBottomLane({
    context: ctx,
    width: 400,
    height: 150,
    gridBottom: 80,
    minBeat: 0,
    maxBeat: 8,
    viewport: {
      pixelsPerBeat: 20,
      pixelsPerPitch: 12,
      scrollBeats: 0,
      scrollPitch: 48,
      keyWidth: 54,
      velocityLaneHeight: 70,
    },
    bottomLane: lane,
    controllerLaneMode: "events",
    umpGroupFilter,
    umpChannelFilter,
    timeVisibleNotes: [],
    selectedNoteIds: new Set(),
    selectedControllerEventIndices,
    localAutomationLanes: [],
    region: midiRegion,
    theme,
    beatToX: (beat) => 54 + beat * 20,
    isControllerLane: () => false,
    controllerYFromValue: (value, gridBottom, height, isPitchBend) => {
      const top = gridBottom + 18;
      const bottom = height - 6;
      const normalized = isPitchBend ? (value + 8192) / 16383 : value / 127;
      return bottom - normalized * (bottom - top);
    },
  });
}

describe("Piano Roll raw controller canvas preview", () => {
  it("draws imported arbitrary CC events as values without turning them into automation", () => {
    const ctx = context();
    draw(ctx, region([{ beat: 2, status: 0xb0, data: [74, 96] }]), "cc74");

    expect(ctx.arc).toHaveBeenCalledOnce();
    expect(ctx.arc).toHaveBeenCalledWith(94, expect.any(Number), 2.5, 0, Math.PI * 2);
  });

  it("draws raw pitch-bend events in the bipolar lane", () => {
    const ctx = context();
    draw(ctx, region([{ beat: 1, status: 0xe0, data: [0, 64] }]), "pitchBend");

    expect(ctx.arc).toHaveBeenCalledOnce();
    expect(ctx.arc).toHaveBeenCalledWith(74, expect.any(Number), 2.5, 0, Math.PI * 2);
  });

  it("draws a distinct outline around selected source events", () => {
    const ctx = context();
    draw(ctx, region([{ beat: 2, status: 0xb0, data: [74, 96] }]), "cc74", new Set([0]));

    expect(ctx.arc).toHaveBeenCalledWith(94, expect.any(Number), 4.25, 0, Math.PI * 2);
    expect(ctx.arc).toHaveBeenCalledWith(94, expect.any(Number), 5.25, 0, Math.PI * 2);
  });

  it("renders only the selected UMP Group and Channel without changing packet data", () => {
    const umpEvent = (beat: number, group: number, channel: number): MidiUmpEventRow => ({
      beat,
      wordCount: 2,
      words: [((0x4 << 28) | (group << 24) | (0x0b << 20)
        | (channel << 16) | (74 << 8)) >>> 0, 0x8000_0000],
    });
    const source = [umpEvent(2, 2, 3), umpEvent(4, 5, 3)];
    const originalWords = source.map((event) => [...event.words]);
    const midiRegion = { ...region([]), umpEvents: source };
    const ctx = context();
    draw(ctx, midiRegion, "umpCc74", new Set(), 2, 3);

    expect(ctx.arc).toHaveBeenCalledOnce();
    expect(ctx.arc).toHaveBeenCalledWith(94, expect.any(Number), 2.5, 0, Math.PI * 2);
    expect(source.map((event) => event.words)).toEqual(originalWords);
  });
});
