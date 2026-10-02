/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  formatAutomationValue,
  getTrackAutomationTargets,
  matchesAutomationTarget,
  getAutomationLanesForTrack,
} from "@/screens/editor/timeline/automation/logic/automationTargets";
import type { AutomationLaneRow, PluginParameterList, TrackRow } from "@/lib/state/types";

describe("automationTargets", () => {
  const baseTrack: TrackRow = {
    id: "track:1",
    name: "Lead Synth",
    channels: 2,
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    soloGroup: "sources",
    soloActiveInGroup: false,
    peakDb: -100,
    output: {
      type: "main",
      sends: [{ bus: "audio::send:1", level: 100, enabled: true, preFader: false, tap: "post-pan" }],
    },
    kind: "instrument",
    plugins: [
      {
        id: "slot:1",
        pluginId: "vst3.serum",
        format: "vst3",
        name: "Serum",
        manufacturer: "Xfer",
        instrument: true,
        bypassed: false,
        hasState: true,
        loadState: "loaded",
      },
    ],
  };

  it("extracts strip, sends, plugins, and MIDI CC groups", () => {
    const groups = getTrackAutomationTargets(baseTrack, [
      {
        id: "audio::send:1",
        name: "Reverb",
        channels: 2,
        gainDb: 0,
        mute: false,
        solo: false,
        soloGroup: "sends",
        soloActiveInGroup: false,
        isAux: true,
        startChannel: 0,
        peakDb: -100,
      },
    ]);

    expect(groups.length).toBe(4);
    expect(groups.map((g) => g.category)).toEqual(["strip", "send", "plugin", "midi"]);

    // Strip group contains Gain, Pan, Mute
    const stripGroup = groups.find((g) => g.category === "strip")!;
    expect(stripGroup.targets.map((t) => t.parameterId)).toEqual([
      "faderGainDb",
      "pan",
      "mute",
    ]);
    expect(stripGroup.targets[0].disabledReason).toBeUndefined();
    expect(stripGroup.targets[1].disabledReason).toBeUndefined();
    expect(stripGroup.targets[2].disabledReason).toContain("Mute automation playback is not available yet");

    // Send group points to Reverb
    const sendGroup = groups.find((g) => g.category === "send")!;
    expect(sendGroup.targets[0].label).toContain("Reverb");

    // Plugin group has slot
    const pluginGroup = groups.find((g) => g.category === "plugin")!;
    expect(pluginGroup.targets[0].label).toContain("Serum");

    // MIDI group contains Pitch Bend, CC1, etc.
    const midiGroup = groups.find((g) => g.category === "midi")!;
    expect(midiGroup.targets.some((t) => t.parameterId === "pitchBend")).toBe(true);
    expect(midiGroup.targets.some((t) => t.parameterId === "cc:1")).toBe(true);
  });

  it("marks unloaded plugins as disabled with reason", () => {
    const offlineTrack: TrackRow = {
      ...baseTrack,
      plugins: [
        {
          id: "slot:2",
          pluginId: "vst3.crashing",
          format: "vst3",
          name: "CrashPlugin",
          manufacturer: "Crash",
          instrument: false,
          loadState: "failed",
          bypassed: false,
          hasState: false,
        },
      ],
    };

    const groups = getTrackAutomationTargets(offlineTrack);
    const pluginGroup = groups.find((g) => g.category === "plugin")!;
    expect(pluginGroup.targets[0].disabledReason).toContain("failed");
  });

  it("retains existing lane parameters for active plug-in slots", () => {
    const groups = getTrackAutomationTargets(baseTrack, undefined, [
      {
        id: "lane:serum:filter",
        target: {
          domain: "plugin",
          entityId: "slot:1",
          parameterId: "param:2",
          valueType: "floatNormalized",
          defaultValue: 0.5,
          minValue: 0,
          maxValue: 1,
        },
        scope: "track",
        writeMode: "read",
        enabled: true,
        muted: false,
        points: [],
      },
    ]);

    const pluginGroup = groups.find((g) => g.category === "plugin")!;
    expect(pluginGroup.targets.length).toBe(2);
    expect(pluginGroup.targets.some((t) => t.parameterId === "param:0")).toBe(false);
    const customParam = pluginGroup.targets.find((t) => t.parameterId === "param:2");
    expect(customParam).toBeDefined();
    expect(customParam?.label).toContain("Param 3");
    expect(customParam?.disabledReason).toContain("Unbound");
  });

  it("discovers actual vendor metadata, aliases legacy indexes and reports effective values", () => {
    const metadata: PluginParameterList = { slotId: "slot:1", loadState: "loaded", loadError: "", truncated: false,
      parameters: [{ index: 2, parameterId: "id:filter", name: "Filter frequency", label: "Hz", defaultValue: 0.4,
        currentValue: 0.75, steps: 0, automatable: true }] };
    const target = getTrackAutomationTargets(baseTrack, undefined, [], { "slot:1": metadata })
      .find((group) => group.category === "plugin")!.targets[0];
    expect(target.parameterId).toBe("id:filter");
    expect(target.label).toContain("Filter frequency");
    expect(target.currentValue).toBe(0.75);
    expect(target.disabledReason).toBeUndefined();
    expect(matchesAutomationTarget(target, { ...target, parameterId: "param:2" })).toBe(true);
    expect(matchesAutomationTarget(target, { ...target, parameterId: "param:3" })).toBe(false);
  });

  it("includes slot-owned lanes instead of filtering plugin lanes out of their track", () => {
    const lanes = [{ id: "owned", target: { entityId: "slot:1" } },
      { id: "other", target: { entityId: "slot:2" } }, { id: "strip", target: { entityId: "track:1" } }] as AutomationLaneRow[];
    expect(getAutomationLanesForTrack(baseTrack, lanes).map((lane) => lane.id)).toEqual(["owned", "strip"]);
  });

  it("detects orphan plug-in and send lanes when entities are removed", () => {
    const groups = getTrackAutomationTargets(baseTrack, undefined, [
      {
        id: "lane:orphan:plugin",
        target: {
          domain: "plugin",
          entityId: "slot:removed_vst",
          parameterId: "param:5",
          valueType: "floatNormalized",
          defaultValue: 0.5,
          minValue: 0,
          maxValue: 1,
        },
        scope: "track",
        writeMode: "read",
        enabled: true,
        muted: false,
        points: [],
      },
      {
        id: "lane:orphan:send",
        target: {
          domain: "strip",
          entityId: "track:1",
          parameterId: "send:99",
          valueType: "floatNormalized",
          defaultValue: 1.0,
          minValue: 0,
          maxValue: 1,
        },
        scope: "track",
        writeMode: "read",
        enabled: true,
        muted: false,
        points: [],
      },
    ]);

    const orphanGroup = groups.find((g) => g.category === "orphan");
    expect(orphanGroup).toBeDefined();
    expect(orphanGroup?.categoryLabel).toBe("Missing / Detached Targets");
    expect(orphanGroup?.targets.length).toBe(2);

    const pluginOrphan = orphanGroup?.targets.find((t) => t.id === "orphan:lane:orphan:plugin");
    expect(pluginOrphan).toBeDefined();
    expect(pluginOrphan?.label).toContain("[Missing Plug-in]");
    expect(pluginOrphan?.disabledReason).toContain("removed or unavailable");

    const sendOrphan = orphanGroup?.targets.find((t) => t.id === "orphan:lane:orphan:send");
    expect(sendOrphan).toBeDefined();
    expect(sendOrphan?.label).toContain("[Missing Send]");
    expect(sendOrphan?.disabledReason).toContain("removed or disconnected");
  });

  describe("formatAutomationValue", () => {
    it("formats decibels properly with -inf", () => {
      expect(formatAutomationValue(-60, { parameterId: "faderGainDb" })).toBe("-∞ dB");
      expect(formatAutomationValue(-65, { parameterId: "faderGainDb" })).toBe("-∞ dB");
      expect(formatAutomationValue(-3.5, { parameterId: "faderGainDb" })).toBe("-3.5 dB");
      expect(formatAutomationValue(2.0, { parameterId: "faderGainDb" })).toBe("+2.0 dB");
    });

    it("formats pan with L, C, R", () => {
      expect(formatAutomationValue(0, { parameterId: "pan" })).toBe("C");
      expect(formatAutomationValue(-0.5, { parameterId: "pan" })).toBe("50% L");
      expect(formatAutomationValue(0.75, { parameterId: "pan" })).toBe("75% R");
    });

    it("formats mute boolean", () => {
      expect(formatAutomationValue(1, { parameterId: "mute" })).toBe("Muted");
      expect(formatAutomationValue(0, { parameterId: "mute" })).toBe("Unmuted");
    });

    it("formats pitch bend with sign", () => {
      expect(formatAutomationValue(4096, { parameterId: "pitchBend" })).toBe("+4096");
      expect(formatAutomationValue(-2048, { parameterId: "pitchBend" })).toBe("-2048");
    });

    it("formats MIDI CC integers", () => {
      expect(formatAutomationValue(64, { parameterId: "cc:1" })).toBe("64");
    });
  });
});
