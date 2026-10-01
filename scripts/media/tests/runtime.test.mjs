/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installFFmpegRuntime, validateFFmpegConfiguration } from "../../ffmpeg-runtime.mjs";

test("runtime configuration requires GPL and rejects nonfree profiles", () => {
  assert.doesNotThrow(() => validateFFmpegConfiguration("ffmpeg version 9.0.2\nconfiguration: --enable-gpl --enable-version3"));
  for (const value of ["", "ffmpeg version 9.0.2", "configuration: --disable-gpl",
    "configuration: --enable-gpl --enable-nonfree", "configuration: --enable-nonfree"])
    assert.throws(() => validateFFmpegConfiguration(value), /GPL codecs/);
});

test("installation renames the worker and includes libraries and notices only", () => {
  const temp = mkdtempSync(join(tmpdir(), "resostage-runtime-test-"));
  try {
    const source = join(temp, "source");
    mkdirSync(join(source, "lib"), { recursive: true });
    mkdirSync(join(source, "licenses"), { recursive: true });
    for (const name of ["ffmpeg", "ffmpeg.exe", "avcodec.dll", "libaudio.so.1", "BUILD.txt", "CONFIGURE.txt", "unrelated.log"])
      writeFileSync(join(source, name), name);
    writeFileSync(join(source, "lib", "audio.dylib"), "dylib");
    writeFileSync(join(source, "licenses", "COPYING.GPLv3"), "license fixture");
    for (const name of ["ResoStage Media", "media.exe", "resostage-media"]) {
      const installed = join(temp, name, name);
      const notices = join(temp, name, "FFmpeg");
      mkdirSync(notices, { recursive: true });
      writeFileSync(join(notices, "obsolete.txt"), "old notice");
      installFFmpegRuntime(source, installed, notices);
      assert.equal(readFileSync(installed, "utf8"), name.endsWith(".exe") ? "ffmpeg.exe" : "ffmpeg");
      for (const dependency of ["avcodec.dll", "libaudio.so.1", "lib/audio.dylib"])
        assert.ok(existsSync(join(temp, name, dependency)));
      assert.ok(existsSync(join(notices, "licenses", "COPYING.GPLv3")));
      assert.equal(readFileSync(join(notices, "BUILD.txt"), "utf8"), "BUILD.txt");
      assert.ok(!existsSync(join(notices, "obsolete.txt")));
      assert.ok(!existsSync(join(temp, name, "unrelated.log")));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
