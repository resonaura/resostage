/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it, vi } from "vitest";
import type { MidiRegionRow } from "@/lib/state/types";
import { drawPianoRollBottomLane } from "@/screens/editor/pianoroll/logic/render/bottomLane";

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

function draw(ctx: CanvasRenderingContext2D, midiRegion: MidiRegionRow, lane: "cc74" | "pitchBend") {
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
    timeVisibleNotes: [],
    selectedNoteIds: new Set(),
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
});
