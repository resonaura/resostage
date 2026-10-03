/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function projectPluginOwners(project) {
  return [
    { id: "audio::main", slots: project.main?.plugins ?? [] },
    { id: "audio::click", slots: project.click?.plugins ?? [] },
    ...(project.tracks ?? []).map((track) => ({ id: track.id, slots: track.plugins ?? [] })),
    ...(project.sends ?? []).map((send) => ({ id: send.id, slots: send.plugins ?? [] })),
  ].filter((owner) => owner.slots.length > 0);
}

function pluginRows(state) {
  const rows = [];
  for (const track of state.tracks ?? [])
    for (const slot of track.plugins ?? []) rows.push({ ownerId: track.id, slot });
  for (const bus of state.busses ?? [])
    for (const slot of bus.plugins ?? []) rows.push({ ownerId: bus.id, slot });
  for (const slot of state.clickPlugins ?? [])
    rows.push({ ownerId: "audio::click", slot });
  return rows;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

/**
 * Runs a real Core against a private copy of a project. One target plug-in is
 * deliberately made unavailable so the retry can be requested deterministically.
 * The test passes only if that strip receives a new helper generation while every
 * other already-running strip helper keeps the same generation.
 */
export async function verifyPluginRetryIsolation(coreExecutable, sourceProjectPath,
  requestedStripId = "", requestedSlotId = "") {
  const core = resolve(coreExecutable);
  const source = resolve(sourceProjectPath);
  assert.ok(statSync(core).isFile(), `Core executable not found: ${core}`);
  assert.ok(statSync(source).isDirectory(), `Project package is not a directory: ${source}`);

  const temp = mkdtempSync(join(tmpdir(), "resostage-plugin-retry-"));
  const loadProjectPath = join(temp, "Writetest Load Fixture.rsnraset");
  const projectPath = join(temp, "Plugin Retry Fixture.rsnraset");
  const metadataPath = join(projectPath, "project.rsnrasetmeta");
  const settingsPath = join(temp, "settings.json");
  let port = 0;
  let child;
  let exited = false;
  let diagnostic = "";
  let lastState = null;

  const appendDiagnostic = (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-64 * 1024);
  };

  const readState = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/state`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    assert.ok(response.ok, `Core state returned ${response.status}: ${body}`);
    return JSON.parse(body);
  };

  const waitFor = async (predicate, description, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Core exited during ${description}\n${diagnostic}`);
      try {
        lastState = await readState();
        if (predicate(lastState)) return lastState;
      } catch (error) {
        if (Date.now() + 1000 >= deadline) throw error;
      }
      await sleep(100);
    }
    const rows = pluginRows(lastState ?? {}).map(({ ownerId, slot }) => ({
      ownerId,
      name: slot.name,
      loadState: slot.loadState,
      hostGeneration: slot.hostGeneration,
      loadError: slot.loadError,
    }));
    throw new Error(`Timed out waiting for ${description}\nSlots: ${JSON.stringify(rows)}\n${diagnostic}`);
  };

  const stopCore = async () => {
    if (!child || exited) return;
    child.kill("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (!exited && Date.now() < deadline) await sleep(100);
    if (!exited) child.kill("SIGKILL");
    if (!exited) await new Promise((done) => child.once("exit", done));
  };

  const startCore = async (projectDirectory) => {
    port = await reservePort();
    exited = false;
    lastState = null;
    child = spawn(core, [
      `--backend-port=${port}`,
      "--no-discovery",
      projectDirectory,
    ], {
      cwd: temp,
      env: {
        ...process.env,
        RESOSTAGE_SETTINGS_FILE: settingsPath,
        RESOSTAGE_SPAWNED_BY_SHELL: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("exit", () => { exited = true; });
    child.once("error", (error) => {
      appendDiagnostic(error);
      exited = true;
    });
    child.stdout.on("data", appendDiagnostic);
    child.stderr.on("data", appendDiagnostic);
  };

  try {
    cpSync(source, loadProjectPath, { recursive: true, force: true });
    cpSync(source, projectPath, { recursive: true, force: true });
    const project = JSON.parse(readFileSync(metadataPath, "utf8"));
    const owners = projectPluginOwners(project);
    const expectedSlotCount = owners.reduce((sum, owner) => sum + owner.slots.length, 0);
    assert.ok(owners.length >= 2, "Fixture needs plug-ins on at least two strip chains");

    const targetOwner = requestedStripId
      ? owners.find((owner) => owner.id === requestedStripId)
      : owners.find((owner) => owner.slots.length >= 2) ?? owners[0];
    assert.ok(targetOwner, `Target strip not found: ${requestedStripId}`);
    const targetSlot = requestedSlotId
      ? targetOwner.slots.find((slot) => slot.id === requestedSlotId)
      : targetOwner.slots[0];
    assert.ok(targetSlot, `Target slot not found in strip ${targetOwner.id}: ${requestedSlotId}`);
    assert.ok(targetSlot.plugin?.identifier, "Target slot needs a persisted plug-in identifier");
    const previousIdentifier = targetSlot.plugin.identifier;
    targetSlot.plugin.identifier = `resostage.test.missing.${randomUUID()}`;
    writeFileSync(metadataPath, JSON.stringify(project));
    writeFileSync(settingsPath, JSON.stringify({
      audioInputDisabled: true,
      inputDeviceName: "",
      midiInputNames: [],
      midiOutputNames: [],
      recentProjects: [],
    }));

    // First inspect the unmodified package copy. It is read-only from the
    // operator's perspective and records which real AU instances load today.
    await startCore(loadProjectPath);
    const sourceLoadState = await waitFor((state) => {
      const rows = pluginRows(state);
      return state.projectEpoch > 0 && state.pluginLoading?.phase !== "loading"
        && rows.length === expectedSlotCount
        && rows.every(({ slot }) => slot.loadState && slot.loadState !== "loading");
    }, "source project plug-in load status");
    const sourceLoadReport = pluginRows(sourceLoadState).map(({ ownerId, slot }) => ({
      ownerId,
      slotId: slot.id,
      name: slot.name,
      loadState: slot.loadState,
      hostGeneration: Number(slot.hostGeneration ?? 0),
      loadError: slot.loadError ?? "",
    }));
    await stopCore();
    child = null;
    exited = false;
    diagnostic = "";

    // The second independent copy has exactly one deliberately unavailable
    // identifier. Its retry can now be exercised without altering the source.
    await startCore(projectPath);

    const initial = await waitFor((state) => {
      const target = pluginRows(state).find((row) =>
        row.ownerId === targetOwner.id && row.slot.id === targetSlot.id);
      return state.projectEpoch > 0 && !state.busy
        && state.pluginLoading?.phase !== "loading"
        && target?.slot.loadState === "missing"
        && Number(target.slot.hostGeneration) > 0;
    }, "initial fixture plug-in scan/load");

    // Let automatic recovery of unrelated failed helper processes settle before
    // capturing the generation snapshot. The intentionally missing plug-in is a
    // reported slot error, not a dead helper, so it must not auto-retry.
    let stableKey = "";
    let stableSamples = 0;
    let baseline = initial;
    for (let attempt = 0; attempt < 100 && stableSamples < 10; ++attempt) {
      baseline = await readState();
      const key = pluginRows(baseline)
        .map(({ ownerId, slot }) => `${ownerId}:${slot.id}:${slot.hostGeneration ?? 0}`)
        .sort().join("|");
      if (baseline.pluginLoading?.phase !== "loading" && key === stableKey)
        stableSamples += 1;
      else
        stableSamples = 0;
      stableKey = key;
      await sleep(100);
    }
    assert.ok(stableSamples >= 10, "Plug-in helper generations did not settle before the retry probe");

    const beforeRows = pluginRows(baseline);
    const targetRowsBefore = beforeRows.filter((row) => row.ownerId === targetOwner.id);
    assert.ok(targetRowsBefore.some(({ slot }) => slot.id === targetSlot.id
      && slot.loadState === "missing"), "The injected missing plug-in must be visible before retry");
    assert.ok(targetRowsBefore.every(({ slot }) => Number(slot.hostGeneration) > 0),
      "All slots in the target isolated chain must share a live helper generation");
    const unrelatedRows = beforeRows.filter((row) => row.ownerId !== targetOwner.id);
    const unrelatedLiveRows = unrelatedRows.filter(({ slot }) => Number(slot.hostGeneration) > 0);
    assert.ok(unrelatedLiveRows.length > 0,
      "Fixture needs at least one unrelated live helper chain to verify preservation");

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/plugins/slot/retry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ResoStage-Session": baseline.stateSessionId,
        "X-ResoStage-Project-Epoch": String(baseline.projectEpoch),
      },
      body: JSON.stringify({ stripId: targetOwner.id, slotId: targetSlot.id }),
      signal: AbortSignal.timeout(8000),
    });
    const responseBody = await response.text();
    assert.ok(response.ok, `Plug-in retry returned ${response.status}: ${responseBody}`);

    const retried = await waitFor((state) => {
      const target = pluginRows(state).find((row) =>
        row.ownerId === targetOwner.id && row.slot.id === targetSlot.id);
      return state.pluginLoading?.generation > baseline.pluginLoading?.generation
        && state.pluginLoading?.phase !== "loading"
        && Number(target?.slot.hostGeneration) > Number(targetRowsBefore[0].slot.hostGeneration);
    }, "the requested strip helper to be replaced");

    const afterRows = pluginRows(retried);
    const targetGenerationAfter = new Set(afterRows
      .filter((row) => row.ownerId === targetOwner.id)
      .map(({ slot }) => Number(slot.hostGeneration)));
    assert.equal(targetGenerationAfter.size, 1,
      "Every plug-in slot on the retried serial strip must share its replacement helper");
    assert.notEqual([...targetGenerationAfter][0], Number(targetRowsBefore[0].slot.hostGeneration),
      "The target strip helper must receive a fresh generation");

    const beforeBySlot = new Map(unrelatedRows.map(({ ownerId, slot }) =>
      [`${ownerId}:${slot.id}`, Number(slot.hostGeneration)]));
    for (const { ownerId, slot } of afterRows) {
      if (ownerId === targetOwner.id) continue;
      const key = `${ownerId}:${slot.id}`;
      if (!beforeBySlot.has(key)) continue;
      assert.equal(Number(slot.hostGeneration), beforeBySlot.get(key),
        `Unrelated plug-in host generation changed for ${key}`);
    }

    const changedOwners = new Set(afterRows.filter(({ ownerId, slot }) =>
      ownerId !== targetOwner.id
      && beforeBySlot.get(`${ownerId}:${slot.id}`) !== Number(slot.hostGeneration))
      .map(({ ownerId }) => ownerId));
    assert.equal(changedOwners.size, 0, "Retry must not replace another strip's helper");

    console.log(JSON.stringify({
      result: "passed",
      privateCopy: true,
      sourceProjectLoad: sourceLoadReport,
      target: {
        stripId: targetOwner.id,
        slotId: targetSlot.id,
        originalPluginIdentifier: previousIdentifier,
        injectedPluginIdentifier: targetSlot.plugin.identifier,
        previousHostGeneration: Number(targetRowsBefore[0].slot.hostGeneration),
        replacementHostGeneration: [...targetGenerationAfter][0],
      },
      unrelatedLiveChainsVerified: [...new Set(unrelatedLiveRows.map(({ ownerId }) => ownerId))],
      projectEpoch: retried.projectEpoch,
    }, null, 2));
  } finally {
    await stopCore();
    rmSync(temp, { recursive: true, force: true });
  }
}

const [coreExecutable, projectPath, stripId = "", slotId = ""] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!coreExecutable || !projectPath) {
    console.error("Usage: node scripts/verification/plugin-retry.mjs <Core executable> <project package directory> [strip ID] [slot ID]");
    process.exitCode = 2;
  } else {
    verifyPluginRetryIsolation(coreExecutable, projectPath, stripId, slotId)
      .catch((error) => {
        console.error(error.stack ?? String(error));
        process.exitCode = 1;
      });
  }
}
