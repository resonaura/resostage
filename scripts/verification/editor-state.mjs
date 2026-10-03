/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
  const audioFixture = join(temp, "fixture.wav");
  const importStressFixture = join(temp, "import-overlap.wav");
  const saveStressAsset = join(project, "Audio", "save-stress.bin");
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
  const wav = Buffer.alloc(46);
  wav.write("RIFF", 0); wav.writeUInt32LE(38, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(2, 40); wav.writeInt16LE(0, 44);
  writeFileSync(audioFixture, wav);
  // A long, valid PCM source makes the actual upload/peak-build/package-rewrite
  // window observable without relying on timing hooks or changing user files.
  const importDataBytes = 64 * 1024 * 1024;
  const importHeader = Buffer.alloc(44);
  importHeader.write("RIFF", 0);
  importHeader.writeUInt32LE(36 + importDataBytes, 4);
  importHeader.write("WAVEfmt ", 8);
  importHeader.writeUInt32LE(16, 16);
  importHeader.writeUInt16LE(1, 20);
  importHeader.writeUInt16LE(2, 22);
  importHeader.writeUInt32LE(48000, 24);
  importHeader.writeUInt32LE(192000, 28);
  importHeader.writeUInt16LE(4, 32);
  importHeader.writeUInt16LE(16, 34);
  importHeader.write("data", 36);
  importHeader.writeUInt32LE(importDataBytes, 40);
  const importFixtureFd = openSync(importStressFixture, "w");
  try {
    writeSync(importFixtureFd, importHeader);
    const zeroChunk = Buffer.alloc(1024 * 1024);
    for (let remaining = importDataBytes; remaining > 0; remaining -= zeroChunk.length)
      writeSync(importFixtureFd, zeroChunk, 0, Math.min(remaining, zeroChunk.length));
  } finally {
    closeSync(importFixtureFd);
  }
  // Make the real asynchronous package-save copy window observable without
  // changing project schema or touching any user data. ProjectLoader preserves
  // package resources even when the fixture does not reference this blob.
  mkdirSync(join(project, "Audio"));
  const stressAssetFd = openSync(saveStressAsset, "w");
  try {
    for (let chunk = 0; chunk < 64; ++chunk) {
      const bytes = randomBytes(1024 * 1024);
      let offset = 0;
      while (offset < bytes.length)
        offset += writeSync(stressAssetFd, bytes, offset, bytes.length - offset);
    }
  } finally {
    closeSync(stressAssetFd);
  }
  writeFileSync(metadataPath, JSON.stringify({ format: { version: 10 }, name: "Editor State Acceptance", sampleRate: 48000,
    tracks: [
      { id: "audio::track:1", name: "Fixture MIDI", kind: "externalMidi", channels: 2,
        gainDb: 0, pan: 0, mute: false, solo: false, output },
      { id: "audio::track:2", name: "Fixture Audio", kind: "audio", channels: 2,
        gainDb: 0, pan: 0, mute: false, solo: false, output },
    ],
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
  const postRaw = async (path, body) => fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const waitFor = async (predicate, description) => {
    let lastObserved = null;
    for (let attempt = 0; attempt < 160; ++attempt) {
      if (exited) throw new Error(`Core exited during ${description}\n${diagnostic}`);
      try {
        const state = await request("/api/v1/state");
        commandState = state;
        lastObserved = state;
        if (predicate(state)) return state;
      } catch (error) { if (attempt === 159) throw error; }
      await sleep(50);
    }
    const lastState = lastObserved ? JSON.stringify({
      playing: lastObserved.playing,
      playheadSamples: lastObserved.playheadSamples,
      playheadSeconds: lastObserved.playheadSeconds,
      cyclePassSequence: lastObserved.cyclePassSequence,
      songIndex: lastObserved.songIndex,
      projectEpoch: lastObserved.projectEpoch,
      stateRevision: lastObserved.stateRevision,
      playbackProjectRevision: lastObserved.playbackProjectRevision,
      sampleRate: lastObserved.sampleRate,
      audioCallbackCount: lastObserved.health?.audioCallbackCount,
      underrunCount: lastObserved.health?.underrunCount,
      silentBlockCount: lastObserved.health?.silentBlockCount,
      hardwareAlarm: lastObserved.hardwareAlarm,
      statusMessage: lastObserved.statusMessage,
    }) : "none";
    throw new Error(`No authoritative confirmation: ${description}\nLast state: ${lastState}\n${diagnostic}`);
  };
  const confirmEditorMutation = async (
    path, body, applied = true, extraHeaders = {}, expectedApplicationDomain = "audio",
  ) => {
    const expectedEpoch = commandState?.projectEpoch;
    const accepted = await request(path, body, extraHeaders);
    assert.ok(Number.isSafeInteger(accepted.requestId), `${path} must return an exact request ID`);
    const state = await waitFor((snapshot) => snapshot.editorCommandResults?.some(
      (result) => result.requestId === accepted.requestId,
    ), `${path} exact editor-command acknowledgement`);
    const result = state.editorCommandResults.find((entry) => entry.requestId === accepted.requestId);
    assert.equal(result.applied, applied, `${path} applied status`);
    assert.equal(result.applicationDomain, expectedApplicationDomain,
      `${path} must report the consumer domain that owns application`);
    assert.ok(Number.isSafeInteger(result.projectRevision), `${path} must return a project revision`);
    assert.equal(result.projectRevision, state.stateRevision, `${path} result and snapshot are atomic`);
    if (applied) {
      assert.equal(result.projectEpoch, expectedEpoch, `${path} must stay in its captured project epoch`);
      assert.equal(state.projectEpoch, expectedEpoch, `${path} snapshot must stay in its captured project epoch`);
      if (expectedApplicationDomain === "lighting") {
        assert.equal(result.lightingApplied, true,
          `${path} must publish the updated immutable project snapshot to LightEngine`);
      } else {
        assert.equal(result.playbackApplied, true,
          `${path} must publish its project revision for audio: ${JSON.stringify(result)}`);
        assert.ok(result.playbackRevision >= result.projectRevision,
          `${path} audio graph revision must include the edit`);
        assert.equal(result.playbackProjectEpoch, state.playbackProjectEpoch,
          `${path} graph epoch must match the exact result`);
        assert.ok(state.playbackProjectRevision >= result.projectRevision,
          `${path} state must expose an audio graph at least as new as the edit`);
      }
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
  const killCoreImmediately = async () => {
    if (!child || exited) return;
    child.kill("SIGKILL");
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
    // Core can publish the command-line document and then finish a queued
    // startup replacement shortly afterward. Require a sustained quiet window
    // so the harness never submits its first edit against an intermediate epoch.
    for (let attempt = 0; attempt < 150 && stableSamples < 20; ++attempt) {
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
    assert.equal(stableSamples, 20, `project epoch must settle before editing\n${diagnostic}`);
    if (process.env.RESOSTAGE_TEST_EXPECT_SNAPSHOT_FAILURE !== "1"
        && process.env.RESOSTAGE_TEST_PENDING_RESTART !== "1") {
      const testHookProbe = await fetch(`${origin}/api/v1/test/fail-next-playback-snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(8000),
      });
      await testHookProbe.arrayBuffer();
      assert.equal(testHookProbe.status, 404,
        "ordinary Core builds must not expose the snapshot-fault test route");
    }
    const parameterValueProbe = await fetch(
      `${origin}/api/v1/plugins/slot/parameter-values?slotId=acceptance-slot`,
      { signal: AbortSignal.timeout(8000) },
    );
    assert.equal(parameterValueProbe.status, 200,
      "Core must expose the compact plug-in parameter-value snapshot endpoint");
    const parameterValueSnapshot = await parameterValueProbe.json();
    assert.equal(parameterValueSnapshot.slotId, "acceptance-slot");
    assert.ok(Array.isArray(parameterValueSnapshot.values),
      "parameter-value telemetry must always return a bounded values array");
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

    const missingPluginEdit = await confirmEditorMutation(
      "/api/v1/plugins/slot/remove",
      { stripId: "audio::track:2", slotId: "missing-plugin-slot" },
      false,
    );
    assert.match(missingPluginEdit.result.error, /Project edit did not create a new revision|slot no longer exists/i,
      "a rejected plug-in slot mutation must settle its exact request instead of silently looking applied");

    const beforeInvalidEmbeddedAutomation = await request("/api/v1/state");
    commandState = beforeInvalidEmbeddedAutomation;
    const invalidEmbeddedAutomation = await fetch(`${origin}/api/v1/builder/midi-region/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ResoStage-Session": commandState.stateSessionId,
        "X-ResoStage-Project-Epoch": String(commandState.projectEpoch),
      },
      body: JSON.stringify({
        songIndex: 0,
        regionId,
        automationLanes: [{
          id: "lane::invalid",
          scope: "track",
          target: { domain: "midiCC", entityId: "audio::track:1", parameterId: "cc:1",
            valueType: "integer", defaultValue: 0, minValue: 0, maxValue: 127 },
          points: [{ timeBeats: 0, value: 64, curve: 1.25 }],
        }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const invalidAutomationBody = await invalidEmbeddedAutomation.text();
    assert.equal(invalidEmbeddedAutomation.status, 400,
      `invalid embedded automation must be rejected before enqueue: ${invalidAutomationBody}`);
    const invalidEmbeddedTarget = await fetch(`${origin}/api/v1/builder/midi-region/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ResoStage-Session": commandState.stateSessionId,
        "X-ResoStage-Project-Epoch": String(commandState.projectEpoch),
      },
      body: JSON.stringify({
        songIndex: 0,
        regionId,
        automationLanes: [{
          id: "lane::overflow-target",
          target: { domain: "midiCC", entityId: "audio::track:1", parameterId: "cc:1",
            defaultValue: 1e100, minValue: 0, maxValue: 127 },
          points: [],
        }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const invalidTargetBody = await invalidEmbeddedTarget.text();
    assert.equal(invalidEmbeddedTarget.status, 400,
      `float-overflow target metadata must be rejected before enqueue: ${invalidTargetBody}`);
    const afterInvalidEmbeddedAutomation = await request("/api/v1/state");
    commandState = afterInvalidEmbeddedAutomation;
    assert.equal(afterInvalidEmbeddedAutomation.stateRevision,
      beforeInvalidEmbeddedAutomation.stateRevision,
      "invalid embedded automation must not create a project-history revision");
    assert.deepEqual(getRegion(afterInvalidEmbeddedAutomation)?.automationLanes, [],
      "invalid embedded automation must leave the region unchanged");

    const validEmbeddedLane = {
      id: "lane::valid-midi-cc",
      scope: "track",
      target: { domain: "midiCC", entityId: "audio::track:1", parameterId: "cc:1",
        valueType: "integer", defaultValue: 0, minValue: 0, maxValue: 127 },
      points: [{ timeBeats: 0, value: 64, curve: 0.25 }],
    };
    const validEmbeddedAutomation = await confirmEditorMutation(
      "/api/v1/builder/midi-region/update", { songIndex: 0, regionId,
        automationLanes: [validEmbeddedLane] });
    assert.deepEqual(getRegion(validEmbeddedAutomation.state)?.automationLanes?.[0]?.points,
      validEmbeddedLane.points,
      "valid embedded region automation must survive parsing and reach the playback snapshot");

    const reorderedA = await request("/api/v1/builder/midi-region/update", {
      songIndex: 0, regionId, name: "Concurrent A",
    });
    const reorderedB = await request("/api/v1/builder/midi-region/update", {
      songIndex: 0, regionId, name: "Concurrent B",
    });
    assert.notEqual(reorderedA.requestId, reorderedB.requestId,
      "concurrent edits must receive distinct request identities");
    const concurrentState = await waitFor((snapshot) => {
      const ids = new Set(snapshot.editorCommandResults?.map((result) => result.requestId));
      return ids.has(reorderedA.requestId) && ids.has(reorderedB.requestId);
    }, "both concurrent editor transaction acknowledgements");
    const reorderedResults = [reorderedA, reorderedB].map((accepted) =>
      concurrentState.editorCommandResults.find((result) => result.requestId === accepted.requestId));
    assert.ok(reorderedResults.every((result) => result.applied && result.playbackApplied),
      "each concurrent request must report its own project and playback application");
    assert.notEqual(reorderedResults[0].projectRevision, reorderedResults[1].projectRevision,
      "separate edit transactions must retain their individual applied revisions");
    assert.ok(concurrentState.playbackProjectRevision >= Math.max(...reorderedResults.map((result) => result.projectRevision)),
      "the published graph must not lag either confirmed concurrent edit");

    const resultRingStartRevision = concurrentState.stateRevision;
    const ringRequestIds = [];
    for (let offset = 0; offset < 257; offset += 32) {
      const batchSize = Math.min(32, 257 - offset);
      const acceptedBatch = await Promise.all(Array.from({ length: batchSize }, (_, batchIndex) =>
        request("/api/v1/builder/midi-region/update", {
          songIndex: 0,
          regionId,
          name: `Result ring ${offset + batchIndex}`,
        })),
      );
      ringRequestIds.push(...acceptedBatch.map((accepted) => accepted.requestId));
      await waitFor((snapshot) =>
        snapshot.stateRevision >= resultRingStartRevision + ringRequestIds.length,
      `bounded-result-ring stress batch ${ringRequestIds.length}`);
    }
    const ringState = await waitFor((snapshot) =>
      snapshot.stateRevision >= resultRingStartRevision + ringRequestIds.length,
    "all bounded-result-ring stress edits");
    assert.equal(ringState.editorCommandResults.length, 256,
      "Core must retain only the bounded 256 latest editor outcomes");
    const retainedResultIds = new Set(ringState.editorCommandResults.map((result) => result.requestId));
    assert.ok(!retainedResultIds.has(Math.min(...ringRequestIds)),
      "the oldest exact result must be evicted instead of growing memory without bound");
    const oldestRingRequestId = Math.min(...ringRequestIds);
    assert.ok(ringRequestIds.filter((requestId) => requestId !== oldestRingRequestId)
      .every((requestId) => retainedResultIds.has(requestId)),
      "each non-evicted request must retain its own exact result");

    const addedMidi = await confirmEditorMutation("/api/v1/builder/midi-region/add", {
      songIndex: 0, trackId: "audio::track:1", name: "Temporary MIDI",
      startBeats: 0, durationBeats: 4, loopLengthBeats: 4,
      notes: [{ id: 9001, pitch: 60, startBeats: 0, durationBeats: 1, velocity: 0.8 }],
    });
    const temporaryMidi = addedMidi.state.songs[0].midiRegions.find((region) => region.name === "Temporary MIDI");
    assert.ok(temporaryMidi, "MIDI add must appear in the authoritative state");
    const removedMidi = await confirmEditorMutation("/api/v1/builder/midi-region/remove", {
      songIndex: 0, regionId: temporaryMidi.id,
    });
    assert.ok(!removedMidi.state.songs[0].midiRegions.some((region) => region.id === temporaryMidi.id),
      "MIDI remove must be applied before its exact ACK");
    const absentMidiRemoval = await confirmEditorMutation("/api/v1/builder/midi-region/remove", {
      songIndex: 0, regionId: temporaryMidi.id,
    }, false);
    assert.match(absentMidiRemoval.result.error, /did not create a new revision/,
      "an idempotent missing-region delete must be an explicit no-op outcome");

    const addedAudio = await confirmEditorMutation("/api/v1/builder/region/add", {
      songIndex: 0, trackId: "audio::track:2", file: audioFixture,
      startSeconds: 1, durationSeconds: 0.5,
    });
    const temporaryAudio = addedAudio.state.songs[0].regions.at(-1);
    assert.ok(temporaryAudio, "Audio region add must appear in the authoritative state");
    const updatedAudio = await confirmEditorMutation("/api/v1/builder/region/update", {
      songIndex: 0, regionId: temporaryAudio.id, startSeconds: 2,
    });
    assert.equal(updatedAudio.state.songs[0].regions.find((region) => region.id === temporaryAudio.id)?.startSeconds,
      2, "Audio region update must be applied before its exact ACK");
    const removedAudio = await confirmEditorMutation("/api/v1/builder/region/remove", {
      songIndex: 0, regionId: temporaryAudio.id,
    });
    assert.ok(!removedAudio.state.songs[0].regions.some((region) => region.id === temporaryAudio.id),
      "Audio region remove must be applied before its exact ACK");

    const invalidCycle = await confirmEditorMutation("/api/v1/builder/cycle/update", {
      songIndex: 99, active: true,
    }, false);
    assert.match(invalidCycle.result.error, /did not create a new revision/,
      "invalid cycle targets must be rejected without a fake history mutation");
    await confirmEditorMutation("/api/v1/builder/cycle/update", {
      songIndex: 0, active: true, leftSec: 1, rightSec: 8,
    });
    await confirmEditorMutation("/api/v1/builder/section/add", {
      songIndex: 0, startSeconds: 12, name: "Verse",
    });
    await confirmEditorMutation("/api/v1/builder/event/add", { songIndex: 0 });
    await confirmEditorMutation("/api/v1/builder/bus/add", {});
    await confirmEditorMutation("/api/v1/builder/song/end", {
      index: 0, endSeconds: 120,
    });

    const lightingConfig = await confirmEditorMutation("/api/v1/lighting/config", {
      idleIntensity: 0.73,
    }, true, {}, "lighting");
    assert.equal(lightingConfig.state.lighting.idle.intensity, 0.73,
      "lighting config mutation must be present in the authoritative state before its exact ACK");
    const firstFixture = await confirmEditorMutation("/api/v1/lighting/fixture/add", {
      name: "Acceptance Fixture A",
    }, true, {}, "lighting");
    const fixtureA = firstFixture.state.lighting.fixtures.find((fixture) => fixture.name === "Acceptance Fixture A");
    assert.ok(fixtureA, "lighting fixture add must appear before its exact ACK");
    const duplicateFixture = await confirmEditorMutation("/api/v1/lighting/fixture/duplicate", {
      fixtureId: fixtureA.id,
    }, true, {}, "lighting");
    const fixtureCopy = duplicateFixture.state.lighting.fixtures.find((fixture) => fixture.name === "Acceptance Fixture A Copy");
    assert.ok(fixtureCopy, "lighting fixture duplicate must appear before its exact ACK");
    const updatedFixture = await confirmEditorMutation("/api/v1/lighting/fixture/update", {
      fixtureId: fixtureCopy.id, name: "Acceptance Fixture B",
    }, true, {}, "lighting");
    assert.ok(updatedFixture.state.lighting.fixtures.some((fixture) => fixture.id === fixtureCopy.id
      && fixture.name === "Acceptance Fixture B"), "lighting fixture update must be authoritative");
    await confirmEditorMutation("/api/v1/lighting/fixture/remove", {
      fixtureId: fixtureCopy.id,
    }, true, {}, "lighting");
    const absentLightingFixture = await confirmEditorMutation("/api/v1/lighting/fixture/remove", {
      fixtureId: fixtureCopy.id,
    }, false, {}, "lighting");
    assert.match(absentLightingFixture.result.error, /did not create a new revision/,
      "removing an absent fixture must report an exact no-op outcome");

    const firstLightTrack = await confirmEditorMutation("/api/v1/lighting/track/add", {},
      true, {}, "lighting");
    const lightTrackA = firstLightTrack.state.lighting.tracks.at(-1);
    assert.ok(lightTrackA, "lighting track add must appear before its exact ACK");
    const updatedLightTrack = await confirmEditorMutation("/api/v1/lighting/track/update", {
      index: firstLightTrack.state.lighting.tracks.length - 1,
      name: "Acceptance Light Track A",
    }, true, {}, "lighting");
    const lightTrackAAfterUpdate = updatedLightTrack.state.lighting.tracks.find((track) => track.id === lightTrackA.id);
    assert.equal(lightTrackAAfterUpdate?.name, "Acceptance Light Track A",
      "lighting track update must be authoritative before its exact ACK");
    const secondLightTrack = await confirmEditorMutation("/api/v1/lighting/track/add", {},
      true, {}, "lighting");
    const lightTrackB = secondLightTrack.state.lighting.tracks.at(-1);
    assert.ok(lightTrackB, "second lighting track add must appear before its exact ACK");
    const movedLightTracks = await confirmEditorMutation("/api/v1/lighting/track/move", {
      index: secondLightTrack.state.lighting.tracks.length - 1, to: 0,
    }, true, {}, "lighting");
    assert.equal(movedLightTracks.state.lighting.tracks[0]?.id, lightTrackB.id,
      "lighting track reorder must be authoritative before its exact ACK");
    await confirmEditorMutation("/api/v1/lighting/track/remove", { index: 0 },
      true, {}, "lighting");
    const invalidLightTrackRemove = await confirmEditorMutation("/api/v1/lighting/track/remove", {
      index: 99,
    }, false, {}, "lighting");
    assert.match(invalidLightTrackRemove.result.error, /did not create a new revision/,
      "invalid lighting track removal must not report successful application");

    const addedLightCue = await confirmEditorMutation("/api/v1/lighting/cue/add", {
      songIndex: 0, trackId: lightTrackA.id, startSeconds: 4, durationSeconds: 2,
      label: "Acceptance Cue",
    }, true, {}, "lighting");
    const lightCue = addedLightCue.state.songs[0].lightCues.find((cue) => cue.label === "Acceptance Cue");
    assert.ok(lightCue, "lighting cue add must appear before its exact ACK");
    const updatedLightCue = await confirmEditorMutation("/api/v1/lighting/cue/update", {
      songIndex: 0, cueId: lightCue.id, intensity: 0.42,
    }, true, {}, "lighting");
    assert.equal(updatedLightCue.state.songs[0].lightCues.find((cue) => cue.id === lightCue.id)?.intensity,
      0.42, "lighting cue update must be authoritative before its exact ACK");
    await confirmEditorMutation("/api/v1/lighting/cue/remove", {
      songIndex: 0, cueId: lightCue.id,
    }, true, {}, "lighting");

    const preSaveState = await request("/api/v1/state");
    commandState = preSaveState;
    const preSaveMidiRegion = preSaveState.songs[0].midiRegions.find((region) => region.id === regionId);
    assert.ok(preSaveMidiRegion, "real-save overlap fixture MIDI region must exist");
    await request("/api/v1/project/save", {});
    let saveBusyState = null;
    for (let attempt = 0; attempt < 1000; ++attempt) {
      const snapshot = await request("/api/v1/state");
      commandState = snapshot;
      if (snapshot.busy) {
        saveBusyState = snapshot;
        break;
      }
      await sleep(5);
    }
    assert.ok(saveBusyState, `real project save must expose its background busy window\n${diagnostic}`);
    const saveDeferredEdit = await confirmEditorMutation("/api/v1/builder/midi-region/update", {
      songIndex: 0,
      regionId,
      name: "Deferred Across Real Save",
    });
    assert.equal(saveDeferredEdit.state.projectEpoch, saveBusyState.projectEpoch,
      "saving and reopening the same active document must preserve its project identity epoch");
    assert.equal(saveDeferredEdit.state.busy, false, "deferred edit must settle after the real save completes");
    assert.equal(saveDeferredEdit.state.songs[0].midiRegions.find((region) => region.id === regionId)?.name,
      "Deferred Across Real Save", "an edit admitted while save is busy must survive the package rewrite and apply to the same project");
    assert.equal(statSync(saveStressAsset).size, 64 * 1024 * 1024,
      "real save must preserve the fixture resource while reopening its project package");

    // Exercise the complete media-upload ticket and asynchronous import path.
    // The pre-existing 64 MiB project resource plus a real 64 MiB WAV makes
    // the package rewrite long enough to submit a normal editor command while
    // Core is genuinely busy; no test-only pause is involved.
    const importStartState = await request("/api/v1/state");
    commandState = importStartState;
    const importTrackIndex = importStartState.tracks.findIndex((track) => track.id === "audio::track:2");
    assert.ok(importTrackIndex >= 0, "real import overlap target audio track must exist");
    const importedIdsBefore = new Set(importStartState.songs[0].regions.map((region) => region.id));
    const importRequestId = randomUUID().replaceAll("-", "");
    await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0,
      index: importTrackIndex,
      fileName: "import-overlap.wav",
      startSeconds: 11,
      requestId: importRequestId,
    });
    const uploadResponse = await fetch(
      `${origin}/api/v1/builder/track/import-wav/upload?requestId=${importRequestId}`,
      {
        method: "POST",
        headers: {
          "X-ResoStage-Session": commandState.stateSessionId,
          "X-ResoStage-Project-Epoch": String(commandState.projectEpoch),
          "Content-Type": "application/octet-stream",
        },
        body: readFileSync(importStressFixture),
        signal: AbortSignal.timeout(30000),
      },
    );
    const uploadText = await uploadResponse.text();
    assert.ok(uploadResponse.ok, `real import upload: ${uploadResponse.status} ${uploadText}`);
    const importBusyState = await waitFor((snapshot) => snapshot.busy,
      "actual media import background conversion and package rewrite");
    const importedDeferredEdit = await confirmEditorMutation("/api/v1/builder/midi-region/update", {
      songIndex: 0,
      regionId,
      name: "Deferred Across Real Import",
    });
    assert.equal(importedDeferredEdit.state.projectEpoch, importBusyState.projectEpoch,
      "same-document media import must preserve project identity for deferred edits");
    assert.equal(importedDeferredEdit.state.busy, false,
      "deferred edit must settle only after import has reopened its package");
    assert.equal(importedDeferredEdit.state.songs[0].midiRegions.find((region) => region.id === regionId)?.name,
      "Deferred Across Real Import",
      "an edit accepted during real import must apply after the package rewrite, not be lost");
    let importStatus = null;
    for (let attempt = 0; attempt < 1800; ++attempt) {
      importStatus = await request(
        `/api/v1/builder/track/import-status?requestId=${importRequestId}`,
      );
      if (importStatus.finished) break;
      await sleep(50);
    }
    assert.ok(importStatus?.finished, "real media-import job must publish an exact terminal result");
    assert.equal(importStatus.success, true,
      `real media import must complete successfully: ${importStatus.error || "no error detail"}`);
    const importedState = await waitFor((snapshot) => snapshot.songs[0].regions.some(
      (region) => !importedIdsBefore.has(region.id),
    ), "new audio region from real async import");
    const importedRegion = importedState.songs[0].regions.find((region) => !importedIdsBefore.has(region.id));
    assert.equal(importedRegion.trackId, "audio::track:2");
    assert.equal(importedRegion.startSeconds, 11);
    assert.ok(importedRegion.durationSeconds > 300,
      "imported WAV duration and audio region must match the complete source file");
    assert.ok(importedState.songs[0].endSeconds >= 11 + importedRegion.durationSeconds,
      "importing media beyond the current song end must extend the song boundary");
    assert.equal(statSync(saveStressAsset).size, 64 * 1024 * 1024,
      "real import must preserve existing package resources when rewriting the project");

    const quantized = notes.map((note) => ({ ...note,
      startBeats: Math.round(note.startBeats * 2) / 2, durationBeats: 0.5 }));
    await request("/api/v1/transport/play", {});
    const playing = await waitFor((state) => state.playing, "Play");
    const liveEditedResult = await confirmEditorMutation("/api/v1/builder/midi-region/update", { ...patch, notes: quantized });
    const liveEdited = liveEditedResult.state;
    assert.ok(getRegion(liveEdited)?.notes.every((note) => note.durationBeats === 0.5), "quantize while playing");
    assert.equal(liveEdited.playing, true,
      `Note edit must not stop transport: ${JSON.stringify({
        startedAtSeconds: playing.playheadSeconds,
        observedAtSeconds: liveEdited.playheadSeconds,
        songEndSeconds: liveEdited.songs?.[0]?.endSeconds,
        commandResult: liveEditedResult.result,
        statusMessage: liveEdited.statusMessage,
      })}`);
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

    const lanePayload = {
      songIndex: 0, domain: "midiCC", entityId: "audio::track:1",
      parameterId: "cc:1", valueType: "integer", defaultValue: 0, minValue: 0, maxValue: 127, points: [],
    };
    let laneCreation;
    let state;
    if (process.env.RESOSTAGE_TEST_EXPECT_SNAPSHOT_FAILURE === "1") {
      const queueControl = async (action) => {
        const response = await postRaw("/api/v1/test/command-queue-control", { action });
        const text = await response.text();
        assert.equal(response.status, 200, `test command-queue ${action}: ${text}`);
        return JSON.parse(text);
      };
      const waitForQueueEmpty = async (description) => {
        for (let attempt = 0; attempt < 160; ++attempt) {
          const status = await queueControl("status");
          if (status.queuedCommands === 0) return status;
          await sleep(50);
        }
        assert.fail(`command queue did not drain: ${description}`);
      };
      const waitForDeferredCount = async (count) => {
        for (let attempt = 0; attempt < 160; ++attempt) {
          const status = await queueControl("status");
          if (count === 0
            ? status.deferredCommands === 0 && status.deferredBytes === 0
            : status.deferredCommands >= count) return status;
          await sleep(50);
        }
        assert.fail(`deferred queue did not reach ${count} commands`);
      };
      const queueBefore = await queueControl("pause");
      assert.equal(queueBefore.queuedCommands, 0, "test queue must be empty before saturation");
      for (let first = 0; first < 1024; first += 32) {
        const responses = await Promise.all(Array.from({ length: 32 }, () =>
          postRaw("/api/v1/test/command-queue-noop", {})));
        for (const response of responses) {
          const text = await response.text();
          assert.equal(response.status, 200, `command should be admitted while capacity remains: ${text}`);
        }
      }
      const fullQueue = await queueControl("status");
      assert.equal(fullQueue.queuedCommands, 1024,
        "all fixed command slots must be occupied before rejecting the next request");
      assert.equal(fullQueue.queuedBytes, 0,
        "empty saturation probes must not consume the payload byte budget");
      const rejectedQueueCommand = await postRaw("/api/v1/test/command-queue-noop", {});
      const rejectedQueueBody = await rejectedQueueCommand.text();
      assert.equal(rejectedQueueCommand.status, 503,
        `HTTP must explicitly reject a full queue, not acknowledge it: ${rejectedQueueBody}`);
      assert.match(rejectedQueueBody, /queue is full/i);
      await queueControl("resume");
      const drainedQueue = await waitForQueueEmpty("recovery after saturation");
      assert.equal(drainedQueue.queuedCommands, 0);
      const recoveredQueueCommand = await postRaw("/api/v1/test/command-queue-noop", {});
      const recoveredQueueBody = await recoveredQueueCommand.text();
      assert.equal(recoveredQueueCommand.status, 200,
        `commands must be admitted again after drain: ${recoveredQueueBody}`);
      await waitForQueueEmpty("post-recovery probe dequeue");

      const deferredBefore = await queueControl("status");
      assert.equal(deferredBefore.deferredCommands, 0,
        "deferred queue must be empty before its independent saturation test");
      await request("/api/v1/test/deferred-queue-hold", { hold: true });
      await waitFor((current) => current.statusMessage
        === "Test-only deferred command hold active", "deferred queue hold");
      const projectRevisionBeforeDeferredSaturation = commandState.stateRevision;
      for (let first = 0; first < 1024; first += 32) {
        const responses = await Promise.all(Array.from({ length: 32 }, () =>
          postRaw("/api/v1/test/deferred-queue-fill", {})));
        for (const response of responses) {
          const text = await response.text();
          assert.equal(response.status, 200, `deferred fill should be admitted: ${text}`);
        }
        await waitForDeferredCount(first + 32);
      }
      const fullDeferredQueue = await queueControl("status");
      assert.equal(fullDeferredQueue.deferredCommands, 1024,
        "all deferred-message slots must be occupied before probing overflow");
      assert.equal(fullDeferredQueue.deferredBytes, 2048,
        "the count-cap fixture must account each retained empty JSON body");
      const overflowProbeResponse = await postRaw("/api/v1/test/deferred-queue-probe", {});
      const overflowProbeBody = await overflowProbeResponse.text();
      assert.equal(overflowProbeResponse.status, 202,
        `deferred overflow probe must be admitted to Core first: ${overflowProbeBody}`);
      const overflowProbe = JSON.parse(overflowProbeBody);
      assert.ok(Number.isSafeInteger(overflowProbe.requestId),
        "deferred overflow probe must have an exact result ID");
      const overflowResultState = await waitFor((current) => current.editorCommandResults?.some(
        (result) => result.requestId === overflowProbe.requestId,
      ), "exact deferred queue overflow result");
      const overflowResult = overflowResultState.editorCommandResults.find(
        (result) => result.requestId === overflowProbe.requestId,
      );
      assert.equal(overflowResult.applied, false,
        "a request that cannot enter the deferred queue must not report application");
      assert.match(overflowResult.error, /Pending project command queue is full/,
        "the exact request result must carry the deferred-queue rejection reason");
      assert.equal(overflowResultState.stateRevision, projectRevisionBeforeDeferredSaturation,
        "queue overflow must not mutate project history");
      await request("/api/v1/test/deferred-queue-hold", { hold: false });
      await waitFor((current) => current.statusMessage
        === "Test-only deferred command hold released", "deferred queue release");
      await waitForDeferredCount(0);
      const recoveredProbeResponse = await postRaw("/api/v1/test/deferred-queue-probe", {});
      const recoveredProbeBody = await recoveredProbeResponse.text();
      assert.equal(recoveredProbeResponse.status, 202,
        `deferred queue must admit a request again after drain: ${recoveredProbeBody}`);
      const recoveredProbe = JSON.parse(recoveredProbeBody);
      const recoveredProbeState = await waitFor((current) => current.editorCommandResults?.some(
        (result) => result.requestId === recoveredProbe.requestId,
      ), "exact post-drain deferred probe result");
      const recoveredResult = recoveredProbeState.editorCommandResults.find(
        (result) => result.requestId === recoveredProbe.requestId,
      );
      assert.equal(recoveredResult.applied, false,
        "the non-mutating recovery probe must not invent a project edit");
      assert.doesNotMatch(recoveredResult.error, /queue is full/i,
        "deferred admission must recover after the held commands drain");

      await request("/api/v1/test/deferred-queue-hold", { hold: true });
      await waitFor((current) => current.statusMessage
        === "Test-only deferred command hold active", "deferred byte-limit hold");
      const projectRevisionBeforeDeferredByteSaturation = commandState.stateRevision;
      const fullSizePayload = { pad: "x".repeat(65_526) };
      assert.equal(Buffer.byteLength(JSON.stringify(fullSizePayload)), 65_536,
        "byte-limit probes must land exactly on the scalar HTTP body limit");
      for (let first = 0; first < 64; first += 8) {
        const responses = await Promise.all(Array.from({ length: 8 }, () =>
          postRaw("/api/v1/test/deferred-queue-fill", fullSizePayload)));
        for (const response of responses) {
          const text = await response.text();
          assert.equal(response.status, 200, `deferred byte fill should be admitted: ${text}`);
        }
        await waitForDeferredCount(first + 8);
      }
      const fullDeferredBytes = await queueControl("status");
      assert.equal(fullDeferredBytes.deferredCommands, 64,
        "the byte-cap fixture must retain exactly 64 maximum-size bodies");
      assert.equal(fullDeferredBytes.deferredBytes, 4 * 1024 * 1024,
        "the deferred byte budget must be filled exactly");
      const byteOverflowResponse = await postRaw("/api/v1/test/deferred-queue-probe", {});
      const byteOverflowBody = await byteOverflowResponse.text();
      assert.equal(byteOverflowResponse.status, 202,
        `deferred byte-overflow probe must be admitted to Core first: ${byteOverflowBody}`);
      const byteOverflowProbe = JSON.parse(byteOverflowBody);
      const byteOverflowState = await waitFor((current) => current.editorCommandResults?.some(
        (result) => result.requestId === byteOverflowProbe.requestId,
      ), "exact deferred byte-budget overflow result");
      const byteOverflowResult = byteOverflowState.editorCommandResults.find(
        (result) => result.requestId === byteOverflowProbe.requestId,
      );
      assert.equal(byteOverflowResult.applied, false);
      assert.match(byteOverflowResult.error, /Pending project command queue is full/);
      assert.equal(byteOverflowState.stateRevision, projectRevisionBeforeDeferredByteSaturation,
        "byte-budget rejection must not mutate project history");
      await request("/api/v1/test/deferred-queue-hold", { hold: false });
      await waitFor((current) => current.statusMessage
        === "Test-only deferred command hold released", "deferred byte-budget release");
      const drainedDeferredBytes = await waitForDeferredCount(0);
      assert.equal(drainedDeferredBytes.deferredBytes, 0,
        "deferred retained-byte accounting must return to zero after drain");
      const byteRecoveredProbeResponse = await postRaw("/api/v1/test/deferred-queue-probe", {});
      const byteRecoveredProbeBody = await byteRecoveredProbeResponse.text();
      assert.equal(byteRecoveredProbeResponse.status, 202,
        `deferred byte capacity must recover after drain: ${byteRecoveredProbeBody}`);
      const byteRecoveredProbe = JSON.parse(byteRecoveredProbeBody);
      const byteRecoveredState = await waitFor((current) => current.editorCommandResults?.some(
        (result) => result.requestId === byteRecoveredProbe.requestId,
      ), "exact deferred byte-capacity recovery result");
      const byteRecoveredResult = byteRecoveredState.editorCommandResults.find(
        (result) => result.requestId === byteRecoveredProbe.requestId,
      );
      assert.equal(byteRecoveredResult.applied, false);
      assert.doesNotMatch(byteRecoveredResult.error, /queue is full/i);

      await request("/api/v1/transport/stop", {});
      await waitFor((current) => !current.playing, "stop before cycle pass acceptance");
      await request("/api/v1/transport/seek", { seconds: 0 });
      await waitFor((current) => !current.playing && current.playheadSeconds < 0.02,
        "seek to project start before cycle pass acceptance");
      const shortCycle = await confirmEditorMutation("/api/v1/builder/cycle/update", {
        songIndex: 0, active: true, leftSec: 0.25, rightSec: 0.35,
      });
      const sequenceBeforeCycle = shortCycle.state.cyclePassSequence;
      await request("/api/v1/transport/play", {});
      await waitFor((current) => current.playing,
        "play before injected playback-snapshot failure");
      assert.equal(shortCycle.state.cyclePassSequence, sequenceBeforeCycle,
        "editing loop locators must not fabricate a completed pass");
      const completedCycle = await waitFor((current) => current.playing
        && current.cyclePassSequence > sequenceBeforeCycle,
      "Core-owned cycle pass sequence advances after a short loop wrap");
      await request("/api/v1/transport/stop", {});
      state = await waitFor((current) => !current.playing,
        "stop before cycle seek distinction check");
      const sequenceBeforeSeek = state.cyclePassSequence;
      await request("/api/v1/transport/seek", { seconds: 0.3 });
      state = await waitFor((current) => !current.playing
        && Math.abs(current.playheadSeconds - 0.3) < 0.02,
      "seek inside an enabled cycle");
      assert.equal(state.cyclePassSequence, sequenceBeforeSeek,
        "a transport seek must not be reported as a completed cycle pass");
      await confirmEditorMutation("/api/v1/builder/cycle/update", {
        songIndex: 0, active: false,
      });
      await request("/api/v1/transport/play", {});
      const beforeInjectedFailurePlayback = await waitFor((current) => current.playing,
        "resume playback before injected snapshot failure");
      assert.ok(beforeInjectedFailurePlayback.cyclePassSequence >= completedCycle.cyclePassSequence,
        "cycle pass telemetry must be monotonic across stop, seek, and restart");
      await request("/api/v1/test/fail-next-playback-snapshot", {});
      await waitFor((current) => current.statusMessage
        === "Test-only playback snapshot failure armed",
      "test-only snapshot failure arm");

      const acceptedFailure = await request("/api/v1/builder/automation-lane/add", lanePayload);
      assert.ok(Number.isSafeInteger(acceptedFailure.requestId),
        "injected-failure edit must return an exact request ID");
      const failedPublicationState = await waitFor((current) => current.editorCommandResults?.some(
        (result) => result.requestId === acceptedFailure.requestId,
      ), "exact editor result for injected playback-snapshot failure");
      const failedPublication = failedPublicationState.editorCommandResults.find(
        (result) => result.requestId === acceptedFailure.requestId,
      );
      assert.equal(failedPublication.applied, true,
        "snapshot failure must not misreport the committed project-history edit");
      assert.equal(failedPublication.playbackApplied, false,
        "snapshot failure must be explicit in the exact editor result");
      assert.match(failedPublication.error, /last valid snapshot/);
      assert.equal(failedPublication.playbackProjectEpoch,
        failedPublicationState.playbackProjectEpoch,
        "the failed result must identify the still-active graph epoch");
      assert.equal(failedPublication.playbackRevision,
        failedPublicationState.playbackProjectRevision,
        "the previous graph revision must remain published after the injected failure");
      assert.ok(failedPublication.playbackRevision < failedPublication.projectRevision,
        "the last-good graph must remain behind the committed project edit");
      assert.equal(failedPublicationState.playing, true,
        "snapshot preparation failure must not stop transport");
      assert.equal(failedPublicationState.songs[0].automationLanes.length, 1,
        "the committed project edit remains visible while audio uses its last-good graph");
      const failedStateProgress = await waitFor((current) => current.playing
        && current.playheadSeconds > failedPublicationState.playheadSeconds,
      "transport advances on the retained graph after snapshot failure");

      const recovered = await confirmEditorMutation("/api/v1/builder/automation-points/replace", {
        songIndex: 0,
        laneId: failedPublicationState.songs[0].automationLanes[0].id,
        points: [{ timeBeats: 0, value: 0, curve: 0 }],
      });
      assert.ok(recovered.result.playbackApplied,
        "the next valid publication must recover the graph from authoritative project state");
      assert.ok(recovered.state.playbackProjectRevision >= failedPublication.projectRevision,
        "recovery publication must include the edit whose first snapshot failed");
      assert.equal(recovered.state.playing, true,
        "transport must remain live through snapshot recovery");
      state = await waitFor((current) => current.playing
        && current.playheadSeconds > failedStateProgress.playheadSeconds,
      "audio sample clock advances through failed and recovered snapshot publication");
      assert.equal(typeof state.health?.audioCallbackCount, "number",
        "Core health must expose callback progress diagnostics during the scenario");
      laneCreation = { state: failedPublicationState, result: failedPublication, accepted: acceptedFailure };
    } else {
      laneCreation = await confirmEditorMutation("/api/v1/builder/automation-lane/add", lanePayload);
      state = laneCreation.state;
    }
    state = laneCreation.state;
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
    state = await waitFor((current) => current.playing
      && current.playheadSeconds > playingStrip.playheadSeconds,
    `transport advances through strip automation edit after ${playingStrip.playheadSeconds}s`);

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

    const cachedFaderCurve = structuredClone(state.songs[0].automationLanes[1].points);
    const panTarget = {
      domain: "strip", entityId: "audio::track:1", parameterId: "pan",
      valueType: "floatNormalized", defaultValue: 0, minValue: -1, maxValue: 1,
    };
    const reboundToPan = await confirmEditorMutation(
      "/api/v1/builder/automation-lane/update",
      { songIndex: 0, laneId: faderLane.id, target: panTarget },
    );
    state = reboundToPan.state;
    const reboundFader = state.songs[0].automationLanes.find((entry) => entry.id === faderLane.id);
    assert.equal(reboundFader.target.parameterId, "pan");
    assert.deepEqual(reboundFader.points, [],
      "an uncached destination parameter starts with an empty curve");

    const restoredFader = await confirmEditorMutation(
      "/api/v1/builder/automation-lane/update",
      { songIndex: 0, laneId: faderLane.id, target: {
        domain: "strip", entityId: "audio::track:1", parameterId: "faderGainDb",
        valueType: "decibels", defaultValue: 0, minValue: -60, maxValue: 12,
      } },
    );
    state = restoredFader.state;
    assert.deepEqual(
      state.songs[0].automationLanes.find((entry) => entry.id === faderLane.id).points,
      cachedFaderCurve,
      "rebinding to the previous parameter restores its exact curve from the project cache",
    );
    assert.equal(state.playing, true,
      "atomic lane target swaps preserve active transport");

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
    const preRestartIdentity = {
      stateSessionId: commandState.stateSessionId,
      projectEpoch: commandState.projectEpoch,
    };
    const firstEditorRequestId = initialMidiEdit.accepted.requestId;
    await stopCore();
    await startCore();
    state = await request("/api/v1/state");
    commandState = state;
    assert.notEqual(state.stateSessionId, preRestartIdentity.stateSessionId,
      "a Core restart must create a new command identity namespace");
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

    const revisionBeforeStaleRestartEdit = state.stateRevision;
    const nameBeforeStaleRestartEdit = getRegion(state).name;
    const staleRestartEdit = await fetch(origin + "/api/v1/builder/midi-region/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ResoStage-Session": preRestartIdentity.stateSessionId,
        "X-ResoStage-Project-Epoch": String(preRestartIdentity.projectEpoch),
      },
      body: JSON.stringify({ songIndex: 0, regionId, name: "Stale Core session command" }),
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(staleRestartEdit.status, 409,
      "a command from a dead Core session must be rejected before admission");
    state = await request("/api/v1/state");
    commandState = state;
    assert.equal(state.stateRevision, revisionBeforeStaleRestartEdit,
      "stale Core-session commands cannot mutate the reopened project");
    assert.equal(getRegion(state).name, nameBeforeStaleRestartEdit);

    const reusedIdEdit = await confirmEditorMutation("/api/v1/builder/midi-region/update", {
      songIndex: 0, regionId, name: "New Core session command",
    });
    assert.equal(reusedIdEdit.accepted.requestId, firstEditorRequestId,
      "request IDs may be reused after restart only within the new session namespace");
    assert.equal(getRegion(reusedIdEdit.state).name, "New Core session command");

    // Reopen the same package inside this still-running Core. Entity IDs are
    // intentionally stable across the reload, while project epoch must change.
    // Queue a mutation immediately before the reopen: its late result may still
    // arrive in the new state frame, but it must retain its old epoch and the
    // reloaded package contents must win over that transient in-memory edit.
    const persistedRegionName = JSON.parse(readFileSync(metadataPath, "utf8"))
      .songs[0].midiRegions.find((region) => region.id === regionId)?.name;
    assert.ok(persistedRegionName, "same-Core reopen fixture must have a saved MIDI region");
    const competingProject = join(temp, "Competing Project.rsnraset");
    mkdirSync(competingProject);
    const competingMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    competingMetadata.name = "Competing Project";
    writeFileSync(join(competingProject, "project.rsnrasetmeta"), JSON.stringify(competingMetadata));
    const beforeSameCoreReopen = await request("/api/v1/state");
    commandState = beforeSameCoreReopen;
    const lateAcceptedEdit = await request("/api/v1/builder/midi-region/update", {
      songIndex: 0, regionId, name: "Transient before same-Core reopen",
    });
    assert.ok(Number.isSafeInteger(lateAcceptedEdit.requestId),
      "same-Core late-response mutation must be accepted before project replacement");
    await request("/api/v1/project/open-recent", { path: project });
    const openPrompt = await waitFor((snapshot) => snapshot.openConfirmPending,
      "recent-project open must request an unsaved-changes decision");
    assert.equal(openPrompt.projectEpoch, beforeSameCoreReopen.projectEpoch,
      "the current project must remain authoritative until the user resolves the open prompt");
    assert.equal(getRegion(openPrompt).name, "Transient before same-Core reopen",
      "opening Recent must keep the unsaved in-memory edit visible while prompting");
    await request("/api/v1/project/open-recent", { path: competingProject });
    const stillPendingOpen = await waitFor((snapshot) => snapshot.openConfirmPending
      && snapshot.statusMessage?.includes("Resolve the current project-open prompt"),
    "a competing open request must be reported without replacing the pending target");
    assert.equal(stillPendingOpen.projectEpoch, beforeSameCoreReopen.projectEpoch,
      "a second open request must not replace the document while the first confirmation is pending");
    assert.equal(getRegion(stillPendingOpen).name, "Transient before same-Core reopen",
      "a second open request must preserve all current unsaved content");
    await request("/api/v1/project/open-decision", { index: 0 });
    const cancelledOpen = await waitFor((snapshot) => !snapshot.openConfirmPending,
      "cancel recent-project open");
    assert.equal(cancelledOpen.projectEpoch, beforeSameCoreReopen.projectEpoch,
      "cancelling a recent-project open must preserve the current project epoch");
    assert.equal(getRegion(cancelledOpen).name, "Transient before same-Core reopen",
      "cancelling a recent-project open must preserve unsaved project content");

    await request("/api/v1/project/save-as", {});
    const pendingSaveAs = await waitFor((snapshot) => snapshot.saveAsPending,
      "remote/native Save As must publish its pending callback state");
    await request("/api/v1/project/save-as", {});
    const duplicateSaveAs = await waitFor((snapshot) => snapshot.saveAsPending
      && snapshot.statusMessage?.startsWith("A Save As dialog is already pending"),
    "duplicate Save As must not replace the pending completion token");
    await request("/api/v1/action", { action: "cancel_save_as" });
    const cancelledSaveAs = await waitFor((snapshot) => !snapshot.saveAsPending,
      "cancel Save As after controller-side export");
    assert.equal(cancelledSaveAs.projectEpoch, pendingSaveAs.projectEpoch,
      "settling a Save As dialog must not replace the active project");
    assert.equal(duplicateSaveAs.projectEpoch, pendingSaveAs.projectEpoch,
      "duplicate Save As must remain within the active project");

    const malformedProjectUpload = Buffer.from("not a ResoStage project container");
    const postMalformedProjectUpload = async () => {
      const response = await fetch(origin + "/api/v1/project/upload", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: malformedProjectUpload,
        signal: AbortSignal.timeout(8000),
      });
      const responseBody = await response.text();
      assert.ok(response.ok, `project upload admission: ${response.status} ${responseBody}`);
    };
    await postMalformedProjectUpload();
    const uploadOpenPrompt = await waitFor((snapshot) => snapshot.openConfirmPending,
      "browser project upload must ask before replacing unsaved content");
    assert.equal(uploadOpenPrompt.projectEpoch, beforeSameCoreReopen.projectEpoch,
      "browser upload must not replace the current project before a decision");
    assert.equal(getRegion(uploadOpenPrompt).name, "Transient before same-Core reopen",
      "browser upload prompt must preserve the current unsaved edit");
    await request("/api/v1/project/open-decision", { index: 0 });
    const cancelledUpload = await waitFor((snapshot) => !snapshot.openConfirmPending,
      "cancel browser project upload");
    assert.equal(cancelledUpload.projectEpoch, beforeSameCoreReopen.projectEpoch,
      "cancelling a browser upload must keep the current project identity");
    assert.equal(getRegion(cancelledUpload).name, "Transient before same-Core reopen",
      "cancelling a browser upload must preserve all unsaved content");

    await postMalformedProjectUpload();
    const rejectedUploadPrompt = await waitFor((snapshot) => snapshot.openConfirmPending,
      "second malformed upload must still use the guarded project-open path");
    assert.equal(rejectedUploadPrompt.projectEpoch, beforeSameCoreReopen.projectEpoch);
    await request("/api/v1/project/open-recent", { path: project });
    const competingOpen = await waitFor((snapshot) => snapshot.openConfirmPending
      && snapshot.statusMessage?.startsWith("Resolve the current project-open prompt"),
    "a competing recent open must not retarget a pending upload confirmation");
    assert.equal(competingOpen.projectEpoch, beforeSameCoreReopen.projectEpoch,
      "a competing open must leave the current project unchanged while the upload decision is pending");
    await request("/api/v1/project/open-decision", { index: 2 });
    const rejectedUpload = await waitFor((snapshot) => !snapshot.openConfirmPending
      && snapshot.statusMessage?.startsWith("Upload load failed:"),
    "discarding unsaved edits then rejecting a malformed uploaded project");
    assert.equal(rejectedUpload.projectEpoch, beforeSameCoreReopen.projectEpoch,
      "a malformed upload must not replace the current project even after explicit discard");
    assert.equal(getRegion(rejectedUpload).name, "Transient before same-Core reopen",
      "failed uploaded-project parsing must retain the prior in-memory document");

    await request("/api/v1/project/open-recent", { path: project });
    const confirmedOpenPrompt = await waitFor((snapshot) => snapshot.openConfirmPending,
      "reopened recent-project prompt after cancellation");
    assert.equal(confirmedOpenPrompt.projectEpoch, beforeSameCoreReopen.projectEpoch);
    await request("/api/v1/project/open-decision", { index: 2 });
    const reloadedState = await waitFor((snapshot) => snapshot.projectEpoch !== beforeSameCoreReopen.projectEpoch
      && !snapshot.busy
      && snapshot.songs?.[0]?.midiRegions?.some((region) => region.id === regionId),
    "same-Core reopen of the same package with stable entity IDs");
    assert.equal(reloadedState.stateSessionId, beforeSameCoreReopen.stateSessionId,
      "same-Core document reopen must keep the Core session identity");
    assert.equal(reloadedState.projectName, "Fixture",
      "resolving the first prompt must open its original target, not a later competing request");
    const lateResult = reloadedState.editorCommandResults?.find(
      (result) => result.requestId === lateAcceptedEdit.requestId,
    );
    assert.ok(lateResult, "the accepted old-document command must retain its exact late result");
    assert.equal(lateResult.applied, true,
      "the FIFO-ordered edit may apply to its original document before the queued reopen");
    assert.equal(lateResult.projectEpoch, beforeSameCoreReopen.projectEpoch,
      "a late exact result must retain the identity captured when its command was accepted");
    assert.notEqual(lateResult.projectEpoch, reloadedState.projectEpoch,
      "an old-document result must never be presented as belonging to the reloaded document");
    assert.equal(getRegion(reloadedState).name, persistedRegionName,
      "reopening the same package must discard the prior document's unsaved transient edit");
    const afterSameCoreReopenEdit = await confirmEditorMutation("/api/v1/builder/midi-region/update", {
      songIndex: 0, regionId, name: "Edit after same-Core reopen",
    });
    assert.equal(afterSameCoreReopenEdit.accepted.requestId, lateAcceptedEdit.requestId + 1,
      "same-Core reopen must not reset the process-local exact request sequence");
    const stalePluginEdit = await fetch(origin + "/api/v1/plugins/slot/remove", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ResoStage-Session": beforeSameCoreReopen.stateSessionId,
        "X-ResoStage-Project-Epoch": String(beforeSameCoreReopen.projectEpoch),
      },
      body: JSON.stringify({ stripId: "audio::track:2", slotId: "stale-project-slot" }),
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(stalePluginEdit.status, 202,
      "a stale project identity is admitted, then fenced on Core's mutation thread");
    const stalePluginAdmission = await stalePluginEdit.json();
    assert.ok(Number.isSafeInteger(stalePluginAdmission.requestId),
      "a stale queued plug-in edit must have an exact terminal result");
    state = await waitFor((snapshot) => snapshot.editorCommandResults?.some(
      (result) => result.requestId === stalePluginAdmission.requestId,
    ), "stale project-scoped plug-in edit rejection");
    commandState = state;
    const stalePluginResult = state.editorCommandResults.find(
      (result) => result.requestId === stalePluginAdmission.requestId,
    );
    assert.equal(stalePluginResult.applied, false,
      "an old-project plug-in-chain command cannot be reported as applied");
    assert.match(stalePluginResult.error, /Project changed before this command was applied/i);
    assert.equal(state.stateRevision, afterSameCoreReopenEdit.state.stateRevision,
      "a stale plug-in command cannot mutate the replacement project");

    const detachedAutomation = await confirmEditorMutation("/api/v1/builder/automation-lane/add", {
      songIndex: 0,
      domain: "plugin",
      entityId: "slot:removed-before-recovery",
      parameterId: "id:cutoff",
      valueType: "floatNormalized",
      defaultValue: 0.5,
      minValue: 0,
      maxValue: 1,
      points: [{ timeBeats: 0, value: 0.75, curve: 0 }],
    });
    const detachedLane = detachedAutomation.state.songs[0].automationLanes.at(-1);
    const beforeInvalidRebindRevision = detachedAutomation.state.stateRevision;
    const rejectedRebind = await confirmEditorMutation("/api/v1/builder/automation-lane/update", {
      songIndex: 0,
      laneId: detachedLane.id,
      target: {
        domain: "plugin",
        entityId: "slot:not-loaded-in-project",
        parameterId: "id:cutoff",
        valueType: "floatNormalized",
        defaultValue: 0.4,
        minValue: 0,
        maxValue: 1,
      },
    }, false);
    assert.equal(rejectedRebind.state.stateRevision, beforeInvalidRebindRevision,
      "a rebind to a plug-in absent from the project must be rejected before history mutation");
    const retainedDetachedLane = rejectedRebind.state.songs[0].automationLanes
      .find((lane) => lane.id === detachedLane.id);
    assert.equal(retainedDetachedLane.target.entityId, "slot:removed-before-recovery");
    assert.deepEqual(retainedDetachedLane.points, detachedLane.points,
      "rejected rebind must preserve the detached lane and its curve");
    assert.match(rejectedRebind.result.error, /destination parameter is not loaded/);
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
    await confirmEditorMutation("/api/v1/builder/track/add", {
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
    if (process.env.RESOSTAGE_TEST_PENDING_RESTART === "1") {
      const beforeReload = await request("/api/v1/state");
      commandState = beforeReload;
      await request("/api/v1/project/open-recent", { path: project });
      const restartOpenPrompt = await waitFor((snapshot) => snapshot.openConfirmPending,
        "restart fixture recent-project open confirmation");
      assert.equal(restartOpenPrompt.projectEpoch, beforeReload.projectEpoch,
        "pending Core restart fixture must not discard edits before confirmation");
      await request("/api/v1/project/open-decision", { index: 2 });
      const restoredProject = await waitFor((snapshot) => snapshot.projectEpoch !== beforeReload.projectEpoch
        && !snapshot.busy
        && snapshot.tracks?.some((track) => track.name === "Fixture MIDI")
        && snapshot.songs?.[0]?.midiRegions?.some((region) => region.id === regionId),
      "restore the persisted project before terminating a pending command");
      const expectedNameAfterRestart = getRegion(restoredProject).name;

      const pauseResponse = await postRaw("/api/v1/test/command-queue-control", { action: "pause" });
      const pauseText = await pauseResponse.text();
      assert.equal(pauseResponse.status, 200, `pause Core dequeue: ${pauseText}`);
      assert.equal(JSON.parse(pauseText).paused, true,
        "the loopback-only hook must pause command dequeue before accepting the pending edit");
      const pendingAccepted = await request("/api/v1/builder/midi-region/update", {
        songIndex: 0,
        regionId,
        name: "Accepted but pending when Core dies",
      });
      assert.ok(Number.isSafeInteger(pendingAccepted.requestId),
        "the edit must be HTTP-accepted before Core is terminated");
      const queueStatusResponse = await postRaw("/api/v1/test/command-queue-control", { action: "status" });
      const queueStatusText = await queueStatusResponse.text();
      assert.equal(queueStatusResponse.status, 200, `inspect held Core command queue: ${queueStatusText}`);
      assert.equal(JSON.parse(queueStatusText).queuedCommands, 1,
        "the accepted mutation must remain queued and unapplied at the exact crash boundary");
      const beforeCrashState = await request("/api/v1/state");
      assert.equal(getRegion(beforeCrashState).name, expectedNameAfterRestart,
        "HTTP admission alone must not mutate project state while dequeue is paused");
      assert.ok(!beforeCrashState.editorCommandResults?.some(
        (result) => result.requestId === pendingAccepted.requestId,
      ), "an unapplied command must not fabricate a terminal result before process death");
      const pendingSession = beforeCrashState.stateSessionId;
      const pendingEpoch = beforeCrashState.projectEpoch;
      await killCoreImmediately();
      await startCore();
      const afterCrashState = await request("/api/v1/state");
      commandState = afterCrashState;
      assert.notEqual(afterCrashState.stateSessionId, pendingSession,
        "restarted Core must use a new session namespace after losing an admitted command");
      assert.equal(getRegion(afterCrashState).name, expectedNameAfterRestart,
        "an accepted-but-unapplied command must not leak into the project after process restart");
      assert.ok(!afterCrashState.editorCommandResults?.some(
        (result) => result.requestId === pendingAccepted.requestId,
      ), "the new process must not invent a result for the dead process's queued edit");
      const lateOldSessionCommand = await fetch(`${origin}/api/v1/builder/midi-region/update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ResoStage-Session": pendingSession,
          "X-ResoStage-Project-Epoch": String(pendingEpoch),
        },
        body: JSON.stringify({ songIndex: 0, regionId, name: "Late response must not apply" }),
        signal: AbortSignal.timeout(8000),
      });
      assert.equal(lateOldSessionCommand.status, 409,
        "commands retried from the dead session must be rejected, not redirected or accepted");
      const afterStaleRetry = await request("/api/v1/state");
      commandState = afterStaleRetry;
      assert.equal(afterStaleRetry.stateRevision, afterCrashState.stateRevision,
        "a stale post-restart retry must not change project history");
      assert.equal(getRegion(afterStaleRetry).name, expectedNameAfterRestart);
    }
    const queueAcceptance = process.env.RESOSTAGE_TEST_EXPECT_SNAPSHOT_FAILURE === "1"
      ? ", command queue and deferred queue saturation/rejection/drain/recovery"
      : "";
    console.log([
      "PASS: actual Core HTTP/state persistence, exact project/playback revisions, concurrent editor ACKs",
      `257-edit result-ring eviction${queueAcceptance}`,
      "audio/MIDI region CRUD and embedded-automation rejection",
      "lighting config/fixture/track/cue exact outcomes",
      "edit deferred through real busy Save and applied after same-epoch package reopen",
      "edit deferred through real busy media import with exact job result and full region/song extent",
      "detached plug-in automation rebind rejection",
      "structural song/bus/event/section/cycle results",
      "short-cycle transport pass sequence and seek distinction",
      "same-Core reopen with late old-epoch result and stable entities, Core-session fences and restart-scoped request-ID reuse",
      ...(process.env.RESOSTAGE_TEST_PENDING_RESTART === "1"
        ? ["accepted-but-pending editor command discarded safely on Core restart"] : []),
      "active-playback Undo/Redo, automation recording/rejection, 413, save/reopen",
      "(not acoustic or UI manual-override proof)",
    ].join(", "));
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
