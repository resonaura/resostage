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
  const audioFixture = join(temp, "fixture.wav");
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
      assert.equal(result.playbackApplied, true,
        `${path} must publish its project revision for audio: ${JSON.stringify(result)}`);
      assert.ok(result.playbackRevision >= result.projectRevision,
        `${path} audio graph revision must include the edit`);
      assert.equal(result.playbackProjectEpoch, state.playbackProjectEpoch,
        `${path} graph epoch must match the exact result`);
      assert.ok(state.playbackProjectRevision >= result.projectRevision,
        `${path} state must expose an audio graph at least as new as the edit`);
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
    if (process.env.RESOSTAGE_TEST_EXPECT_SNAPSHOT_FAILURE !== "1") {
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
      await request("/api/v1/transport/play", {});
      const beforeInjectedFailure = await waitFor((current) => current.playing,
        "play before injected playback-snapshot failure");
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
    console.log("PASS: actual Core HTTP/state persistence, exact project/playback revisions, concurrent editor ACKs, 257-edit result-ring eviction, audio/MIDI region CRUD and embedded-automation rejection, structural song/bus/event/section/cycle results, project-epoch and Core-session fences, request-ID reuse after restart, active-playback Undo/Redo, automation recording/rejection, 413, save/reopen (not acoustic or UI manual-override proof)");
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
