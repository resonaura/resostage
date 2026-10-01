/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { MixGraphPayload, MixGraphStrip } from "@/lib/audio/mixGraph";
import { emptyState, type SongRow, type TrackRow } from "@/lib/state/types";
import { buildSignalFlowModel } from "@/screens/settings/audio/logic/signalFlowModel";
import { layerStrips, pathThrough } from "@/screens/settings/audio/logic/signalFlowLayout";

function track(id: string, kind: TrackRow["kind"] = "instrument", extra: Partial<TrackRow> = {}): TrackRow {
  return { id, name: id, kind, channels: 2, gainDb: 0, pan: 0, mute: false, solo: false,
    soloGroup: "sources", soloActiveInGroup: false, peakDb: -100, output: { type: "main", sends: [] }, ...extra };
}
function strip(id: string, extra: Partial<MixGraphStrip> = {}): MixGraphStrip {
  return { id, name: id, kind: "track", channels: 2, gainDb: 0, pan: 0, mute: false,
    solo: false, soloGroup: "sources", audible: true, physicalChannel: -1, peakDb: -100, ...extra };
}
const graphFor = (tracks: TrackRow[]): MixGraphPayload => ({ strips: tracks.map((track) => strip(track.id)), edges: [] });
const song = (): SongRow => ({ name: "Current song", bpm: 120, mode: "auto", tsNum: 4, tsDen: 4, click: false, clickBusId: "audio::main", clickSends: [], events: [] });

describe("signal flow model", () => {
  it("preserves direct L/R, bus physical routes and shadow lanes from Core", () => {
    const graph: MixGraphPayload = {
      strips: [strip("track"), strip("aux", { kind: "send" }), strip("main", { kind: "main" }),
        strip("audio::out:1", { kind: "output", channels: 1, physicalChannel: 0 }),
        strip("audio::out:2", { kind: "output", channels: 1, physicalChannel: 1 }),
        strip("audio::out:9", { kind: "output", channels: 1, physicalChannel: -1 })],
      edges: [
        { from: "track", to: "audio::out:1", level: 100, preFader: false, active: true, sourceChannel: 0 },
        { from: "track", to: "audio::out:2", level: 100, preFader: false, active: true, sourceChannel: 1 },
        { from: "track", to: "aux", level: 25, preFader: true, active: true, sourceChannel: -1 },
        { from: "aux", to: "audio::out:9", level: 100, preFader: false, active: false, sourceChannel: -1 },
      ],
    };
    const model = buildSignalFlowModel(graph, structuredClone(emptyState));
    expect(model.edges.map(({ protocol: _protocol, ...edge }) => edge)).toEqual(graph.edges);
    expect(model.strips[0]).toHaveProperty("strip", graph.strips[0]);
    const columns = layerStrips(model);
    const destinationColumn = columns.get("audio::out:9");
    expect(columns.get("audio::out:1")).toBe(destinationColumn);
    expect(columns.get("audio::out:2")).toBe(destinationColumn);
    expect(destinationColumn).toBeGreaterThan(columns.get("aux")!);
    expect(pathThrough(model.edges, "track").strips.has("audio::out:9")).toBe(true);
  });

  it("routes selected inputs through the shared queue to focused, armed and monitored tracks", () => {
    const state = structuredClone(emptyState);
    state.tracks = [track("focused", "instrument", { midiInputDevice: "Keyboard A", midiInputChannel: 2 }),
      track("armed", "externalMidi", { recordArmed: true }), track("monitor", "midi", { inputMonitoring: true }), track("idle")];
    state.activeTrackId = "focused";
    state.settings.selectedMidiInputs = ["Keyboard A", "Keyboard B"];
    state.settings.midiInputs = ["All Inputs", "Keyboard A", "Keyboard B"];
    const model = buildSignalFlowModel(graphFor(state.tracks), state);
    expect(model.edges.filter((edge) => edge.to === "midi::live-input").map((edge) => edge.from))
      .toEqual(["midi::input:Keyboard A", "midi::input:Keyboard B"]);
    expect(model.edges.filter((edge) => edge.from === "midi::live-input").map((edge) => [edge.to, edge.label]))
      .toEqual([["focused", "ch 2 · focus"], ["armed", "omni · armed"], ["monitor", "omni · monitor"]]);
    // Persisted per-track device names are not interpreted as enforced filters.
    expect(model.edges.some((edge) => edge.from === "midi::input:Keyboard B" && edge.to === "focused")).toBe(false);
  });

  it("uses Core's first-MIDI-track fallback when focus is on an audio track", () => {
    const state = structuredClone(emptyState);
    state.tracks = [track("audio", "audio"), track("first"), track("second")];
    state.activeTrackId = "audio";
    state.settings.selectedMidiInputs = ["Keys"];
    state.settings.midiInputs = ["Keys"];
    const model = buildSignalFlowModel(graphFor(state.tracks), state);
    expect(model.edges.filter((edge) => edge.from === "midi::live-input").map((edge) => edge.to)).toEqual(["first"]);
  });

  it("expands explicit All Inputs and preserves missing selected endpoints without inventing defaults", () => {
    const state = structuredClone(emptyState);
    state.settings.selectedMidiInputs = ["All Inputs"];
    state.settings.midiInputs = ["All Inputs", "A [100]", "B [101]"];
    state.settings.selectedMidiOutputs = ["Missing output"];
    state.settings.midiOutputs = ["Other output"];
    const model = buildSignalFlowModel({ strips: [], edges: [] }, state);
    expect(model.strips.filter((node) => node.kind === "midi-input").map((node) => node.id))
      .toEqual(["midi::input:A [100]", "midi::input:B [101]"]);
    expect(model.strips.find((node) => node.id === "midi::output:Missing output")).toHaveProperty("unavailable", true);
    expect(model.edges.find((edge) => edge.to === "midi::output:Missing output")?.active).toBe(false);
    state.settings.selectedMidiInputs = [];
    state.settings.selectedMidiOutputs = [];
    const empty = buildSignalFlowModel({ strips: [], edges: [] }, state);
    expect(empty.strips).toEqual([]);
    expect(empty.edges).toEqual([]);
  });

  it("shares external output fan-out and includes timeline events, transport and enabled virtual output", () => {
    const state = structuredClone(emptyState);
    state.tracks = [track("external", "externalMidi"), track("synth")];
    state.settings.selectedMidiOutputs = ["Synth A", "Synth B"];
    state.settings.midiOutputs = ["Synth A [111]", "Synth B"];
    state.settings.virtualMidiPortEnabled = true;
    state.songIndex = 0;
    state.songs = [{ ...song(), events: [{ id: "event", type: "programChange", timeSeconds: 0, triggerOnLoad: true, latencyMs: 0,
      midiChannel: 1, midiProgram: 4, midiCC: 0, midiCCValue: 0, midiNote: 60, midiVelocity: 100, httpUrl: "" }] }];
    const model = buildSignalFlowModel(graphFor(state.tracks), state);
    expect(model.edges.filter((edge) => edge.from === "midi::dispatcher").map((edge) => edge.to))
      .toEqual(["midi::output:Synth A", "midi::output:Synth B", "midi::sync-output"]);
    expect(model.edges.some((edge) => edge.from === "external" && edge.to === "midi::dispatcher")).toBe(true);
    expect(model.edges.some((edge) => edge.from === "synth" && edge.to === "midi::dispatcher")).toBe(false);
    expect(model.edges.some((edge) => edge.from === "midi::events" && edge.to === "midi::dispatcher")).toBe(true);
    expect(model.strips.find((node) => node.id === "midi::output:Synth A")).toHaveProperty("unavailable", false);
  });

  it("resolves region destination aliases while colours stay with actual strips and muted routes remain visible", () => {
    const state = structuredClone(emptyState);
    state.tracks = [track("audio", "audio"), track("source", "instrument", { stripId: "shared-strip" }),
      track("shared-strip", "instrument", { plugins: [{ id: "slot", pluginId: "instrument", name: "Instrument", manufacturer: "Test",
        format: "VST3", instrument: true, bypassed: false, hasState: false, loadState: "loaded" }] })];
    state.songIndex = 0;
    state.songs = [{ ...song(), midiRegions: [{ id: "region", trackId: "source", name: "pattern", startBeats: 0, durationBeats: 4,
      clipOffsetBeats: 0, loop: false, loopLengthBeats: 4, muted: true,
      notes: [{ id: 1, pitch: 60, channel: 0, startBeats: 0, durationBeats: 1, velocity: 1, releaseVelocity: 0, probability: 1 }] }] }];
    const model = buildSignalFlowModel(graphFor(state.tracks), state);
    expect(model.strips.find((node) => node.id === "shared-strip")).toHaveProperty("trackIndex", 2);
    expect(model.edges.find((edge) => edge.from === "midi::regions")).toMatchObject({ to: "shared-strip", active: false });
    const region = state.songs[0].midiRegions![0];
    region.notes = [];
    region.automationLanes = [{ id: "lane", scope: "region", enabled: true, muted: false, writeMode: "read",
      target: { domain: "plugin", entityId: "slot", parameterId: "param:0", valueType: "floatNormalized", defaultValue: 0, minValue: 0, maxValue: 1 },
      points: [{ timeBeats: 0, value: 0.5, curve: 0 }] }];
    expect(buildSignalFlowModel(graphFor(state.tracks), state).edges.some((edge) => edge.from === "midi::regions")).toBe(false);
    region.automationLanes[0].target.domain = "midiCC";
    region.automationLanes[0].target.parameterId = "cc:1";
    expect(buildSignalFlowModel(graphFor(state.tracks), state).edges.find((edge) => edge.from === "midi::regions"))
      .toMatchObject({ to: "shared-strip", active: false });
    state.songIndex = -1;
    expect(buildSignalFlowModel(graphFor(state.tracks), state).edges.some((edge) => edge.from === "midi::regions")).toBe(false);
  });

  it("adds enabled song CC/pitch-bend automation without treating plug-in parameters as MIDI", () => {
    const state = structuredClone(emptyState);
    state.tracks = [track("external", "externalMidi")];
    state.songIndex = 0;
    state.songs = [{ ...song(), automationLanes: [{ id: "lane", scope: "track", enabled: true, muted: false, writeMode: "read",
      target: { domain: "midiCC", entityId: "external", parameterId: "pitchBend", valueType: "integer", defaultValue: 0, minValue: -8192, maxValue: 8191 },
      points: [{ timeBeats: 0, value: 0, curve: 0 }] }] }];
    expect(buildSignalFlowModel(graphFor(state.tracks), state).edges.find((edge) => edge.from === "midi::automation"))
      .toMatchObject({ to: "external", protocol: "midi", active: true });
    state.songs[0].automationLanes![0].muted = true;
    expect(buildSignalFlowModel(graphFor(state.tracks), state).strips.some((node) => node.id === "midi::automation")).toBe(false);
  });
});
