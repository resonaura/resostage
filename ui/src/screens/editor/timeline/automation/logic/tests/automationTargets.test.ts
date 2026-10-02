/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  formatAutomationValue,
  getTrackAutomationTargets,
} from "../automationTargets";
import type { TrackRow } from "@/lib/state/types";

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
