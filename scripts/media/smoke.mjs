/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyFFmpegRuntime } from "../ffmpeg-runtime.mjs";

/** Real codec/dependency smoke pass; no audio hardware or vendor plug-ins needed. */
export function runMediaSmoke(runtimeDirectory, executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  arch = process.arch) {
  const temp = mkdtempSync(join(tmpdir(), "resostage-media-smoke-"));
  try {
    // A copy in an unrelated directory proves that relocated libraries do not
    // depend on the source build location. Spaces exercise argv handling.
    const isolated = join(temp, "isolated runtime");
    cpSync(runtimeDirectory, isolated, { recursive: true });
    verifyFFmpegRuntime(isolated, process.platform, arch, executableName);
    const executable = join(isolated, executableName);
    const env = { PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}), LANG: "C" };
    const invoke = (args) => execFileSync(executable,
      ["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "2", ...args],
      { env, stdio: "pipe", maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
    const source = join(temp, "source signal.wav");
    invoke(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.5",
      "-ac", "2", "-c:a", "pcm_f32le", source]);
    const outputs = [
      ["aiff", "pcm_s24be", "aiff"], ["flac", "flac", "flac"],
      ["mp3", "libmp3lame", "mp3"], ["m4a", "aac", "ipod"],
      ["alac.m4a", "alac", "ipod"], ["opus", "libopus", "opus"],
      ["ogg", "libvorbis", "ogg"], ["wma", "wmav2", "asf"],
    ];
    const verifySignal = (file) => {
      const pcm = invoke(["-i", file, "-map", "0:a:0", "-vn", "-ar", "48000", "-ac", "2", "-f", "f32le", "-"]);
      const frames = pcm.length / (2 * Float32Array.BYTES_PER_ELEMENT);
      assert.ok(Math.abs(frames - 24000) <= 4096, `${basename(file)}: unexpected frame count ${frames}`);
      let peak = 0;
      for (let offset = 0; offset < pcm.length; offset += 4) peak = Math.max(peak, Math.abs(pcm.readFloatLE(offset)));
      assert.ok(peak > 0.04 && peak < 0.5, `${basename(file)}: invalid/silent signal peak ${peak}`);
    };
    verifySignal(source);
    for (const [extension, encoder, format] of outputs) {
      const output = join(temp, `round trip.${extension}`);
      invoke(["-i", source, "-c:a", encoder, "-f", format, output]);
      verifySignal(output);
    }
    const video = join(temp, "video with sound.mkv");
    invoke(["-f", "lavfi", "-i", "color=size=64x64:duration=0.5:rate=24",
      "-i", source, "-c:v", "libx264", "-c:a", "flac", "-shortest", video]);
    const extracted = join(temp, "extracted sound.wav");
    invoke(["-i", video, "-map", "0:a:0", "-vn", "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", "-rf64", "auto", extracted]);
    assert.ok(existsSync(video), "Video source was removed during extraction");
    verifySignal(extracted);
    const invalid = join(temp, "invalid input.mov");
    writeFileSync(invalid, "This is not a media container.\n");
    assert.throws(() => invoke(["-i", invalid, "-map", "0:a:0", "-vn", "-f", "null", "-"]));
    console.log("Media smoke passed: isolated runtime, 8 export formats, video audio extraction, invalid input.");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/media/smoke.mjs <runtime directory> [executable name]");
  runMediaSmoke(resolve(process.argv[2]), process.argv[3], process.argv[4]);
}
