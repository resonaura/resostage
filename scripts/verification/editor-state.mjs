/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/** Actual HTTP/Core/history/save/reopen acceptance, not a mock server.
 * Stop other Core instances before running (JUCE single-instance ownership).
 * Only this fixture's temporary settings/project are mutated; MIDI IO is off.
 */
export async function verifyEditorState(coreExecutable, inspect) {
  const temp = mkdtempSync(join(tmpdir(), "resostage-editor-state-"));
  const project = join(temp, "Fixture.rsnraset");
  const metadataPath = join(project, "project.rsnrasetmeta");
  const settingsPath = join(temp, "settings.json");
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const origin = `http://127.0.0.1:${port}`;
  let child, exited = true, diagnostic = "";
  const output = { type: "main", target: "audio::main", sends: [] };
  const regionId = "midi::region:fixture";
  mkdirSync(project);
  writeFileSync(settingsPath, JSON.stringify({ audioInputDisabled: true, inputDeviceName: "",
    midiInputNames: [], midiOutputNames: [], recentProjects: [] }));
  writeFileSync(metadataPath, JSON.stringify({ format: { version: 10 }, name: "Editor State Acceptance", sampleRate: 48000,
    tracks: [{ id: "audio::track:1", name: "Fixture MIDI", kind: "externalMidi", channels: 2,
      gainDb: 0, pan: 0, mute: false, solo: false, output }], sends: [],
    main: { enabled: true, name: "Main", channels: 2, gainDb: 0, pan: 0, mute: false,
      solo: false, output: { type: "ext-out", target: "audio::out:1,audio::out:2" } },
    click: { enabled: false, soloSafe: true, channels: 2, gainDb: 0, pan: 0, output },
    songs: [{ id: "meta::song:1", name: "Fixture", bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 }, endSeconds: 90, onEnded: "stop", regions: [], events: [],
      midiRegions: [{ id: regionId, trackId: "audio::track:1", name: "Pattern", startBeats: 0,
        durationBeats: 160, clipOffsetBeats: 0, loop: false, loopLengthBeats: 160, loopStartBeats: 0, notes: [] }] }] }));

  const request = async (path, body) => {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(8000),
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}`);
    return JSON.parse(text);
  };
  const waitFor = async (predicate, description) => {
    for (let attempt = 0; attempt < 160; ++attempt) {
      if (exited) throw new Error(`Core exited during ${description}\n${diagnostic}`);
      try {
        const state = await request("/api/v1/state");
        if (predicate(state)) return state;
      } catch (error) { if (attempt === 159) throw error; }
      await sleep(50);
    }
    throw new Error(`No authoritative confirmation: ${description}\n${diagnostic}`);
  };
  const stopCore = async () => {
    if (!child || exited) return;
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 50 && !exited; ++attempt) await sleep(100);
    if (!exited) child.kill("SIGKILL");
    if (!exited) await new Promise((done) => child.once("exit", done));
  };
  const startCore = async () => {
    exited = false;
    child = spawn(coreExecutable, [`--backend-port=${port}`, "--no-discovery", project], {
      cwd: temp, env: { ...process.env, RESOSTAGE_SETTINGS_FILE: settingsPath, RESOSTAGE_SPAWNED_BY_SHELL: "1" },
      stdio: ["ignore", "pipe", "pipe"] });
    child.once("exit", () => { exited = true; });
    child.on("error", (error) => { diagnostic += String(error); exited = true; });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { diagnostic = (diagnostic + data).slice(-16384); });
    // Save may canonicalize the document name to its package basename.
    await waitFor((state) => state.tracks?.some((track) => track.name === "Fixture MIDI"), "fixture load");
  };
  const getRegion = (state) => state.songs?.[0]?.midiRegions?.find((region) => region.id === regionId);
  try {
    await startCore();
    const notes = Array.from({ length: 512 }, (_, index) => ({ id: index + 1, pitch: 48 + index % 24,
      startBeats: index * 0.125 + 0.03, durationBeats: 0.22, velocity: 0.8, releaseVelocity: 0.5, probability: 1 }));
    const patch = { songIndex: 0, regionId, notes };
    assert.ok(Buffer.byteLength(JSON.stringify(patch)) > 4096);
    await request("/api/v1/builder/midi-region/update", patch);
    await waitFor((state) => getRegion(state)?.notes.length === notes.length, "large note update");

    const quantized = notes.map((note) => ({ ...note,
      startBeats: Math.round(note.startBeats * 2) / 2, durationBeats: 0.5 }));
    await request("/api/v1/transport/play", {});
    const playing = await waitFor((state) => state.playing, "Play");
    await request("/api/v1/builder/midi-region/update", { ...patch, notes: quantized });
    const liveEdited = await waitFor((state) => getRegion(state)?.notes.every((note) => note.durationBeats === 0.5), "quantize while playing");
    assert.equal(liveEdited.playing, true, "Note edit must not stop transport");
    await waitFor((state) => state.playing && state.playheadSeconds > playing.playheadSeconds, "continuous transport after edit");
    await request("/api/v1/transport/stop", {});
    await waitFor((state) => !state.playing, "Stop");

    await request("/api/v1/timeline/undo", {});
    await waitFor((state) => getRegion(state)?.notes.every((note) => Math.abs(note.durationBeats - 0.22) < 1e-6), "Undo note edit");
    await request("/api/v1/timeline/redo", {});
    await waitFor((state) => getRegion(state)?.notes.every((note) => note.durationBeats === 0.5), "Redo note edit");

    await request("/api/v1/builder/automation-lane/add", { songIndex: 0, domain: "midiCC", entityId: "audio::track:1",
      parameterId: "cc:1", valueType: "integer", defaultValue: 0, minValue: 0, maxValue: 127, points: [] });
    let state = await waitFor((current) => current.songs?.[0]?.automationLanes?.length === 1, "empty automation creation");
    const lane = state.songs[0].automationLanes[0];
    assert.deepEqual(lane.points, [], "Empty lane must not fabricate points");
    const points = Array.from({ length: 512 }, (_, index) => ({ timeBeats: index / 4, value: index % 128, curve: 0.4 }));
    await request("/api/v1/builder/automation-points/replace", { songIndex: 0, laneId: lane.id, points });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.[0]?.points.length === points.length, "large curve-preserving point replacement");
    assert.ok(state.songs[0].automationLanes[0].points.every((point) => Math.abs(point.curve - 0.4) < 1e-6));

    const rejected = await fetch(origin + "/api/v1/transport/play", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(65536) }), signal: AbortSignal.timeout(8000) });
    assert.equal(rejected.status, 413);
    assert.ok((await rejected.text()).includes("bounded payload limit"));
    state = await request("/api/v1/state");
    assert.equal(state.playing, false, "Rejected scalar command must not execute");

    await request("/api/v1/project/save", {});
    for (let attempt = 0; attempt < 100; ++attempt) {
      const saved = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (saved.songs?.[0]?.midiRegions?.[0]?.notes.length === notes.length && saved.songs[0].automationLanes?.[0]?.points.length === points.length) break;
      if (attempt === 99) throw new Error("Project save did not persist edited collections");
      await sleep(50);
    }
    await stopCore();
    await startCore();
    state = await request("/api/v1/state");
    assert.equal(getRegion(state).notes.length, notes.length);
    assert.ok(getRegion(state).notes.every((note) => note.durationBeats === 0.5 && note.startBeats % 0.5 === 0));
    assert.equal(state.songs[0].automationLanes[0].points.length, points.length);
    if (inspect) await inspect(origin);
    console.log("PASS: large MIDI/automation HTTP edits, live transport continuity, Undo/Redo,413, save/reopen");
  } finally {
    await stopCore();
    // Only the exact mkdtemp-created private fixture is ever removed.
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "Usage: node scripts/verification/editor-state.mjs /absolute/path/to/Core");
  await verifyEditorState(resolve(process.argv[2]));
}
