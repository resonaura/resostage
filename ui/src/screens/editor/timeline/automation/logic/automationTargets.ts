/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type {
  AutomationLaneRow,
  BusRow,
  SongRow,
  TrackRow,
} from "@/lib/state/types";
import {
  getPluginParameterList,
  pluginParameterKey,
  type AutomationPluginParameterCatalog,
} from "@/screens/editor/timeline/automation/logic/pluginParameterIdentity";
import type {
  AutomationTargetCategory,
  AutomationTargetOption,
} from "@/screens/editor/timeline/automation/logic/types";

export interface GroupedAutomationTargets {
  category: AutomationTargetCategory;
  categoryLabel: string;
  targets: AutomationTargetOption[];
}

export interface DetachedPluginAutomationLane {
  lane: AutomationLaneRow;
  location: string;
  reason: "slot-missing" | "slot-ambiguous" | "plugin-unavailable" | "parameter-unbound";
}

/**
 * Finds plug-in lanes whose slot no longer exists anywhere in the project.
 * Their original track cannot be inferred from the target alone, so callers
 * must present them in a project-level recovery surface instead of dropping
 * them from every track's lane list.
 */
export function getDetachedPluginAutomationLanes(
  tracks: TrackRow[],
  song: SongRow | undefined,
  parameters: AutomationPluginParameterCatalog = {},
): DetachedPluginAutomationLane[] {
  if (!song) return [];
  const slotsById = new Map<string, Array<{ slot: NonNullable<TrackRow["plugins"]>[number]; track: TrackRow }>>();
  for (const track of tracks ?? []) for (const slot of track.plugins ?? []) {
    const matches = slotsById.get(slot.id) ?? [];
    matches.push({ slot, track });
    slotsById.set(slot.id, matches);
  }
  const locatedLanes: Array<{ lane: AutomationLaneRow; location: string }> = [
    ...(song.automationLanes ?? []).map((lane) => ({ lane, location: "Song automation" })),
    ...(song.regions ?? []).flatMap((region) => (region.automationLanes ?? []).map((lane) => ({
      lane,
      location: `Audio region ${region.id.slice(0, 8)}`,
    }))),
    ...(song.midiRegions ?? []).flatMap((region) => (region.automationLanes ?? []).map((lane) => ({
      lane,
      location: `MIDI region ${region.name || region.id.slice(0, 8)}`,
    }))),
  ];
  const detached: DetachedPluginAutomationLane[] = [];
  for (const { lane, location } of locatedLanes) {
    if (lane.target.domain !== "plugin") continue;
    const matchingSlots = slotsById.get(lane.target.entityId) ?? [];
    if (matchingSlots.length === 0) {
      detached.push({ lane, location, reason: "slot-missing" });
      continue;
    }
    if (matchingSlots.length > 1) {
      detached.push({ lane, location, reason: "slot-ambiguous" });
      continue;
    }
    const { slot, track } = matchingSlots[0];

    const metadata = getPluginParameterList(parameters, track.stripId ?? track.id, slot.id);
    if (metadata?.loadState === "failed" || metadata?.loadState === "missing"
      || slot.loadState === "failed" || slot.loadState === "missing") {
      detached.push({ lane, location, reason: "plugin-unavailable" });
      continue;
    }

    // A missing descriptor is conclusive only after a complete metadata read.
    // Truncated tables and loading slots must not create false orphan warnings.
    if (metadata?.loadState !== "loaded" || metadata.truncated) continue;
    const parameter = metadata.parameters.find((candidate) =>
      candidate.parameterId === lane.target.parameterId
      || `param:${candidate.index}` === lane.target.parameterId);
    if (!parameter || !parameter.automatable) {
      detached.push({ lane, location, reason: "parameter-unbound" });
    }
  }
  return detached;
}

/**
 * Discovers and formats all valid automatable targets for a track.
 */
export function getTrackAutomationTargets(
  track: TrackRow,
  buses?: BusRow[],
  existingLanes?: AutomationLaneRow[],
  parameters: AutomationPluginParameterCatalog = {},
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
      currentValue: track.gainDb,
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
      currentValue: track.pan,
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
      currentValue: track.mute ? 1 : 0,
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
      const matchingSends = track.output!.sends!.filter((candidate) => candidate.bus === send.bus);
      const enabledMatches = matchingSends.filter((candidate) => candidate.enabled);
      sendTargets.push({
        id: `send:${track.id}:${send.bus || index}${matchingSends.length > 1 ? `:${index}` : ""}`,
        domain: "strip",
        entityId: track.id,
        // Bus identity survives send reordering. Positional IDs are retained
        // only as aliases for projects created before stable send bindings.
        parameterId: `send:${send.bus}`,
        legacyParameterId: `send:${index}`,
        label: `Send to ${busName}`,
        category: "send",
        valueType: "floatNormalized",
        defaultValue: 1.0,
        minValue: 0.0,
        maxValue: 1.0,
        unit: "%",
        currentValue: send.level / 100,
        disabledReason: !send.bus || (buses !== undefined && !bus) ? "Send bus removed or disconnected"
          : !send.enabled ? "Send is disabled"
          : enabledMatches.length !== 1 ? "Ambiguous: multiple enabled sends target this bus" : undefined,
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
      const stripId = track.stripId ?? track.id;
      const metadata = getPluginParameterList(parameters, stripId, slot.id);
      const loadState = metadata?.loadState ?? slot.loadState ?? "loading";
      const slotName = slot.name || `Insert ${slotIdx + 1}`;
      const targetSlotId = pluginParameterKey(stripId, slot.id);
      const disabledReason = metadata?.scopeAmbiguous
        ? "Plug-in slot ID is duplicated; this legacy automation target cannot identify one strip."
        : undefined;

      // Discover actual vendor parameters. Never substitute an invented Param 1.
      for (const parameter of metadata?.parameters ?? []) pluginTargets.push({
        id: `plugin:${targetSlotId}:${parameter.parameterId}`,
        domain: "plugin",
        entityId: slot.id,
        parameterId: parameter.parameterId,
        legacyParameterId: `param:${parameter.index}`,
        label: `${slotName} · ${parameter.name || parameter.parameterId}`,
        category: "plugin",
        valueType: "floatNormalized",
        defaultValue: parameter.defaultValue,
        currentValue: parameter.currentValue,
        minValue: 0.0,
        maxValue: 1.0,
        unit: "",
        disabledReason: disabledReason ?? (
          loadState !== "loaded" ? `Plug-in ${loadState}`
            : !parameter.automatable ? "Parameter cannot be automated" : undefined
        ),
      });
      if (!metadata?.parameters.length) pluginTargets.push({
        id: `plugin:${targetSlotId}:status`, domain: "plugin", entityId: slot.id,
        parameterId: "", label: `${slotName} · ${loadState === "loaded" ? "No automatable parameters" : loadState}`,
        category: "plugin", valueType: "floatNormalized", defaultValue: 0,
        minValue: 0, maxValue: 1, unit: "",
        disabledReason: disabledReason ?? metadata?.loadError
          ?? (loadState === "loaded" ? "No parameters exposed" : `Plug-in ${loadState}`),
      });

      // Retain any other parameters already automated in existingLanes for this slot
      if (existingLanes) {
        existingLanes.forEach((lane) => {
          if (
            lane.target.domain === "plugin" &&
            lane.target.entityId === slot.id &&
            lane.target.parameterId !== ""
          ) {
            const exists = pluginTargets.some(
              (t) => matchesAutomationTarget(t, lane.target),
            );
            if (!exists) {
              let paramLabel = lane.target.parameterId;
              if (paramLabel.startsWith("param:")) {
                const idx = parseInt(paramLabel.slice(6), 10);
                paramLabel = Number.isFinite(idx) ? `Param ${idx + 1}` : paramLabel;
              }
              pluginTargets.push({
                id: `plugin:${targetSlotId}:${lane.target.parameterId}`,
                domain: "plugin",
                entityId: slot.id,
                parameterId: lane.target.parameterId,
                label: `${slotName} · ${paramLabel}`,
                category: "plugin",
                valueType: lane.target.valueType ?? "floatNormalized",
                defaultValue: lane.target.defaultValue ?? 0.5,
                minValue: lane.target.minValue ?? 0.0,
                maxValue: lane.target.maxValue ?? 1.0,
                unit: "",
                currentValue: lane.target.defaultValue,
                disabledReason: disabledReason ?? (
                  loadState !== "loaded" ? `Plug-in ${loadState}`
                    : metadata?.truncated ? "Parameter unavailable in bounded metadata"
                      : "Unbound: parameter no longer exposed by this plug-in"
                ),
              });
            }
          }
        });
      }
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

  // 5. Orphan / Missing targets from existing lanes
  if (existingLanes && existingLanes.length > 0) {
    const orphanTargets: AutomationTargetOption[] = [];
    existingLanes.forEach((lane) => {
      if (lane.target.domain === "plugin") {
        const slotFound = track.plugins?.some((p) => p.id === lane.target.entityId);
        if (!slotFound) {
          const slotShort =
            lane.target.entityId.length > 8
              ? `${lane.target.entityId.slice(0, 8)}…`
              : lane.target.entityId;
          orphanTargets.push({
            id: `orphan:${lane.id}`,
            domain: lane.target.domain,
            entityId: lane.target.entityId,
            parameterId: lane.target.parameterId,
            label: `[Missing Plug-in] ${slotShort} · ${lane.target.parameterId}`,
            category: "orphan",
            valueType: lane.target.valueType ?? "floatNormalized",
            defaultValue: lane.target.defaultValue ?? 0.0,
            minValue: lane.target.minValue ?? 0.0,
            maxValue: lane.target.maxValue ?? 1.0,
            unit: "",
            disabledReason: "Plug-in slot removed or unavailable",
          });
        }
      } else if (lane.target.domain === "strip") {
        if (lane.target.parameterId.startsWith("send:")) {
          const sendExists = sendTargets.some((target) => matchesAutomationTarget(target, lane.target));
          if (!sendExists) {
            orphanTargets.push({
              id: `orphan:${lane.id}`,
              domain: "strip",
              entityId: lane.target.entityId,
              parameterId: lane.target.parameterId,
              label: `[Missing Send] ${lane.target.parameterId}`,
              category: "orphan",
              valueType: lane.target.valueType ?? "floatNormalized",
              defaultValue: 1.0,
              minValue: 0.0,
              maxValue: 1.0,
              unit: "%",
              disabledReason: "Send bus removed or disconnected",
            });
          }
        } else if (lane.target.entityId !== track.id) {
          orphanTargets.push({
            id: `orphan:${lane.id}`,
            domain: "strip",
            entityId: lane.target.entityId,
            parameterId: lane.target.parameterId,
            label: `[Detached Strip] ${lane.target.parameterId}`,
            category: "orphan",
            valueType: lane.target.valueType ?? "floatNormalized",
            defaultValue: 0.0,
            minValue: 0.0,
            maxValue: 1.0,
            unit: "",
            disabledReason: "Channel strip detached",
          });
        }
      } else if (lane.target.domain === "midiCC" && !isMidi) {
        orphanTargets.push({
          id: `orphan:${lane.id}`,
          domain: "midiCC",
          entityId: lane.target.entityId,
          parameterId: lane.target.parameterId,
          label: `[Detached MIDI] ${lane.target.parameterId}`,
          category: "orphan",
          valueType: lane.target.valueType ?? "integer",
          defaultValue: 0,
          minValue: 0,
          maxValue: 127,
          unit: "",
          disabledReason: "Track does not support MIDI",
        });
      }
    });

    if (orphanTargets.length > 0) {
      groups.push({
        category: "orphan",
        categoryLabel: "Missing / Detached Targets",
        targets: orphanTargets,
      });
    }
  }

  return groups;
}

export function matchesAutomationTarget(option: AutomationTargetOption, target: AutomationLaneRow["target"]): boolean {
  return option.domain === target.domain && option.entityId === target.entityId
    && (option.parameterId === target.parameterId || option.legacyParameterId === target.parameterId);
}

/** Slot ownership must be included; plugin lanes target a slot UUID, not a track. */
export function getAutomationLanesForTrack(
  track: TrackRow,
  lanes: AutomationLaneRow[],
  projectTracks: TrackRow[] = [track],
): AutomationLaneRow[] {
  const trackOwned = new Set([track.id, track.stripId]);
  const slotOwners = new Map<string, TrackRow[]>();
  for (const candidate of projectTracks) for (const slot of candidate.plugins ?? []) {
    const owners = slotOwners.get(slot.id) ?? [];
    owners.push(candidate);
    slotOwners.set(slot.id, owners);
  }
  const ownedSlotIds = new Set((track.plugins ?? []).map((slot) => slot.id));
  return lanes.filter((lane) => {
    if (lane.target.domain !== "plugin") return trackOwned.has(lane.target.entityId);
    if (!ownedSlotIds.has(lane.target.entityId)) return false;
    const owners = slotOwners.get(lane.target.entityId) ?? [];
    return owners.length === 1 && owners[0].id === track.id;
  });
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
