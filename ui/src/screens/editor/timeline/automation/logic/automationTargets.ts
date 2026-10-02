/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type {
  BusRow,
  TrackRow,
} from "@/lib/state/types";
import type {
  AutomationTargetCategory,
  AutomationTargetOption,
} from "./types";

export interface GroupedAutomationTargets {
  category: AutomationTargetCategory;
  categoryLabel: string;
  targets: AutomationTargetOption[];
}

/**
 * Discovers and formats all valid automatable targets for a track.
 */
export function getTrackAutomationTargets(
  track: TrackRow,
  buses?: BusRow[],
): GroupedAutomationTargets[] {
  const groups: GroupedAutomationTargets[] = [];

  // 1. Channel Strip targets (Gain, Pan, Mute)
  const stripTargets: AutomationTargetOption[] = [
    {
      id: `strip:${track.id}:gain`,
      domain: "strip",
      entityId: track.id,
      parameterId: "faderGainDb",
      label: "Fader Gain",
      category: "strip",
      valueType: "decibels",
      defaultValue: 0.0,
      minValue: -60.0,
      maxValue: 12.0,
      unit: "dB",
    },
    {
      id: `strip:${track.id}:pan`,
      domain: "strip",
      entityId: track.id,
      parameterId: "pan",
      label: "Pan",
      category: "strip",
      valueType: "floatNormalized",
      defaultValue: 0.0,
      minValue: -1.0,
      maxValue: 1.0,
      unit: "",
    },
    {
      id: `strip:${track.id}:mute`,
      domain: "strip",
      entityId: track.id,
      parameterId: "mute",
      label: "Mute",
      category: "strip",
      valueType: "boolean",
      defaultValue: 0.0,
      minValue: 0.0,
      maxValue: 1.0,
      unit: "",
    },
  ];

  groups.push({
    category: "strip",
    categoryLabel: "Mixer Strip",
    targets: stripTargets,
  });

  // 2. Aux Send targets
  const sendTargets: AutomationTargetOption[] = [];
  if (track.output?.sends && track.output.sends.length > 0) {
    track.output.sends.forEach((send, index) => {
      const bus = buses?.find((b) => b.id === send.bus);
      const busName = bus?.name || `Bus ${index + 1}`;
      sendTargets.push({
        id: `send:${track.id}:${send.bus || index}`,
        domain: "strip",
        entityId: track.id,
        parameterId: `send:${index}`,
        label: `Send to ${busName}`,
        category: "send",
        valueType: "floatNormalized",
        defaultValue: 1.0,
        minValue: 0.0,
        maxValue: 1.0,
        unit: "%",
      });
    });
  }
  if (sendTargets.length > 0) {
    groups.push({
      category: "send",
      categoryLabel: "Aux Sends",
      targets: sendTargets,
    });
  }

  // 3. Plug-in targets
  const pluginTargets: AutomationTargetOption[] = [];
  if (track.plugins && track.plugins.length > 0) {
    track.plugins.forEach((slot, slotIdx) => {
      const isLoaded = slot.loadState === "loaded";
      const slotName = slot.name || `Insert ${slotIdx + 1}`;

      // Primary generic parameter or custom parameter ID
      pluginTargets.push({
        id: `plugin:${slot.id}:primary`,
        domain: "plugin",
        entityId: slot.id,
        parameterId: "param:0",
        label: `${slotName} · Param 1`,
        category: "plugin",
        valueType: "floatNormalized",
        defaultValue: 0.5,
        minValue: 0.0,
        maxValue: 1.0,
        unit: "",
        disabledReason: isLoaded ? undefined : `Plug-in ${slot.loadState || "offline"}`,
      });
    });
  }
  if (pluginTargets.length > 0) {
    groups.push({
      category: "plugin",
      categoryLabel: "Plug-ins",
      targets: pluginTargets,
    });
  }

  // 4. MIDI CC / Pitch Bend targets (if track supports MIDI)
  const isMidi =
    track.kind === "midi" ||
    track.kind === "instrument" ||
    track.kind === "externalMidi";

  if (isMidi) {
    const midiTargets: AutomationTargetOption[] = [
      {
        id: `midi:${track.id}:pitchBend`,
        domain: "midiCC",
        entityId: track.id,
        parameterId: "pitchBend",
        label: "Pitch Bend",
        category: "midi",
        valueType: "integer",
        defaultValue: 0,
        minValue: -8192,
        maxValue: 8191,
        unit: "",
      },
      {
        id: `midi:${track.id}:cc:1`,
        domain: "midiCC",
        entityId: track.id,
        parameterId: "cc:1",
        label: "Modulation Wheel (CC 1)",
        category: "midi",
        valueType: "integer",
        defaultValue: 0,
        minValue: 0,
        maxValue: 127,
        unit: "",
      },
      {
        id: `midi:${track.id}:cc:11`,
        domain: "midiCC",
        entityId: track.id,
        parameterId: "cc:11",
        label: "Expression (CC 11)",
        category: "midi",
        valueType: "integer",
        defaultValue: 127,
        minValue: 0,
        maxValue: 127,
        unit: "",
      },
      {
        id: `midi:${track.id}:cc:7`,
        domain: "midiCC",
        entityId: track.id,
        parameterId: "cc:7",
        label: "Channel Volume (CC 7)",
        category: "midi",
        valueType: "integer",
        defaultValue: 100,
        minValue: 0,
        maxValue: 127,
        unit: "",
      },
      {
        id: `midi:${track.id}:cc:64`,
        domain: "midiCC",
        entityId: track.id,
        parameterId: "cc:64",
        label: "Sustain Pedal (CC 64)",
        category: "midi",
        valueType: "integer",
        defaultValue: 0,
        minValue: 0,
        maxValue: 127,
        unit: "",
      },
      {
        id: `midi:${track.id}:cc:74`,
        domain: "midiCC",
        entityId: track.id,
        parameterId: "cc:74",
        label: "Brightness / Cutoff (CC 74)",
        category: "midi",
        valueType: "integer",
        defaultValue: 64,
        minValue: 0,
        maxValue: 127,
        unit: "",
      },
    ];

    groups.push({
      category: "midi",
      categoryLabel: "MIDI CC",
      targets: midiTargets,
    });
  }

  return groups;
}

/**
 * Formats value for display tooltip / readout.
 */
export function formatAutomationValue(
  value: number,
  target?: AutomationTargetOption | { parameterId: string; valueType?: string },
): string {
  if (!Number.isFinite(value)) return "0.0";
  const paramId = target?.parameterId ?? "";

  if (paramId === "faderGainDb" || target?.valueType === "decibels") {
    if (value <= -60) return "-∞ dB";
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)} dB`;
  }
  if (paramId === "pan") {
    if (Math.abs(value) < 0.02) return "C";
    if (value < 0) return `${Math.round(Math.abs(value) * 100)}% L`;
    return `${Math.round(value * 100)}% R`;
  }
  if (paramId === "mute" || target?.valueType === "boolean") {
    return value >= 0.5 ? "Muted" : "Unmuted";
  }
  if (paramId === "pitchBend") {
    return `${value >= 0 ? "+" : ""}${Math.round(value)}`;
  }
  if (paramId.startsWith("cc:") || target?.valueType === "integer") {
    return Math.round(value).toString();
  }
  // Generic float 0..1 or percent
  return `${Math.round(value * 100)}%`;
}
