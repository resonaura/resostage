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

vi.mock("@/screens/editor/pianoroll/components/PianoRoll", () => ({
  PianoRoll: ({ track, region }: { track: { id: string }; region: { trackId: string } }) =>
    createElement("div", { "data-track": track.id, "data-region-track": region.trackId }),
}));
vi.mock("@/screens/editor/pianoroll/components/MidiRegionSidePanel", () => ({ MidiRegionSidePanel: () => null }));
vi.mock("@/lib/state/optimistic", () => ({ useContinuousPlayhead: () => [0, vi.fn(), () => 0] }));
vi.mock("@/lib/theme", () => ({ getTrackColor: () => "var(--accent)" }));

describe("Piano Roll track eligibility", () => {
  it.each(["instrument", "midi", "externalMidi"])("allows a new %s track with no region to create its first pattern", (kind) => {
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
});
