/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MixGraphEdge, MixGraphPayload, MixGraphStrip } from "@/lib/audio/mixGraph";
import type { TrackRow, WebUiState } from "@/lib/state/types";
import { pathThrough, type FocusedPath } from "@/screens/settings/audio/logic/signalFlowLayout";

export interface AudioFlowNode {
  id: string;
  kind: MixGraphStrip["kind"];
  strip: MixGraphStrip;
  trackIndex?: number;
  detail?: string;
}

export interface MidiFlowNode {
  id: string;
  kind: "midi-input" | "midi-output" | "midi-router" | "midi-sequencer" | "midi-events" | "midi-transport";
  name: string;
  detail: string;
  unavailable?: boolean;
}

export type SignalFlowNode = AudioFlowNode | MidiFlowNode;
export interface SignalFlowEdge extends MixGraphEdge {
  protocol: "audio" | "sidechain" | "midi";
  label?: string;
  pluginSlotId?: string;
  pluginName?: string;
  inputBusIndex?: number;
  channelMode?: "automatic" | "mono-sum" | "left" | "right";
}
export interface SignalFlowModel {
  strips: SignalFlowNode[];
  edges: SignalFlowEdge[];
  midiConnections: number;
  sidechainConnections?: number;
}

/** Resolve a node's connected path while preserving indices into model.edges. */
export function pathThroughSignalFlow(
  model: SignalFlowModel,
  stripId: string,
  audioOnly = false,
): FocusedPath {
  const originalIndices: number[] = [];
  const candidates: SignalFlowEdge[] = [];
  model.edges.forEach((edge, index) => {
    if (audioOnly && edge.protocol === "midi") return;
    originalIndices.push(index);
    candidates.push(edge);
  });
  const path = pathThrough(candidates, stripId);
  return {
    strips: path.strips,
    edges: new Set([...path.edges].map((index) => originalIndices[index])),
  };
}

export function resolveSignalFlowFocus(
  model: SignalFlowModel | null,
  focusStripId: string | undefined,
  focusedView: boolean,
  openedProject: Pick<WebUiState, "stateSessionId" | "projectEpoch">,
  currentProject: Pick<WebUiState, "stateSessionId" | "projectEpoch">,
): { projectMatches: boolean; targetExists: boolean; focusNodeId: string | null | undefined } {
  const projectMatches = openedProject.stateSessionId === currentProject.stateSessionId &&
    openedProject.projectEpoch === currentProject.projectEpoch;
  const targetExists = Boolean(focusStripId && projectMatches &&
    model?.strips.some((node) => node.id === focusStripId));
  return {
    projectMatches,
    targetExists,
    focusNodeId: focusStripId ? (focusedView && targetExists ? focusStripId : null) : undefined,
  };
}

const INPUT_ROUTER = "midi::live-input";
const OUTPUT_ROUTER = "midi::dispatcher";

const isMidiTrack = (track: TrackRow) =>
  track.kind === "instrument" || track.kind === "midi" || track.kind === "externalMidi";
const isExternalTrack = (track: TrackRow) => track.kind === "midi" || track.kind === "externalMidi";

/** Legacy settings contain plain names; platform inventories may append stable endpoint IDs. */
function endpointAvailable(name: string, available: string[]): boolean {
  return available.some((endpoint) => endpoint === name || endpoint.replace(/ \[-?\d+\]$/, "") === name);
}

/**
 * Audio edges remain a verbatim Core graph. MIDI overlays the published device
 * preferences and current song/track routes; these are configured paths, not
 * delivery telemetry. In particular midiInputDevice is not a live filter in
 * AudioEngine: all opened sources feed one queue before channel/focus routing.
 */
export function buildSignalFlowModel(graph: MixGraphPayload, state: WebUiState): SignalFlowModel {
  const trackByStrip = new Map(state.tracks.map((track, index) => [track.id, { track, index }]));
  const trackById = new Map(state.tracks.map((track) => [track.id, track]));
  const busById = new Map(state.busses.map((bus) => [bus.id, bus]));
  const audioNodes: AudioFlowNode[] = graph.strips.map((strip) => {
    const owner = trackByStrip.get(strip.id);
    return {
      id: strip.id,
      kind: strip.kind,
      strip,
      trackIndex: owner?.index,
      detail: owner && isMidiTrack(owner.track)
        ? isExternalTrack(owner.track) ? "External MIDI" : "Software instrument"
        : undefined,
    };
  });
  const sourceNodes: MidiFlowNode[] = [];
  const destinationNodes: MidiFlowNode[] = [];
  const edges: SignalFlowEdge[] = [
    ...graph.edges.map((edge) => ({ ...edge, protocol: "audio" as const })),
    ...(graph.sidechainEdges ?? []).map((edge) => ({
      ...edge,
      level: 100,
      preFader: false,
      sourceChannel: -1,
      protocol: "sidechain" as const,
    })),
  ];
  const audioIds = new Set(graph.strips.map((strip) => strip.id));
  const addMidiEdge = (from: string, to: string, label?: string, active = true) => {
    edges.push({ from, to, label, active, protocol: "midi", level: 100, preFader: false, sourceChannel: -1 });
  };

  const settings = state.settings;
  const selectedInputs = settings.selectedMidiInputs ??
    (settings.currentMidiInput && settings.currentMidiInput !== "none" ? [settings.currentMidiInput] : []);
  const allInputs = selectedInputs.includes("All Inputs") || selectedInputs.includes("all");
  const inputs = [...new Set(allInputs
    ? settings.midiInputs.filter((name) => name !== "All Inputs" && name !== "all")
    : selectedInputs.filter((name) => name && name !== "none"))];
  if (allInputs && inputs.length === 0) inputs.push("All Inputs");
  for (const name of inputs) {
    const available = name !== "All Inputs" && endpointAvailable(name, settings.midiInputs);
    const id = `midi::input:${name}`;
    sourceNodes.push({ id, kind: "midi-input", name,
      detail: available ? "Selected MIDI input" : "Selected input · unavailable",
      unavailable: !available });
    addMidiEdge(id, INPUT_ROUTER, undefined, available);
  }
  if (inputs.length > 0) {
    sourceNodes.push({ id: INPUT_ROUTER, kind: "midi-router", name: "Live MIDI input", detail: "Shared input · channel filters" });
    const midiTracks = state.tracks.filter(isMidiTrack);
    const focus = midiTracks.find((track) => track.id === state.activeTrackId) ?? midiTracks[0];
    for (const track of midiTracks) {
      const target = track.id;
      if (!audioIds.has(target) || !(track.recordArmed || track.inputMonitoring || track === focus)) continue;
      const reasons = [track === focus ? "focus" : null, track.recordArmed ? "armed" : null, track.inputMonitoring ? "monitor" : null].filter(Boolean);
      const channel = track.midiInputChannel ? `ch ${track.midiInputChannel}` : "omni";
      addMidiEdge(INPUT_ROUTER, target, `${channel} · ${reasons.join("/")}`);
    }
  }

  const song = state.songs[state.songIndex];
  const midiTargets = (track: TrackRow, regionFallback: boolean): Set<string> => {
    const effectiveTarget = track.stripId || track.id;
    const pluginTarget = regionFallback && !audioIds.has(effectiveTarget) ? track.id : effectiveTarget;
    const plugins = trackById.get(pluginTarget)?.plugins ?? busById.get(pluginTarget)?.plugins ??
      (pluginTarget === "audio::click" ? state.click?.plugins : undefined);
    const instrument = plugins?.some((plugin) => plugin.instrument &&
      !["missing", "failed", "loading"].includes(plugin.loadState ?? plugin.powerState ?? ""));
    const targets = new Set<string>();
    if (instrument && audioIds.has(pluginTarget)) targets.add(pluginTarget);
    if (isExternalTrack(track) && audioIds.has(track.id)) targets.add(track.id);
    return targets;
  };
  const regionTargets = new Map<string, { count: number; enabled: boolean }>();
  for (const region of song?.midiRegions ?? []) {
    const track = trackById.get(region.trackId);
    if (!track) continue;
    const hasMessages = region.notes.length || region.events?.length || region.umpEvents?.length;
    const hasMidiAutomation = region.automationLanes?.some((lane) => lane.target.domain === "midiCC" && lane.enabled && !lane.muted && lane.points.length > 0);
    if (region.durationBeats <= 0 || !(hasMessages || hasMidiAutomation)) continue;
    // Region dispatch may address another instrument/bus strip. Live ingress
    // uses the owning track's own strip index instead; do not alias those paths.
    for (const target of midiTargets(track, Boolean(hasMessages))) {
      const previous = regionTargets.get(target);
      regionTargets.set(target, { count: (previous?.count ?? 0) + 1, enabled: Boolean(previous?.enabled || !region.muted) });
    }
  }
  if (regionTargets.size > 0) {
    const id = "midi::regions";
    sourceNodes.push({ id, kind: "midi-sequencer", name: "MIDI regions", detail: song?.name || "Current song" });
    for (const [target, route] of regionTargets)
      addMidiEdge(id, target, `${route.count} region${route.count === 1 ? "" : "s"}${route.enabled ? "" : " · muted"}`, route.enabled);
  }

  const automationTargets = new Map<string, number>();
  for (const lane of song?.automationLanes ?? []) {
    if (lane.target.domain !== "midiCC" || !lane.enabled || lane.muted || lane.points.length === 0) continue;
    const track = trackById.get(lane.target.entityId);
    if (!track) continue;
    for (const target of midiTargets(track, false))
      automationTargets.set(target, (automationTargets.get(target) ?? 0) + 1);
  }
  if (automationTargets.size > 0) {
    const id = "midi::automation";
    sourceNodes.push({ id, kind: "midi-sequencer", name: "MIDI automation", detail: "CC / pitch bend · current song" });
    for (const [target, count] of automationTargets)
      addMidiEdge(id, target, `${count} lane${count === 1 ? "" : "s"}`);
  }

  const outputs = [...new Set((settings.selectedMidiOutputs ?? []).filter(Boolean))];
  const externalTracks = state.tracks.filter((track) => isExternalTrack(track) && audioIds.has(track.id));
  const midiEvents = song?.events.filter((event) => ["programChange", "cc", "noteOn", "noteOff"].includes(event.type)) ?? [];
  const showDispatcher = outputs.length > 0 || settings.virtualMidiPortEnabled || externalTracks.length > 0 || midiEvents.length > 0;
  if (showDispatcher) {
    if (midiEvents.length > 0) {
      const id = "midi::events";
      sourceNodes.push({ id, kind: "midi-events", name: "Timeline MIDI events", detail: `${midiEvents.length} events · ${song?.name || "current song"}` });
      addMidiEdge(id, OUTPUT_ROUTER);
    }
    const transportId = "midi::transport";
    sourceNodes.push({ id: transportId, kind: "midi-transport", name: "Transport / MIDI clock", detail: "Start · continue · stop · 24 PPQN" });
    addMidiEdge(transportId, OUTPUT_ROUTER);
    // One dispatcher fans packets out to all selected destinations, including
    // the enabled virtual source. No per-track output assignment exists.
    destinationNodes.push({ id: OUTPUT_ROUTER, kind: "midi-router", name: "MIDI output",
      detail: outputs.length || settings.virtualMidiPortEnabled ? "Shared destination fan-out" : "Hardware output disabled" });
    for (const track of externalTracks)
      addMidiEdge(track.id, OUTPUT_ROUTER, "MIDI thru / sequence");
    for (const name of outputs) {
      const available = endpointAvailable(name, settings.midiOutputs);
      const id = `midi::output:${name}`;
      destinationNodes.push({ id, kind: "midi-output", name,
        detail: available ? "Selected MIDI destination" : "Selected output · unavailable", unavailable: !available });
      addMidiEdge(OUTPUT_ROUTER, id, undefined, available);
    }
    if (settings.virtualMidiPortEnabled) {
      const id = "midi::sync-output";
      destinationNodes.push({ id, kind: "midi-output", name: "ResoStage Sync", detail: "Configured virtual MIDI source" });
      addMidiEdge(OUTPUT_ROUTER, id);
    }
  }

  return {
    strips: [...sourceNodes, ...audioNodes, ...destinationNodes],
    edges,
    midiConnections: edges.filter((edge) => edge.protocol === "midi").length,
    sidechainConnections: edges.filter((edge) => edge.protocol === "sidechain").length,
  };
}
