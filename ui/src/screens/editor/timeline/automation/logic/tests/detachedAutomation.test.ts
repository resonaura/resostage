/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { AutomationLaneRow, PluginParameterList, SongRow, TrackRow } from "@/lib/state/types";
import { getDetachedPluginAutomationLanes } from "@/screens/editor/timeline/automation/logic/automationTargets";

function lane(id: string, slotId: string): AutomationLaneRow {
  return {
    id,
    target: {
      domain: "plugin",
      entityId: slotId,
      parameterId: "id:cutoff",
      valueType: "floatNormalized",
      defaultValue: 0.5,
      minValue: 0,
      maxValue: 1,
    },
    scope: "track",
    writeMode: "read",
    enabled: true,
    points: [{ timeBeats: 0, value: 0.5, curve: 0 }],
  };
}

describe("getDetachedPluginAutomationLanes", () => {
  it("finds missing slots across song, audio-region, and MIDI-region lanes", () => {
    const active = lane("active", "slot:active");
    const songLane = lane("song-orphan", "slot:removed-a");
    const audioLane = lane("audio-orphan", "slot:removed-b");
    const midiLane = lane("midi-orphan", "slot:removed-c");
    const song = {
      automationLanes: [active, songLane],
      regions: [{ id: "region:audio-123", automationLanes: [audioLane] }],
      midiRegions: [{ id: "region:midi-123", name: "Verse keys", automationLanes: [midiLane] }],
    } as unknown as SongRow;
    const tracks = [{ plugins: [{ id: "slot:active" }] }] as unknown as TrackRow[];

    expect(getDetachedPluginAutomationLanes(tracks, song)).toEqual([
      { lane: songLane, location: "Song automation", reason: "slot-missing" },
      { lane: audioLane, location: "Audio region region:a", reason: "slot-missing" },
      { lane: midiLane, location: "MIDI region Verse keys", reason: "slot-missing" },
    ]);
  });

  it("reports conclusively unbound or unavailable parameters but not truncated metadata", () => {
    const oldParameter = lane("old-parameter", "slot:loaded");
    oldParameter.target.parameterId = "id:removed";
    const failedParameter = lane("failed-plugin", "slot:failed");
    const truncatedParameter = lane("truncated-table", "slot:truncated");
    const song = {
      automationLanes: [oldParameter, failedParameter, truncatedParameter],
      regions: [],
      midiRegions: [],
    } as unknown as SongRow;
    const tracks = [{ plugins: [
      { id: "slot:loaded", loadState: "loaded" },
      { id: "slot:failed", loadState: "failed" },
      { id: "slot:truncated", loadState: "loaded" },
    ] }] as unknown as TrackRow[];
    const parameters: Record<string, PluginParameterList> = {
      "slot:loaded": {
        slotId: "slot:loaded", loadState: "loaded", loadError: "", truncated: false,
        parameters: [{ index: 3, parameterId: "id:cutoff", name: "Cutoff", label: "Hz",
          defaultValue: 0.5, currentValue: 0.5, steps: 0, automatable: true }],
      },
      "slot:failed": {
        slotId: "slot:failed", loadState: "failed", loadError: "host failed", truncated: false,
        parameters: [],
      },
      "slot:truncated": {
        slotId: "slot:truncated", loadState: "loaded", loadError: "", truncated: true,
        parameters: [],
      },
    };

    expect(getDetachedPluginAutomationLanes(tracks, song, parameters)).toEqual([
      { lane: oldParameter, location: "Song automation", reason: "parameter-unbound" },
      { lane: failedParameter, location: "Song automation", reason: "plugin-unavailable" },
    ]);
  });

  it("returns no detached lanes without a song", () => {
    expect(getDetachedPluginAutomationLanes([], undefined)).toEqual([]);
  });
});
