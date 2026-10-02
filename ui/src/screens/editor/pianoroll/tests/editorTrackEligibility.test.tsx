/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { PianoRollEditorTab } from "@/screens/editor/pianoroll/components/PianoRollEditorTab";
import type { WebUiState } from "@/lib/state/types";

const testState = vi.hoisted(() => ({
  playheadSeconds: 0,
  pianoRollProps: null as null | { playheadBeats: number; onSeek: (beats: number) => void },
  seek: vi.fn(),
}));

vi.mock("@/screens/editor/pianoroll/components/PianoRoll", () => ({
  PianoRoll: (props: { track: { id: string }; region: { trackId: string }; playheadBeats: number; onSeek: (beats: number) => void }) => {
    testState.pianoRollProps = props;
    return createElement("div", { "data-track": props.track.id, "data-region-track": props.region.trackId,
      "data-playhead-beats": props.playheadBeats }, createElement("button", {
        "data-testid": "seek", onClick: () => props.onSeek(2),
      }));
  },
}));
vi.mock("@/screens/editor/pianoroll/components/MidiRegionSidePanel", () => ({ MidiRegionSidePanel: () => null }));
vi.mock("@/lib/state/optimistic", () => ({ useContinuousPlayhead: () => [testState.playheadSeconds, vi.fn(), () => testState.playheadSeconds] }));
vi.mock("@/lib/theme", () => ({ getTrackColor: () => "var(--accent)" }));
vi.mock("@/lib/state/api", () => ({
  builder: { songAdd: vi.fn(), midiRegionAdd: vi.fn(), midiRegionUpdate: vi.fn() },
  timelineHistory: { undo: vi.fn(), redo: vi.fn() },
  transport: { seek: testState.seek },
}));

describe("Piano Roll track eligibility", () => {
  it.each(["instrument", "midi", "externalMidi"])("allows a new %s track with no region to create its first pattern", (kind) => {
    testState.playheadSeconds = 0;
    testState.pianoRollProps = null;
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    const state = { projectName: "Fixture", songIndex: 0, activeTrackId: "track:1", playing: false,
      playheadSeconds: 0, tracks: [{ id: "track:1", name: "MIDI Track", kind }],
      songs: [{ name: "Song", bpm: 120, midiRegions: [], regions: [], events: [], sections: [] }] } as unknown as WebUiState;
    try {
      act(() => root.render(createElement(PianoRollEditorTab, { state, peaks: null, selectedTrackId: "track:1",
        selectedMidiTrackId: null, setSelectedMidiTrackId: vi.fn(), selectedMidiRegionId: null,
        setSelectedMidiRegionId: vi.fn(), visibleMidiRegionIds: [], setVisibleMidiRegionIds: vi.fn(),
        pendingMidiRegionCreates: new Map(), onSelectTrack: vi.fn() })));
      expect(container.querySelector("[data-track='track:1']")).not.toBeNull();
      expect(container.querySelector("[data-region-track='track:1']")).not.toBeNull();
      expect(container.textContent).not.toContain("No Instrument Tracks");
    } finally { act(() => root.unmount()); }
  });

  it("maps Piano Roll playhead and seek through song tempo changes", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    testState.playheadSeconds = 4;
    testState.pianoRollProps = null;
    testState.seek.mockClear();
    const container = document.createElement("div");
    const root = createRoot(container);
    const state = { projectName: "Fixture", songIndex: 0, activeTrackId: "track:1", playing: false,
      playheadSeconds: 4, tracks: [{ id: "track:1", name: "MIDI Track", kind: "instrument" }],
      songs: [{ name: "Song", bpm: 120, tempoPoints: [
        { beat: 0, bpm: 120, timeSeconds: 0, curve: 0 },
        { beat: 4, bpm: 60, timeSeconds: 2, curve: 0 },
      ], midiRegions: [{ id: "region:1", trackId: "track:1", name: "Pattern", startBeats: 2,
        durationBeats: 8, clipOffsetBeats: 0, loop: false, loopLengthBeats: 8, notes: [] }], regions: [], events: [], sections: [] }] } as unknown as WebUiState;
    try {
      act(() => root.render(createElement(PianoRollEditorTab, { state, peaks: null, selectedTrackId: "track:1",
        selectedMidiTrackId: null, setSelectedMidiTrackId: vi.fn(), selectedMidiRegionId: "region:1",
        setSelectedMidiRegionId: vi.fn(), visibleMidiRegionIds: [], setVisibleMidiRegionIds: vi.fn(),
        pendingMidiRegionCreates: new Map(), onSelectTrack: vi.fn() })));
      expect(container.querySelector("[data-playhead-beats='4']")).not.toBeNull();
      act(() => (container.querySelector("[data-testid='seek']") as HTMLButtonElement).click());
      expect(testState.seek).toHaveBeenCalledWith(2, 0);
    } finally { act(() => root.unmount()); }
  });
});
