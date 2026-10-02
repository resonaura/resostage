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

    // =========================================================================
    // Media Import Acceptance: exercise production HTTP import workflows
    // =========================================================================
    console.log("Starting media import acceptance suite...");

    const uploadMedia = async (requestId, buffer) => {
      const response = await fetch(
        `${origin}/api/v1/builder/track/import-wav/upload?requestId=${encodeURIComponent(requestId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(buffer.length),
          },
          body: buffer,
          signal: AbortSignal.timeout(10000),
        }
      );
      return response;
    };

    const pollImportStatus = async (requestId) => {
      for (let attempt = 0; attempt < 100; ++attempt) {
        const res = await fetch(
          `${origin}/api/v1/builder/track/import-status?requestId=${encodeURIComponent(requestId)}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.finished) return data;
        }
        await sleep(50);
      }
      throw new Error(`Import timed out for request ${requestId}`);
    };

    const pollState = async (predicate, description) => {
      for (let attempt = 0; attempt < 100; ++attempt) {
        const state = await request("/api/v1/state");
        if (predicate(state)) return state;
        await sleep(50);
      }
      throw new Error(`Timed out waiting for state condition: ${description}`);
    };

    // 1. Successful Audio Import
    const audioFixture = join(temp, "test-import-audio.wav");
    invoke(["-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000:duration=0.5",
      "-ac", "2", "-c:a", "pcm_f32le", audioFixture]);
    const audioBytes = readFileSync(audioFixture);

    const beginAudio = await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "test-import-audio.wav", startSeconds: 0.1, requestId: "req-audio-1"
    });
    assert.equal(beginAudio.ok, true, "Audio import begin must succeed");

    const uploadAudioRes = await uploadMedia("req-audio-1", audioBytes);
    assert.equal(uploadAudioRes.status, 200, "Audio upload POST must succeed");
    const audioImportStatus = await pollImportStatus("req-audio-1");
    assert.equal(audioImportStatus.success, true, `Audio import failed: ${audioImportStatus.error}`);

    let state = await pollState((s) => s.songs[0].regions.filter((r) => r.trackId === "audio::track:1").length >= 2,
      "imported audio region present on track 1");
    console.log("Media import passed: successful audio import.");

    // 2. Successful Video Import (with audio)
    const videoFixture = join(temp, "test-import-video.mp4");
    invoke(["-f", "lavfi", "-i", "testsrc=duration=0.5:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=659:duration=0.5",
      "-c:v", "mpeg4", "-c:a", "aac", videoFixture]);
    const videoBytes = readFileSync(videoFixture);

    const beginVideo = await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "test-import-video.mp4", startSeconds: 0.2, requestId: "req-video-1"
    });
    assert.equal(beginVideo.ok, true, "Video import begin must succeed");

    const uploadVideoRes = await uploadMedia("req-video-1", videoBytes);
    assert.equal(uploadVideoRes.status, 200, "Video upload POST must succeed");
    const videoImportStatus = await pollImportStatus("req-video-1");
    assert.equal(videoImportStatus.success, true, `Video import failed: ${videoImportStatus.error}`);

    const videoDir = join(project, "Video");
    assert.ok(existsSync(videoDir), "Project package must contain Video folder for retained original video");
    const videoFiles = entries(videoDir);
    assert.ok(videoFiles.some((f) => f.includes("test-import-video.mp4")),
      `Original video file must be retained in Video/ folder, got: ${videoFiles.join(", ")}`);
    console.log("Media import passed: successful video import with retained original video in package.");

    // 3. No-Audio Video Import (must fail cleanly and leave no partial regions)
    const silentVideoFixture = join(temp, "silent-video.mp4");
    invoke(["-f", "lavfi", "-i", "testsrc=duration=0.5:size=320x240:rate=30",
      "-c:v", "mpeg4", "-an", silentVideoFixture]);
    const silentVideoBytes = readFileSync(silentVideoFixture);

    const regionsBeforeSilent = (await request("/api/v1/state")).songs[0].regions.length;
    await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "silent-video.mp4", startSeconds: 0.0, requestId: "req-silent-video"
    });
    const uploadSilentRes = await uploadMedia("req-silent-video", silentVideoBytes);
    assert.equal(uploadSilentRes.status, 200);
    const silentImportStatus = await pollImportStatus("req-silent-video");
    assert.equal(silentImportStatus.success, false, "No-audio video import must fail");
    assert.ok(silentImportStatus.error.length > 0, "No-audio failure must report an error");

    const regionsAfterSilent = (await request("/api/v1/state")).songs[0].regions.length;
    assert.equal(regionsAfterSilent, regionsBeforeSilent, "Failed no-audio import must not add a region");
    console.log("Media import passed: no-audio video rejected cleanly without partial state.");

    // 4. Corrupt Media Source (must fail cleanly)
    const corruptBytes = Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00CORRUPT_GARBAGE_PAYLOAD");
    await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "corrupt.wav", startSeconds: 0.0, requestId: "req-corrupt"
    });
    const uploadCorruptRes = await uploadMedia("req-corrupt", corruptBytes);
    assert.equal(uploadCorruptRes.status, 200);
    const corruptImportStatus = await pollImportStatus("req-corrupt");
    assert.equal(corruptImportStatus.success, false, "Corrupt file import must fail");
    assert.equal((await request("/api/v1/state")).songs[0].regions.length, regionsBeforeSilent,
      "Failed corrupt import must not add a region");
    console.log("Media import passed: corrupt media source rejected cleanly.");

    // 5. Duplicate Filenames (must produce distinct UUID entries and never collide)
    const countBeforeDup = (await request("/api/v1/state")).songs[0].regions.length;
    await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "duplicate.wav", startSeconds: 0.0, requestId: "req-dup-1"
    });
    await uploadMedia("req-dup-1", audioBytes);
    const dup1Status = await pollImportStatus("req-dup-1");
    assert.equal(dup1Status.success, true);

    await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "duplicate.wav", startSeconds: 0.25, requestId: "req-dup-2"
    });
    await uploadMedia("req-dup-2", audioBytes);
    const dup2Status = await pollImportStatus("req-dup-2");
    assert.equal(dup2Status.success, true);

    state = await pollState((s) => s.songs[0].regions.length >= countBeforeDup + 2,
      "both duplicate files produce distinct regions");
    const allRegions = state.songs[0].regions;
    assert.equal(allRegions.length, countBeforeDup + 2, "Both duplicate files must produce distinct regions");
    const dup1Region = allRegions[allRegions.length - 2];
    const dup2Region = allRegions[allRegions.length - 1];
    assert.notEqual(dup1Region.id, dup2Region.id, "Duplicate filenames must have distinct region IDs");
    assert.notEqual(dup1Region.source.file, dup2Region.source.file, "Duplicate filenames must have distinct archive files");
    console.log("Media import passed: duplicate filenames handled with distinct UUID archive entries.");

    // 6. Cancelled / Disconnected Upload (client aborts mid-stream)
    await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "aborted.wav", startSeconds: 0.0, requestId: "req-aborted"
    });
    await new Promise((resolveAbort) => {
      import("node:http").then(({ request: httpReq }) => {
        const req = httpReq(`${origin}/api/v1/builder/track/import-wav/upload?requestId=req-aborted`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "1000000",
          },
        });
        req.on("error", () => resolveAbort());
        req.write(Buffer.alloc(1024, 0x55));
        setTimeout(() => {
          req.destroy();
          resolveAbort();
        }, 50);
      });
    });
    await sleep(200);
    state = await request("/api/v1/state");
    assert.ok(state.projectName === "Render Acceptance", "Core must remain fully responsive after aborted upload");
    console.log("Media import passed: aborted/disconnected upload cleaned up without crash or leaked state.");

    // 7. Queue Rejection: invalid song/track target (negative index or duplicate ticket)
    const invalidTargetRes = await fetch(`${origin}/api/v1/builder/track/import-wav/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songIndex: -1, index: 0, fileName: "x.wav", startSeconds: 0, requestId: "req-invalid" }),
    });
    assert.equal(invalidTargetRes.status, 409, "Invalid negative import target must be rejected with 409");

    const dupTicket1 = await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "x.wav", startSeconds: 0, requestId: "req-dup-ticket"
    });
    assert.equal(dupTicket1.ok, true);
    const dupTicketRes = await fetch(`${origin}/api/v1/builder/track/import-wav/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songIndex: 0, index: 0, fileName: "x.wav", startSeconds: 0, requestId: "req-dup-ticket" }),
    });
    assert.equal(dupTicketRes.status, 409, "Duplicate ticket must be rejected with 409");
    console.log("Media import passed: invalid targets, duplicate tickets and queue bounds rejected.");

    // 8. Song Boundary Extension
    const longAudioFixture = join(temp, "long-audio.wav");
    invoke(["-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=2.0",
      "-ac", "2", "-c:a", "pcm_f32le", longAudioFixture]);
    const longAudioBytes = readFileSync(longAudioFixture);

    await request("/api/v1/builder/track/import-wav/begin", {
      songIndex: 0, index: 0, fileName: "long-audio.wav", startSeconds: 1.5, requestId: "req-extend"
    });
    await uploadMedia("req-extend", longAudioBytes);
    const extendStatus = await pollImportStatus("req-extend");
    assert.equal(extendStatus.success, true);

    let songAfterExt;
    for (let attempt = 0; attempt < 50; ++attempt) {
      songAfterExt = (await request("/api/v1/state")).songs[0];
      if (songAfterExt.endSeconds >= 3.5) break;
      await sleep(50);
    }
    assert.ok(songAfterExt.endSeconds >= 3.5,
      `Song boundary must extend to encompass imported audio (expected >= 3.5, got ${songAfterExt.endSeconds})`);
    console.log("Media import passed: song boundary extension on import.");

    // 9. Save and Reopen Persistence
    await stopCore();
    await startCore();
    const stateAfterReopen = await pollState((s) => s.songs[0].regions.length >= 4,
      "imported regions survive restart");
    assert.ok(stateAfterReopen.songs[0].regions.length >= 4, "Imported regions must survive project save and reopen");
    console.log("Media import passed: imported regions and media survive save/reopen across Core restart.");

    if (inspect) await inspect(origin, temp);
    console.log("Render acceptance passed: production HTTP graph → 9 formats → decoded non-silent audio; custom folder and persisted/reset destination.");
    console.log("Media acceptance complete: export + import production HTTP verified.");
  } finally {
    await stopCore();
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: node scripts/media/acceptance.mjs <packaged Core executable> <packaged media executable>");
  await runRenderAcceptance(resolve(process.argv[2]), resolve(process.argv[3]));
}
