/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  let commandState = null;
  const output = { type: "main", target: "audio::main", sends: [{ bus: "audio::send:1", level: 100, enabled: true }] };
  const regionId = "midi::region:fixture";
  mkdirSync(project);
  writeFileSync(settingsPath, JSON.stringify({ audioInputDisabled: true, inputDeviceName: "",
    midiInputNames: [], midiOutputNames: [], recentProjects: [] }));
  writeFileSync(metadataPath, JSON.stringify({ format: { version: 10 }, name: "Editor State Acceptance", sampleRate: 48000,
    tracks: [{ id: "audio::track:1", name: "Fixture MIDI", kind: "externalMidi", channels: 2,
      gainDb: 0, pan: 0, mute: false, solo: false, output }],
    sends: [{ id: "audio::send:1", name: "Reverb", channels: 2, gainDb: 0, pan: 0, mute: false, solo: false,
      output: { type: "ext-out", target: "audio::out:1,audio::out:2" } }],
    main: { enabled: true, name: "Main", channels: 2, gainDb: 0, pan: 0, mute: false,
      solo: false, output: { type: "ext-out", target: "audio::out:1,audio::out:2" } },
    click: { enabled: false, soloSafe: true, channels: 2, gainDb: 0, pan: 0, output: { type: "main", target: "audio::main", sends: [] } },
    songs: [{ id: "meta::song:1", name: "Fixture", bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 }, endSeconds: 90, onEnded: "stop", regions: [], events: [],
      midiRegions: [{ id: regionId, trackId: "audio::track:1", name: "Pattern", startBeats: 0,
        durationBeats: 160, clipOffsetBeats: 0, loop: false, loopLengthBeats: 160, loopStartBeats: 0, notes: [] }] }] }));

  const request = async (path, body, extraHeaders = {}) => {
    const identityHeaders = body !== undefined && commandState?.stateSessionId
      && Number.isSafeInteger(commandState.projectEpoch)
      ? {
          "X-ResoStage-Session": commandState.stateSessionId,
          "X-ResoStage-Project-Epoch": String(commandState.projectEpoch),
        }
      : {};
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(8000),
      ...(body === undefined ? {} : { method: "POST", headers: {
        "Content-Type": "application/json", ...identityHeaders, ...extraHeaders,
      }, body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}`);
    return JSON.parse(text);
  };
  const waitFor = async (predicate, description) => {
    for (let attempt = 0; attempt < 160; ++attempt) {
      if (exited) throw new Error(`Core exited during ${description}\n${diagnostic}`);
      try {
        const state = await request("/api/v1/state");
        commandState = state;
        if (predicate(state)) return state;
      } catch (error) { if (attempt === 159) throw error; }
      await sleep(50);
    }
    throw new Error(`No authoritative confirmation: ${description}\n${diagnostic}`);
  };
  const confirmEditorMutation = async (path, body, applied = true, extraHeaders = {}) => {
    const expectedEpoch = commandState?.projectEpoch;
    const accepted = await request(path, body, extraHeaders);
    assert.ok(Number.isSafeInteger(accepted.requestId), `${path} must return an exact request ID`);
    const state = await waitFor((snapshot) => snapshot.editorCommandResults?.some(
      (result) => result.requestId === accepted.requestId,
    ), `${path} exact editor-command acknowledgement`);
    const result = state.editorCommandResults.find((entry) => entry.requestId === accepted.requestId);
    assert.equal(result.applied, applied, `${path} applied status`);
    assert.ok(Number.isSafeInteger(result.projectRevision), `${path} must return a project revision`);
    assert.equal(result.projectRevision, state.stateRevision, `${path} result and snapshot are atomic`);
    if (applied) {
      assert.equal(result.projectEpoch, expectedEpoch, `${path} must stay in its captured project epoch`);
      assert.equal(state.projectEpoch, expectedEpoch, `${path} snapshot must stay in its captured project epoch`);
    }
    return { state, result, accepted };
  };
  const confirmHistory = async (direction, applied) => {
    const accepted = await request(`/api/v1/timeline/${direction}`, {});
    assert.ok(Number.isSafeInteger(accepted.historyRequestId), `${direction} must return a request ID`);
    const state = await waitFor((snapshot) => snapshot.historyResults?.some(
      (result) => result.requestId === accepted.historyRequestId && result.applied === applied,
    ), `${direction} exact applied=${applied} acknowledgement`);
    const result = state.historyResults.find((entry) => entry.requestId === accepted.historyRequestId);
    assert.ok(Number.isSafeInteger(result.projectRevision), `${direction} must return a project revision`);
    assert.ok(result.projectRevision <= state.stateRevision, `${direction} result cannot exceed snapshot revision`);
    return state;
  };
  const stopCore = async () => {
    if (!child || exited) return;
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 50 && !exited; ++attempt) await sleep(100);
    if (!exited) child.kill("SIGKILL");
    if (!exited) await new Promise((done) => child.once("exit", done));
  };
  const startCore = async () => {
    commandState = null;
    exited = false;
    child = spawn(coreExecutable, [`--backend-port=${port}`, "--no-discovery", project], {
      cwd: temp, env: { ...process.env, RESOSTAGE_SETTINGS_FILE: settingsPath, RESOSTAGE_SPAWNED_BY_SHELL: "1" },
      stdio: ["ignore", "pipe", "pipe"] });
    child.once("exit", () => { exited = true; });
    child.on("error", (error) => { diagnostic += String(error); exited = true; });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { diagnostic = (diagnostic + data).slice(-16384); });
    // Save may canonicalize the document name to its package basename. Core
    // can finish deferred launch/open delivery after its first full snapshot;
    // do not issue fixture edits until the published project identity settles.
    await waitFor((state) => state.projectEpoch > 0
      && !state.busy && state.tracks?.some((track) => track.name === "Fixture MIDI"), "fixture load and project identity");
    let stableEpoch = commandState.projectEpoch;
    let stableSamples = 0;
    for (let attempt = 0; attempt < 100 && stableSamples < 8; ++attempt) {
      const state = await request("/api/v1/state");
      commandState = state;
      if (state.projectEpoch === stableEpoch && !state.busy
        && state.tracks?.some((track) => track.name === "Fixture MIDI")) {
        ++stableSamples;
      } else {
        stableEpoch = state.projectEpoch;
        stableSamples = 0;
      }
      await sleep(100);
    }
    assert.equal(stableSamples, 8, `project epoch must settle before editing\n${diagnostic}`);
  };
  const getRegion = (state) => state.songs?.[0]?.midiRegions?.find((region) => region.id === regionId);
  try {
    await startCore();
    const noOpUndo = await confirmHistory("undo", false);
    assert.equal(noOpUndo.historyResults.at(-1)?.error, "Nothing to undo");

    const notes = Array.from({ length: 512 }, (_, index) => ({ id: index + 1, pitch: 48 + index % 24,
      startBeats: index * 0.125 + 0.03, durationBeats: 0.22, velocity: 0.8, releaseVelocity: 0.5, probability: 1 }));
    const patch = { songIndex: 0, regionId, notes };
    assert.ok(Buffer.byteLength(JSON.stringify(patch)) > 4096);
    const initialMidiEdit = await confirmEditorMutation("/api/v1/builder/midi-region/update", patch);
    assert.equal(getRegion(initialMidiEdit.state)?.notes.length, notes.length, "large note update");

    const quantized = notes.map((note) => ({ ...note,
      startBeats: Math.round(note.startBeats * 2) / 2, durationBeats: 0.5 }));
    await request("/api/v1/transport/play", {});
    const playing = await waitFor((state) => state.playing, "Play");
    const liveEditedResult = await confirmEditorMutation("/api/v1/builder/midi-region/update", { ...patch, notes: quantized });
    const liveEdited = liveEditedResult.state;
    assert.ok(getRegion(liveEdited)?.notes.every((note) => note.durationBeats === 0.5), "quantize while playing");
    assert.equal(liveEdited.playing, true, "Note edit must not stop transport");
    await waitFor((state) => state.playing && state.playheadSeconds > playing.playheadSeconds, "continuous transport after edit");

    // Exercise actual history dispatch while playing too. This checks
    // authoritative notes and transport intent, not acoustic continuity.
    const liveUndo = await confirmHistory("undo", true);
    assert.ok(getRegion(liveUndo)?.notes.every((note) => Math.abs(note.durationBeats - 0.22) < 1e-6),
      "Undo while playing must restore the prior note durations");
    assert.equal(liveUndo.playing, true, "Undo must not stop transport");
    const liveRedo = await confirmHistory("redo", true);
    assert.ok(getRegion(liveRedo)?.notes.every((note) => note.durationBeats === 0.5),
      "Redo while playing must restore the quantized durations");
    assert.equal(liveRedo.playing, true, "Redo must not stop transport");
    await request("/api/v1/transport/stop", {});
    await waitFor((state) => !state.playing, "Stop");

    const noteUndo = await confirmHistory("undo", true);
    assert.ok(getRegion(noteUndo)?.notes.every((note) => Math.abs(note.durationBeats - 0.22) < 1e-6),
      "Undo note edit must restore the prior note durations");
    const noteRedo = await confirmHistory("redo", true);
    assert.ok(getRegion(noteRedo)?.notes.every((note) => note.durationBeats === 0.5),
      "Redo note edit must restore the quantized durations");

    const laneCreation = await confirmEditorMutation("/api/v1/builder/automation-lane/add", {
      songIndex: 0, domain: "midiCC", entityId: "audio::track:1",
      parameterId: "cc:1", valueType: "integer", defaultValue: 0, minValue: 0, maxValue: 127, points: [],
    });
    let state = laneCreation.state;
    const lane = state.songs[0].automationLanes[0];
    assert.deepEqual(lane.points, [], "Empty lane must not fabricate points");
    const points = Array.from({ length: 512 }, (_, index) => ({ timeBeats: index / 4, value: index % 128, curve: 0.4 }));
    const pointReplacement = await confirmEditorMutation("/api/v1/builder/automation-points/replace", {
      songIndex: 0, laneId: lane.id, points,
    });
    state = pointReplacement.state;
    assert.ok(state.songs[0].automationLanes[0].points.every((point) => Math.abs(point.curve - 0.4) < 1e-6));

    // Strip fader gain and pan automation live during playback
    await request("/api/v1/transport/play", {});
    const playingStrip = await waitFor((s) => s.playing, "Play for strip automation");
    await request("/api/v1/builder/automation-lane/add", { songIndex: 0, domain: "strip", entityId: "audio::track:1",
      parameterId: "faderGainDb", valueType: "decibels", defaultValue: 0, minValue: -60, maxValue: 12, points: [] });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.length === 2, "strip fader gain lane creation");
    const faderLane = state.songs[0].automationLanes[1];
    assert.equal(faderLane.target.parameterId, "faderGainDb");
    const faderPoints = [
      { timeBeats: 0, value: 0, curve: 0 },
      { timeBeats: 4, value: -6, curve: 0.5 },
      { timeBeats: 8, value: -18, curve: -0.5 },
    ];
    await request("/api/v1/builder/automation-points/replace", { songIndex: 0, laneId: faderLane.id, points: faderPoints });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.[1]?.points.length === 3, "strip fader points replacement");
    assert.equal(state.playing, true, "Strip automation edit must not stop playback");
    assert.ok(state.playheadSeconds > playingStrip.playheadSeconds, "Transport continuously advances through strip automation edit");

    // Live Touch gesture recording while playing
    await request("/api/v1/builder/automation-lane/update", { songIndex: 0, laneId: faderLane.id, writeMode: "touch" });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.[1]?.writeMode === "touch", "set writeMode to touch");
    assert.equal(state.playing, true, "Mode change must not interrupt playback");

    const beforeInvalidGesture = state.songs[0].automationLanes[1].points;
    await request("/api/v1/builder/automation/record-gesture", {
      songIndex: 0, laneId: faderLane.id, punchInBeats: 4, releaseBeats: 6, releaseValue: -12,
      points: [{ timeBeats: 3, value: -6 }],
    });
    state = await waitFor((current) => current.statusMessage?.includes("Recorded automation points must stay inside"), "recording pass rejection after admission");
    assert.deepEqual(state.songs[0].automationLanes[1].points, beforeInvalidGesture,
      "Rejected recording must leave the complete envelope intact");
    assert.equal(state.songs[0].automationLanes[1].writeMode, "touch");
    assert.equal(state.playing, true, "Rejected recording must not stop transport");

    await request("/api/v1/builder/automation/record-gesture", {
      songIndex: 0,
      laneId: faderLane.id,
      punchInBeats: 4,
      releaseBeats: 6,
      releaseValue: -12,
      returnRampBeats: 1.0,
      underlyingValue: -6,
      points: [
        { timeBeats: 4, value: -6 },
        { timeBeats: 5, value: -9 },
        { timeBeats: 6, value: -12 },
      ],
    });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.[1]?.points.length >= 4, "punch live touch gesture");
    assert.equal(state.playing, true, "Live touch gesture must not stop playback");

    // Live Write mode safety auto-revert test
    await request("/api/v1/builder/automation-lane/update", { songIndex: 0, laneId: faderLane.id, writeMode: "write" });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.[1]?.writeMode === "write", "set writeMode to write");

    await request("/api/v1/builder/automation/record-gesture", {
      songIndex: 0,
      laneId: faderLane.id,
      punchInBeats: 10,
      releaseBeats: 12,
      releaseValue: -3,
      returnRampBeats: 0,
      underlyingValue: 0,
      points: [
        { timeBeats: 10, value: -6 },
        { timeBeats: 11, value: -4 },
        { timeBeats: 12, value: -3 },
      ],
    });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.[1]?.writeMode === "touch", "auto-revert writeMode to touch safety");
    assert.equal(state.playing, true, "Write recording must preserve playback");

    // Pan automation lane
    await request("/api/v1/builder/automation-lane/add", { songIndex: 0, domain: "strip", entityId: "audio::track:1",
      parameterId: "pan", valueType: "floatNormalized", defaultValue: 0, minValue: -1, maxValue: 1, points: [
        { timeBeats: 0, value: -0.5, curve: 0 },
        { timeBeats: 4, value: 0.5, curve: 0 },
      ] });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.length === 3, "strip pan lane creation");
    assert.equal(state.songs[0].automationLanes[2].target.parameterId, "pan");

    // Mute automation lane live during playback
    await request("/api/v1/builder/automation-lane/add", { songIndex: 0, domain: "strip", entityId: "audio::track:1",
      parameterId: "mute", valueType: "boolean", defaultValue: 0, minValue: 0, maxValue: 1, points: [
        { timeBeats: 0, value: 1, curve: 0 },
        { timeBeats: 4, value: 0, curve: 0 },
      ] });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.length === 4, "strip mute lane creation");
    assert.equal(state.songs[0].automationLanes[3].target.parameterId, "mute");
    assert.equal(state.playing, true, "Mute automation edit must not stop playback");

    // Aux send automation lane live during playback
    await request("/api/v1/builder/automation-lane/add", { songIndex: 0, domain: "strip", entityId: "audio::track:1",
      parameterId: "send:0", valueType: "floatNormalized", defaultValue: 1, minValue: 0, maxValue: 1, points: [
        { timeBeats: 0, value: 0.5, curve: 0 },
        { timeBeats: 4, value: 0.0, curve: 0 },
      ] });
    state = await waitFor((current) => current.songs?.[0]?.automationLanes?.length === 5, "strip send lane creation");
    assert.equal(state.songs[0].automationLanes[4].target.parameterId, "send:0");
    assert.equal(state.playing, true, "Send automation edit must not stop playback");

    await request("/api/v1/transport/stop", {});
    await waitFor((s) => !s.playing, "Stop after strip automation");

    const rejected = await fetch(origin + "/api/v1/transport/play", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(65536) }), signal: AbortSignal.timeout(8000) });
    assert.equal(rejected.status, 413);
    assert.ok((await rejected.text()).includes("bounded payload limit"));
    state = await request("/api/v1/state");
    commandState = state;
    assert.equal(state.playing, false, "Rejected scalar command must not execute");

    await request("/api/v1/project/save", {});
    for (let attempt = 0; attempt < 100; ++attempt) {
      const saved = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (saved.songs?.[0]?.midiRegions?.[0]?.notes.length === notes.length
          && saved.songs[0].automationLanes?.length === 5
          && saved.songs[0].automationLanes?.[0]?.points.length === points.length
          && saved.songs[0].automationLanes?.[1]?.points.length >= 5
          && saved.songs[0].automationLanes?.[1]?.writeMode === "touch"
          && saved.songs[0].automationLanes?.[2]?.points.length === 2
          && saved.songs[0].automationLanes?.[3]?.points.length === 2
          && saved.songs[0].automationLanes?.[4]?.points.length === 2) break;
      if (attempt === 99) throw new Error("Project save did not persist edited collections");
      await sleep(50);
    }
    await stopCore();
    await startCore();
    state = await request("/api/v1/state");
    assert.equal(getRegion(state).notes.length, notes.length);
    assert.ok(getRegion(state).notes.every((note) => note.durationBeats === 0.5 && note.startBeats % 0.5 === 0));
    assert.equal(state.songs[0].automationLanes[0].points.length, points.length);
    assert.equal(state.songs[0].automationLanes[1].target.parameterId, "faderGainDb");
    assert.ok(state.songs[0].automationLanes[1].points.length >= 5);
    assert.equal(state.songs[0].automationLanes[1].writeMode, "touch");
    assert.equal(state.songs[0].automationLanes[2].target.parameterId, "pan");
    assert.equal(state.songs[0].automationLanes[2].points.length, 2);
    assert.equal(state.songs[0].automationLanes[3].target.parameterId, "mute");
    assert.equal(state.songs[0].automationLanes[3].points.length, 2);
    assert.equal(state.songs[0].automationLanes[4].target.parameterId, "send:0");
    assert.equal(state.songs[0].automationLanes[4].points.length, 2);
    if (inspect) await inspect(origin);

    const oldIdentity = {
      stateSessionId: commandState.stateSessionId,
      projectEpoch: commandState.projectEpoch,
    };
    assert.ok(oldIdentity.stateSessionId && Number.isSafeInteger(oldIdentity.projectEpoch));
    const staleImportRequestId = randomUUID().replaceAll("-", "");
    await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "stale-project-import.wav", startSeconds: 0,
      requestId: staleImportRequestId,
    });
    await request("/api/v1/project/new", {});
    await waitFor((snapshot) => snapshot.projectEpoch !== oldIdentity.projectEpoch
      && snapshot.songs?.length === 1 && snapshot.songs[0]?.name === "New Song"
      && snapshot.tracks?.length > 0, "project epoch changes on replacement");
    const staleImportUpload = await fetch(
      `${origin}/api/v1/builder/track/import-wav/upload?requestId=${staleImportRequestId}`,
      {
        method: "POST",
        headers: {
          "X-ResoStage-Session": oldIdentity.stateSessionId,
          "X-ResoStage-Project-Epoch": String(oldIdentity.projectEpoch),
        },
        body: new Uint8Array([0, 1, 2, 3]),
      },
    );
    assert.ok(staleImportUpload.ok, `stale upload admission: ${staleImportUpload.status}`);
    let staleImportStatus;
    for (let attempt = 0; attempt < 160; ++attempt) {
      const result = await request(
        `/api/v1/builder/track/import-status?requestId=${staleImportRequestId}`,
      );
      if (result.finished) {
        staleImportStatus = result;
        break;
      }
      await sleep(50);
    }
    assert.ok(staleImportStatus, "stale media import rejection must settle");
    assert.equal(staleImportStatus.success, false);
    assert.match(staleImportStatus.error, /Project changed/);
    await request("/api/v1/builder/track/add", {
      kind: "instrument", name: "Epoch Fence Fixture", songIndex: 0,
    });
    const fencedProject = await waitFor((snapshot) => snapshot.tracks?.some(
      (track) => track.name === "Epoch Fence Fixture",
    ) && snapshot.songs?.[0]?.midiRegions?.length === 1, "new project's MIDI region");
    const fencedRegion = fencedProject.songs[0].midiRegions[0];
    const revisionBeforeStaleEdit = fencedProject.stateRevision;
    await request("/api/v1/project/new", {}, {
      "X-ResoStage-Session": oldIdentity.stateSessionId,
      "X-ResoStage-Project-Epoch": String(oldIdentity.projectEpoch),
    });
    await sleep(300);
    state = await request("/api/v1/state");
    commandState = state;
    assert.equal(state.projectEpoch, fencedProject.projectEpoch,
      "stale project replacement must not discard the current project");
    assert.ok(state.tracks?.some((track) => track.name === "Epoch Fence Fixture"),
      "stale project replacement must not erase current tracks");
    const staleEdit = await confirmEditorMutation("/api/v1/builder/midi-region/update", {
      songIndex: 0, regionId: fencedRegion.id, name: "Must Not Reach New Project",
    }, false, {
      "X-ResoStage-Session": oldIdentity.stateSessionId,
      "X-ResoStage-Project-Epoch": String(oldIdentity.projectEpoch),
    });
    assert.match(staleEdit.result.error, /Project changed/);
    assert.equal(staleEdit.state.stateRevision, revisionBeforeStaleEdit,
      "stale project edits must not create a history revision");
    assert.equal(staleEdit.state.songs[0].midiRegions[0].name, fencedRegion.name,
      "stale project edits must not mutate entities with reused/indexed targets");
    console.log("PASS: actual Core HTTP/state persistence, project-epoch fences for editor/media uploads, large note/point edits, active-playback Undo/Redo, automation recording and rejection, 413, save/reopen (not acoustic or UI manual-override proof)");
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
