/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Dispatch, SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MidiClipEventRow, MidiNoteRow } from "@/lib/state/types";
import { usePianoRollControllerEventSelection } from "@/screens/editor/pianoroll/hooks/usePianoRollControllerEventSelection";
import type { PianoRollBottomLane, PianoRollControllerLaneMode } from "@/screens/editor/pianoroll/logic/types";

const notes: MidiNoteRow[] = [
  { id: 1, pitch: 60, startBeats: 0, durationBeats: 1, velocity: 0.8, releaseVelocity: 0.5, probability: 1 },
  { id: 2, pitch: 64, startBeats: 1, durationBeats: 1, velocity: 0.8, releaseVelocity: 0.5, probability: 1 },
];
const events: MidiClipEventRow[] = [
  { beat: 1, status: 0xb0, data: [74, 20] },
  { beat: 2, status: 0xb0, data: [11, 30] },
  { beat: 3, status: 0xb2, data: [74, 40] },
];

describe("usePianoRollControllerEventSelection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let result: ReturnType<typeof usePianoRollControllerEventSelection>;
  let selectedNoteIds: Set<number>;
  let setSelectedNoteIds: Dispatch<SetStateAction<Set<number>>>;
  let commitEvents: ReturnType<typeof vi.fn<(items: MidiClipEventRow[]) => void>>;
  let deleteSelectedNotes: ReturnType<typeof vi.fn<() => void>>;

  function Harness({
    regionId = "region-a",
    authoritativeEvents = events,
    lane = "cc74",
    mode = "events",
    canEditControllerEvents = true,
  }: {
    regionId?: string;
    authoritativeEvents?: MidiClipEventRow[];
    lane?: PianoRollBottomLane;
    mode?: PianoRollControllerLaneMode;
    canEditControllerEvents?: boolean;
  }) {
    result = usePianoRollControllerEventSelection({
      regionId,
      resetKey: "project-epoch-a",
      authoritativeEvents,
      editableEvents: authoritativeEvents,
      bottomLane: lane,
      controllerLaneMode: mode,
      canEditControllerEvents,
      commitEvents,
      selectedNoteIds,
      setSelectedNoteIds,
      getEditableNotes: () => notes,
      deleteSelectedNotes,
    });
    return null;
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    selectedNoteIds = new Set([1]);
    setSelectedNoteIds = vi.fn((update: Set<number> | ((previous: Set<number>) => Set<number>)) => {
      selectedNoteIds = typeof update === "function" ? update(selectedNoteIds) : update;
    }) as unknown as Dispatch<SetStateAction<Set<number>>>;
    commitEvents = vi.fn();
    deleteSelectedNotes = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(Harness, {})));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("deletes only selected events from the active lane through the commit callback", () => {
    act(() => result.setSelectedControllerEventIndices(new Set([0, 2])));
    act(() => result.handleDeleteSelected());

    expect(commitEvents).toHaveBeenCalledOnce();
    expect(commitEvents).toHaveBeenCalledWith([events[1]]);
    expect(deleteSelectedNotes).not.toHaveBeenCalled();
    expect(result.selectedControllerEventIndices.size).toBe(0);
  });

  it("selects all events in the active lane and clears note selection", () => {
    act(() => result.handleSelectAll());

    expect([...result.selectedControllerEventIndices]).toEqual([0, 2]);
    expect(setSelectedNoteIds).toHaveBeenCalledWith(new Set());
  });

  it("selects notes instead when controller editing is not active", () => {
    act(() => root.render(createElement(Harness, { mode: "automation", canEditControllerEvents: false })));
    act(() => result.handleSelectAll());

    expect([...result.selectedControllerEventIndices]).toEqual([]);
    expect(setSelectedNoteIds).toHaveBeenLastCalledWith(new Set([1, 2]));
  });

  it("drops event selection when the active lane becomes read-only", () => {
    act(() => result.setSelectedControllerEventIndices(new Set([0])));
    act(() => root.render(createElement(Harness, { canEditControllerEvents: false })));

    expect(result.selectedControllerEventIndices.size).toBe(0);
    act(() => result.handleDeleteSelected());
    expect(commitEvents).not.toHaveBeenCalled();
    expect(deleteSelectedNotes).toHaveBeenCalledOnce();
  });

  it("clears selection across region identity and selected authoritative-event changes", () => {
    act(() => result.setSelectedControllerEventIndices(new Set([0])));
    act(() => root.render(createElement(Harness, { regionId: "region-b" })));
    expect(result.selectedControllerEventIndices.size).toBe(0);

    act(() => result.setSelectedControllerEventIndices(new Set([2])));
    const changedUnselectedEvent = events.map((event, index) =>
      index === 0 ? { ...event, data: [74, 99] } : event);
    act(() => root.render(createElement(Harness, {
      regionId: "region-b", authoritativeEvents: changedUnselectedEvent,
    })));
    expect([...result.selectedControllerEventIndices]).toEqual([2]);

    const changedSelectedEvent = changedUnselectedEvent.map((event, index) =>
      index === 2 ? { ...event, data: [74, 41] } : event);
    act(() => root.render(createElement(Harness, {
      regionId: "region-b", authoritativeEvents: changedSelectedEvent,
    })));
    expect(result.selectedControllerEventIndices.size).toBe(0);
  });
});
