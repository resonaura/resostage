/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builder } from "@/lib/state/api";
import type { MidiClipEventRow, MidiNoteRow, MidiRegionRow, MidiUmpEventRow, WebUiState } from "@/lib/state/types";
import { usePianoRollRegionMutations } from "@/screens/editor/pianoroll/hooks/usePianoRollRegionMutations";
import type { PendingMidiRegionCreation } from "@/screens/editor/hooks/useMidiRegionEditorState";

vi.mock("@/lib/state/api", () => ({
  builder: {
    midiRegionAdd: vi.fn().mockResolvedValue(undefined),
    midiRegionUpdate: vi.fn().mockResolvedValue(undefined),
  },
}));

function makeRegion(id: string, notes: MidiNoteRow[] = []): MidiRegionRow {
  return {
    id,
    trackId: "track-1",
    name: "MIDI",
    startBeats: 0,
    durationBeats: 8,
    clipOffsetBeats: 0,
    loop: false,
    loopLengthBeats: 0,
    notes,
  };
}

describe("Piano Roll region content mutations", () => {
  let root: Root;
  let container: HTMLDivElement;
  let result: ReturnType<typeof usePianoRollRegionMutations>;
  let activeRegion: MidiRegionRow;
  let midiRegions: MidiRegionRow[];
  let pending: Map<string, PendingMidiRegionCreation>;

  function Harness() {
    result = usePianoRollRegionMutations({
      state: { songIndex: 0 } as WebUiState,
      activeRegion,
      midiRegions,
      pendingMidiRegionCreates: pending,
    });
    return null;
  }
  const render = () => act(() => root.render(createElement(Harness)));

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    activeRegion = makeRegion("saved-region");
    midiRegions = [activeRegion];
    pending = new Map();
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("writes raw event edits through the region-history update route", async () => {
    const events: MidiClipEventRow[] = [{ beat: 2, status: 0xb0, data: [64, 127] }];
    await act(async () => result.handleEventsChange(events));
    expect(builder.midiRegionUpdate).toHaveBeenCalledWith({
      songIndex: 0,
      regionId: "saved-region",
      events,
    });
    expect(builder.midiRegionAdd).not.toHaveBeenCalled();
  });

  it("writes UMP edits through the same exact region-history update route", async () => {
    const umpEvents: MidiUmpEventRow[] = [{ beat: 2, wordCount: 2, words: [0x40b04a00, 0x1234_5678] }];
    await act(async () => result.handleUmpEventsChange(umpEvents));
    expect(builder.midiRegionUpdate).toHaveBeenCalledWith({
      songIndex: 0,
      regionId: "saved-region",
      umpEvents,
    });
    expect(builder.midiRegionAdd).not.toHaveBeenCalled();
  });

  it("creates a provisional region with event data and folds pending edits into its follow-up", () => {
    const note: MidiNoteRow = {
      id: 1,
      pitch: 60,
      startBeats: 0,
      durationBeats: 1,
      velocity: 0.5,
      releaseVelocity: 0.5,
      probability: 1,
      midi2: {
        group: 0,
        velocity: 32_768,
        releaseVelocity: 32_768,
        attributeType: 0,
        attributeData: 0,
      },
    };
    activeRegion = makeRegion("provisional-region", [note]);
    midiRegions = [];
    render();

    const events: MidiClipEventRow[] = [{ beat: 1.25, status: 0xb0, data: [64, 127] }];
    const umpEvents: MidiUmpEventRow[] = [{ beat: 2.5, wordCount: 2, words: [0x40b04a00, 0x8765_4321] }];
    let completion!: Promise<void>;
    act(() => { completion = result.handleEventsChange(events); });
    const create = pending.get("provisional-region");
    expect(create?.completion).toBe(completion);
    expect(create?.notes).toEqual([note]);
    expect(create?.events).toEqual(events);
    expect(create?.umpEvents).toEqual([]);
    expect(builder.midiRegionAdd).toHaveBeenCalledWith(expect.objectContaining({
      notes: [note],
      events,
      umpEvents: [],
    }));

    const updatedNote = { ...note, velocity: 0.75 };
    let followup!: Promise<void>;
    act(() => { followup = result.handleNotesChange([updatedNote]); });
    expect(followup).toBe(completion);
    expect(create?.followupEdit).toBe(true);
    expect(create?.events).toEqual(events);
    expect(create?.notes[0].midi2?.velocity).toBe(49_151);

    let umpFollowup!: Promise<void>;
    act(() => { umpFollowup = result.handleUmpEventsChange(umpEvents); });
    expect(umpFollowup).toBe(completion);
    expect(create?.umpEvents).toEqual(umpEvents);
  });
});
