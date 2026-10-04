/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MidiRegionRow, MidiUmpEventRow } from "@/lib/state/types";
import {
  clearPianoRollUmpControllerClipboard,
  getPianoRollUmpControllerClipboard,
} from "@/screens/editor/pianoroll/logic/umpControllerClipboard";
import { usePianoRollUmpClipboardActions } from "@/screens/editor/pianoroll/hooks/usePianoRollUmpClipboardActions";

function cc(beat: number, value: number): MidiUmpEventRow {
  return {
    beat,
    wordCount: 2,
    words: [0x40b04a00, value],
  };
}

const region: MidiRegionRow = {
  id: "midi-region:1",
  trackId: "track:1",
  name: "MIDI",
  startBeats: 0,
  durationBeats: 8,
  clipOffsetBeats: 2,
  loop: false,
  loopLengthBeats: 0,
  notes: [],
};

describe("usePianoRollUmpClipboardActions", () => {
  let root: Root;
  let container: HTMLDivElement;
  let result: ReturnType<typeof usePianoRollUmpClipboardActions>;
  let selected: Set<number>;
  let events: MidiUmpEventRow[];
  let commitEvents: ReturnType<typeof vi.fn<(items: MidiUmpEventRow[]) => void>>;

  function Harness({
    enabled = true,
    activeRegion = region,
    playhead = 1.5,
  }: { enabled?: boolean; activeRegion?: MidiRegionRow; playhead?: number }) {
    const [selection, updateSelection] = useState(selected);
    selected = selection;
    result = usePianoRollUmpClipboardActions({
      enabled,
      region: activeRegion,
      events,
      selectedSourceIndices: selection,
      lane: "umpCc74",
      groupFilter: null,
      channelFilter: null,
      playheadBeats: playhead,
      commitEvents,
      setSelectedSourceIndices: updateSelection,
    });
    return null;
  }

  const render = (
    enabled = true,
    activeRegion = region,
    playhead = 1.5,
  ) => act(() => root.render(createElement(Harness, { enabled, activeRegion, playhead })));

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    clearPianoRollUmpControllerClipboard();
    selected = new Set([0, 1]);
    events = [cc(1, 0x1234_5678), cc(3, 0xffff_ffff), { beat: 4, wordCount: 1, words: [0x1000_0000] }];
    commitEvents = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearPianoRollUmpControllerClipboard();
  });

  it("copies selected UMP packets into the screen-independent internal clipboard", () => {
    act(() => result.handleCopy());
    expect(getPianoRollUmpControllerClipboard()?.events).toEqual([
      { offsetBeats: 0, wordCount: 2, words: events[0].words },
      { offsetBeats: 2, wordCount: 2, words: events[1].words },
    ]);
    expect(commitEvents).not.toHaveBeenCalled();
  });

  it("cuts selected packets as one reliable collection edit and clears selection", () => {
    act(() => result.handleCut());
    expect(getPianoRollUmpControllerClipboard()).not.toBeNull();
    expect(commitEvents).toHaveBeenCalledOnce();
    expect(commitEvents).toHaveBeenCalledWith([events[2]]);
    expect(selected.size).toBe(0);
  });

  it("pastes at the playhead after region trim and selects the inserted source indexes", () => {
    act(() => result.handleCopy());
    act(() => result.handlePaste());

    expect(commitEvents).toHaveBeenCalledOnce();
    const pasted = commitEvents.mock.calls[0][0];
    expect(pasted.map((event) => event.beat)).toEqual([1, 3, 4, 3.5, 5.5]);
    expect(pasted[3].words).toEqual(events[0].words);
    expect(pasted[4].words).toEqual(events[1].words);
    expect([...selected]).toEqual([3, 4]);
  });

  it("wraps pasted events through the active region loop window", () => {
    events = [cc(1, 0x1234_5678), cc(1.75, 0xffff_ffff),
      { beat: 4, wordCount: 1, words: [0x1000_0000] }];
    const loopRegion: MidiRegionRow = {
      ...region,
      clipOffsetBeats: 5,
      loop: true,
      loopStartBeats: 4,
      loopLengthBeats: 2,
    };
    render(true, loopRegion, 0.5);
    act(() => result.handleCopy());
    act(() => result.handlePaste());

    const pasted = commitEvents.mock.calls[0][0];
    expect(pasted.slice(3).map((event) => event.beat)).toEqual([5.5, 4.25]);
    expect([...selected]).toEqual([3, 4]);
  });

  it("does not copy, cut, or paste when the UMP lane is read-only", () => {
    render(false);
    act(() => result.handleCopy());
    act(() => result.handleCut());
    act(() => result.handlePaste());

    expect(getPianoRollUmpControllerClipboard()).toBeNull();
    expect(commitEvents).not.toHaveBeenCalled();
  });
});
