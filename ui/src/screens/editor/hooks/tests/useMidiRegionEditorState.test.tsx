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
import type { MidiNoteRow, MidiRegionRow, WebUiState } from "@/lib/state/types";
import { useMidiRegionEditorState } from "../useMidiRegionEditorState";

const historyCallbacks = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/state/historyNavigation", () => ({
  subscribeHistoryBoundary: (callback: () => void) => {
    historyCallbacks.add(callback);
    return () => historyCallbacks.delete(callback);
  },
}));

vi.mock("@/lib/state/api", () => ({
  builder: {
    midiRegionUpdate: vi.fn().mockResolvedValue({}),
  },
}));

const makeNote = (id: number, pitch: number, startBeats: number, durationBeats: number, velocity: number): MidiNoteRow => ({
  id,
  pitch,
  startBeats,
  durationBeats,
  velocity,
  releaseVelocity: 0.5,
  probability: 1,
});

const makeRegion = (id: string, trackId: string, notes: MidiNoteRow[]): MidiRegionRow => ({
  id,
  trackId,
  name: "Synth Pattern",
  startBeats: 0,
  durationBeats: 4,
  clipOffsetBeats: 0,
  loop: false,
  loopLengthBeats: 4,
  notes,
});

const mockBaseState: WebUiState = {
  projectName: "Test Project",
  songIndex: 0,
  activeTrackId: "track-inst-1",
  recording: false,
  playing: false,
  tracks: [
    {
      id: "track-inst-1",
      name: "Synth",
      kind: "instrument",
      channels: 2,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      soloGroup: "sources",
      soloActiveInGroup: false,
      output: { type: "main", target: null, sends: [] },
      peakDb: -60,
      plugins: [],
    },
  ],
  songs: [
    {
      id: "song-1",
      name: "Intro",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      durationSeconds: 60,
      midiRegions: [],
    },
  ],
  buses: [],
  hardwareOutputs: [],
  audioDrivers: [],
  deviceOutputChannels: [],
  currentDeviceType: "CoreAudio",
  outputDevice: "",
  activeMidiNotes: [],
  lightScenes: [],
  lightFixtures: [],
  patchLibrary: [],
  pluginLoading: {
    epoch: 1,
    generation: 0,
    phase: "idle",
    blocksPlayback: false,
    showDialog: false,
    playRequested: false,
    total: 0,
    completed: 0,
    failed: 0,
    currentName: "",
    error: "",
  },
} as unknown as WebUiState;

describe("useMidiRegionEditorState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let hookResult: ReturnType<typeof useMidiRegionEditorState>;

  function Harness({ state }: { state: WebUiState }) {
    hookResult = useMidiRegionEditorState(state);
    return null;
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    historyCallbacks.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("reconciles provisional creation when durable region appears in Core state", async () => {
    act(() => {
      root.render(createElement(Harness, { state: mockBaseState }));
    });

    let resolved = false;
    let resolveFn!: () => void;
    let rejectFn!: (err: Error) => void;
    const completion = new Promise<void>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    }).then(() => {
      resolved = true;
    });

    hookResult.pendingMidiRegionCreatesRef.current.set("temp-placeholder", {
      songIndex: 0,
      trackId: "track-inst-1",
      notes: [makeNote(1, 60, 0, 1, 0.8)],
      followupEdit: false,
      startedAt: Date.now(),
      completion,
      resolve: resolveFn,
      reject: rejectFn,
    });

    expect(hookResult.pendingMidiRegionCreatesRef.current.has("temp-placeholder")).toBe(true);

    const updatedState: WebUiState = {
      ...mockBaseState,
      songs: [
        {
          ...mockBaseState.songs[0],
          midiRegions: [makeRegion("durable-region-1", "track-inst-1", [makeNote(1, 60, 0, 1, 0.8)])],
        },
      ],
    };

    act(() => {
      root.render(createElement(Harness, { state: updatedState }));
    });

    await act(async () => {
      await completion;
    });

    expect(resolved).toBe(true);
    expect(hookResult.pendingMidiRegionCreatesRef.current.has("temp-placeholder")).toBe(false);
  });

  it("applies follow-up edits using durable ID when Core completes creation", async () => {
    act(() => {
      root.render(createElement(Harness, { state: mockBaseState }));
    });

    let resolveFn!: () => void;
    let rejectFn!: (err: Error) => void;
    const completion = new Promise<void>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    const followupNotes = [
      makeNote(1, 60, 0, 1, 0.8),
      makeNote(2, 64, 1, 1, 0.9),
    ];

    hookResult.pendingMidiRegionCreatesRef.current.set("temp-placeholder", {
      songIndex: 0,
      trackId: "track-inst-1",
      notes: followupNotes,
      followupEdit: true,
      startedAt: Date.now(),
      completion,
      resolve: resolveFn,
      reject: rejectFn,
    });

    const updatedState: WebUiState = {
      ...mockBaseState,
      songs: [
        {
          ...mockBaseState.songs[0],
          midiRegions: [makeRegion("durable-region-1", "track-inst-1", [makeNote(1, 60, 0, 1, 0.8)])],
        },
      ],
    };

    await act(async () => {
      root.render(createElement(Harness, { state: updatedState }));
    });

    expect(builder.midiRegionUpdate).toHaveBeenCalledWith({
      songIndex: 0,
      regionId: "durable-region-1",
      notes: followupNotes,
    });
  });

  it("cancels and rejects pending creations upon history navigation (Undo/Redo)", async () => {
    act(() => {
      root.render(createElement(Harness, { state: mockBaseState }));
    });

    const capture = { error: null as Error | null };
    let resolveFn!: () => void;
    let rejectFn!: (err: Error) => void;
    const completion = new Promise<void>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    }).catch((err: unknown) => {
      capture.error = err instanceof Error ? err : new Error(String(err));
    });

    hookResult.pendingMidiRegionCreatesRef.current.set("temp-placeholder", {
      songIndex: 0,
      trackId: "track-inst-1",
      notes: [],
      followupEdit: false,
      startedAt: Date.now(),
      completion,
      resolve: resolveFn,
      reject: rejectFn,
    });

    act(() => {
      historyCallbacks.forEach((cb) => cb());
    });

    await act(async () => {
      await completion;
    });

    expect(capture.error).not.toBeNull();
    expect(capture.error?.message).toContain("cancelled by history navigation");
    expect(hookResult.pendingMidiRegionCreatesRef.current.size).toBe(0);
  });

  it("cancels and rejects pending creations and clears selection upon project change", async () => {
    act(() => {
      root.render(createElement(Harness, { state: mockBaseState }));
    });

    const capture = { error: null as Error | null };
    let resolveFn!: () => void;
    let rejectFn!: (err: Error) => void;
    const completion = new Promise<void>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    }).catch((err: unknown) => {
      capture.error = err instanceof Error ? err : new Error(String(err));
    });

    hookResult.pendingMidiRegionCreatesRef.current.set("temp-placeholder", {
      songIndex: 0,
      trackId: "track-inst-1",
      notes: [],
      followupEdit: false,
      startedAt: Date.now(),
      completion,
      resolve: resolveFn,
      reject: rejectFn,
    });

    // Simulate opening a different project
    const newProjectState: WebUiState = {
      ...mockBaseState,
      projectName: "Other Album Project",
      pluginLoading: {
        epoch: 2,
        generation: 0,
        phase: "idle",
        blocksPlayback: false,
        showDialog: false,
        playRequested: false,
        total: 0,
        completed: 0,
        failed: 0,
        currentName: "",
        error: "",
      },
    };

    act(() => {
      root.render(createElement(Harness, { state: newProjectState }));
    });

    await act(async () => {
      await completion;
    });

    expect(capture.error).not.toBeNull();
    expect(capture.error?.message).toContain("cancelled by project change");
    expect(hookResult.pendingMidiRegionCreatesRef.current.size).toBe(0);
  });
});
