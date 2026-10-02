/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Real production HTTP render acceptance. Run only with other Core instances
 * stopped: JUCE enforces one Core process. Preferences/projects/exports are
 * private temporary fixtures; no real project or rig configuration is edited.
 * Optional visual QA receives the isolated Core URL before shutdown.
 */
export async function runRenderAcceptance(coreExecutable, mediaExecutable, inspect) {
  const temp = mkdtempSync(join(tmpdir(), "resostage-render-acceptance-"));
  let child;
  let childExited = false;
  let diagnostic = "";
  const invoke = (args) => execFileSync(mediaExecutable,
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "2", ...args],
    { stdio: "pipe", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const stopCore = async () => {
    if (!child || childExited) return;
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 50 && !childExited; ++attempt) await sleep(100);
    if (!childExited) child.kill("SIGKILL");
    // Never restart or remove fixtures while their old owner can still write.
    if (!childExited) await new Promise((done) => child.once("exit", done));
  };
  try {
    const project = join(temp, "Fixture.rsnraset");
    mkdirSync(join(project, "Audio"), { recursive: true });
    invoke(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.5",
      "-ac", "2", "-c:a", "pcm_f32le", join(project, "Audio", "signal.wav")]);
    const output = { type: "main", target: "audio::main", sends: [] };
    writeFileSync(join(project, "project.rsnrasetmeta"), JSON.stringify({
      format: { version: 10 }, name: "Render Acceptance", sampleRate: 48000,
      tracks: [{ id: "audio::track:1", name: "Signal", kind: "audio", channels: 2,
        gainDb: 0, pan: 0, mute: false, solo: false, output }], sends: [],
      main: { enabled: true, name: "Main", channels: 2, gainDb: 0, pan: 0, mute: false,
        solo: false, output: { type: "ext-out", target: "audio::out:1,audio::out:2" } },
      click: { enabled: false, soloSafe: true, channels: 2, gainDb: 0, pan: 0, output },
      songs: [{ id: "meta::song:1", name: "Fixture", bpm: 120,
        timeSignature: { numerator: 4, denominator: 4 }, endSeconds: 0.5, onEnded: "stop",
        regions: [{ id: "019fd93b-3662-7f5b-8162-45f5ecad98fa", trackId: "audio::track:1",
          startSeconds: 0, durationSeconds: 0.5, gainDb: 0,
          source: { file: "Audio/signal.wav", offsetSeconds: 0 },
          fade: { inSeconds: 0, outSeconds: 0, inCurve: 0, outCurve: 0 },
          loop: { enabled: false, lengthSeconds: 0 } }], events: [] }],
    }));
    const settings = join(temp, "settings.json");
    writeFileSync(settings, JSON.stringify({ audioInputDisabled: true,
      inputDeviceName: "", midiInputNames: [], midiOutputNames: [], recentProjects: [] }));
    const probe = createServer();
    await new Promise((done) => probe.listen(0, "127.0.0.1", done));
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
    const origin = `http://127.0.0.1:${port}`;
    const request = async (path, body) => {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000),
        ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      assert.ok(response.ok, `${path}: ${response.status} ${await (!response.ok ? response.text() : "")}`);
      return response.json();
    };
    const startCore = async () => {
      childExited = false;
      child = spawn(coreExecutable, [`--backend-port=${port}`, "--no-discovery", project], {
        env: { ...process.env, RESOSTAGE_SETTINGS_FILE: settings, RESOSTAGE_SPAWNED_BY_SHELL: "1" },
        stdio: ["ignore", "pipe", "pipe"], cwd: temp,
      });
      child.on("error", (error) => { diagnostic += String(error); childExited = true; });
      child.once("exit", () => { childExited = true; });
      for (const pipe of [child.stdout, child.stderr]) pipe.on("data", (data) => {
        diagnostic = (diagnostic + data).slice(-16384);
      });
      let ready = false;
      for (let attempt = 0; attempt < 100; ++attempt) {
        if (childExited) throw new Error(`Core exited: ${child.exitCode}\n${diagnostic}`);
        try {
          const state = await request("/api/v1/state");
          ready = state.projectName === "Render Acceptance" || state.tracks?.some((track) => track.name === "Signal");
          if (ready) break;
        } catch { /* Startup has not bound HTTP yet. */ }
        await sleep(100);
      }
      assert.ok(ready, `Fixture was not loaded\n${diagnostic}`);
    };
    const render = async (options) => {
      await request("/api/v1/render/start", { scope: "song", songIndex: 0,
        targets: [{ kind: "master" }], sampleRate: 48000, outputFormat: "wav",
        bitDepth: 24, rangeStartSeconds: 0, rangeEndSeconds: 0.5, tailPolicy: "cut",
        dither: "none", normalization: "off", ...options });
      let status;
      for (let attempt = 0; attempt < 200; ++attempt) {
        status = await request("/api/v1/render/status");
        if (["complete", "failed", "error", "cancelled"].includes(status.state)) break;
        await sleep(50);
      }
      return status;
    };
    const assertPreference = async (expected) => {
      assert.equal(JSON.parse(readFileSync(settings, "utf8")).renderOutputDirectory, expected,
        "The private settings file must remember the accepted destination");
      let actual;
      for (let attempt = 0; attempt < 50; ++attempt) {
        actual = (await request("/api/v1/state")).settings?.renderOutputDirectory;
        if (actual === expected) return;
        await sleep(100);
      }
      assert.equal(actual, expected, "Structural state must publish the destination preference");
    };
    const entries = (directory) => existsSync(directory) ? readdirSync(directory).sort() : [];
    const legacyDestination = join(temp, "Exports");
    // The selection is deliberately outside the project package and contains
    // Unicode: exporting must neither relocate it into the package nor lose
    // non-ASCII path bytes at the Core/writer/encoder boundaries.
    const customDestination = join(temp, "Custom — ミックス");
    mkdirSync(customDestination);
    await startCore();
    for (const format of ["wav", "aiff", "flac", "alac", "mp3", "m4a", "opus", "ogg", "wma"]) {
      const status = await render({ outputFormat: format, outputDirectory: customDestination,
        fileNamePattern: `acceptance-${format}` });
      assert.equal(status.state, "complete", `${format}: ${JSON.stringify(status)}\n${diagnostic}`);
      const file = status.outputPaths?.[0] || status.outputPath;
      assert.ok(resolve(file).startsWith(resolve(temp) + sep), `Export escaped private fixture: ${file}`);
      assert.equal(resolve(dirname(file)), resolve(customDestination), `${format}: selected folder was ignored`);
      assert.equal(extname(file), `.${format === "alac" ? "m4a" : format}`);
      const pcm = invoke(["-i", file, "-map", "0:a:0", "-vn", "-ar", "48000", "-ac", "2", "-f", "f32le", "-"]);
      assert.ok(Math.abs(pcm.length / 8 - 24000) <= 4096, `${format}: unexpected duration`);
      let peak = 0;
      for (let offset = 0; offset < pcm.length; offset += 4) peak = Math.max(peak, Math.abs(pcm.readFloatLE(offset)));
      assert.ok(peak > 0.04 && peak < 0.5, `${format}: silent/invalid rendered audio: ${peak}`);
      console.log(`Production render passed: ${format}`);
    }
    await assertPreference(customDestination);
    assert.equal(entries(customDestination).filter((file) => file.startsWith(".resostage-")).length, 0);
    assert.equal(existsSync(legacyDestination), false, "Custom exports must not create the legacy folder");

    await stopCore();
    await startCore();
    await assertPreference(customDestination);
    console.log("Production destination preference passed: disk/state persistence and private Core restart.");

    const destinationFile = join(temp, "not-a-folder");
    writeFileSync(destinationFile, "Existing fixture, not an export directory");
    const missingDestination = join(temp, "missing-destination");
    const invalidDestinations = [
      ["relative", "relative-output"], ["nonexistent", missingDestination],
      ["file", destinationFile], ["embedded NUL", `${customDestination}\0invalid`],
      ["number", 42], ["null", null], ["array", [customDestination]],
    ];
    for (const [label, outputDirectory] of invalidDestinations) {
      const beforeCustom = entries(customDestination);
      const beforeLegacy = entries(legacyDestination);
      const legacyExisted = existsSync(legacyDestination);
      const status = await render({ outputFormat: "wav", outputDirectory,
        fileNamePattern: "must-not-be-created" });
      assert.equal(status.state, "failed", `${label}: invalid destination was accepted: ${JSON.stringify(status)}`);
      assert.match(status.error, /[Oo]utput directory/);
      assert.equal(status.outputPaths?.length || 0, 0, `${label}: failed request published outputs`);
      assert.equal(status.outputPath || "", "", `${label}: failed request published an output path`);
      await assertPreference(customDestination);
      assert.deepEqual(entries(customDestination), beforeCustom, `${label}: custom folder changed`);
      assert.deepEqual(entries(legacyDestination), beforeLegacy, `${label}: legacy folder changed`);
      assert.equal(existsSync(legacyDestination), legacyExisted, `${label}: legacy folder was created`);
      assert.equal(existsSync(join(temp, "relative-output")), false, `${label}: relative folder was created`);
      assert.equal(existsSync(missingDestination), false, `${label}: nonexistent folder was created`);
      assert.equal(readFileSync(destinationFile, "utf8"), "Existing fixture, not an export directory");
    }

    // Older clients omit the field: they retain their legacy destination and
    // cannot erase a newer client's saved choice. Only an explicit empty
    // value means "restore the standard destination".
    const legacy = await render({ outputFormat: "wav", fileNamePattern: "acceptance-legacy-client" });
    assert.equal(legacy.state, "complete", JSON.stringify(legacy));
    assert.equal(resolve(dirname(legacy.outputPath)), resolve(legacyDestination));
    await assertPreference(customDestination);
    const reset = await render({ outputFormat: "wav", outputDirectory: "", fileNamePattern: "acceptance-default-reset" });
    assert.equal(reset.state, "complete", JSON.stringify(reset));
    assert.equal(resolve(dirname(reset.outputPath)), resolve(legacyDestination));
    await assertPreference("");
    for (const directory of [legacyDestination, customDestination])
      assert.equal(entries(directory).filter((file) => file.startsWith(".resostage-")).length, 0);
    console.log("Production destination validation passed: rejected paths, legacy omission and explicit default reset.");
    if (inspect) await inspect(origin, temp);
    console.log("Render acceptance passed: production HTTP graph → 9 formats → decoded non-silent audio; custom folder and persisted/reset destination.");
  } finally {
    await stopCore();
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: node scripts/media/acceptance.mjs <packaged Core executable> <packaged media executable>");
  await runRenderAcceptance(resolve(process.argv[2]), resolve(process.argv[3]));
}
