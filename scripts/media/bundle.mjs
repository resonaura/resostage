/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installFFmpegRuntime, verifyFFmpegRuntime } from "../ffmpeg-runtime.mjs";
import { brandMacHelper } from "../helpers/bundle.mjs";

/** Installs the complete media worker before the containing Core app is signed. */
export function installMacMediaHelper(runtime, coreBundle, repoRoot, arch) {
  const name = "ResoStage Media";
  const bundle = join(coreBundle, "Contents", "Helpers", `${name}.app`);
  const contents = join(bundle, "Contents");
  const executableDirectory = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  mkdirSync(resources, { recursive: true });
  installFFmpegRuntime(runtime, join(executableDirectory, name), join(resources, "FFmpeg"));
  brandMacHelper(bundle, repoRoot, { name, bundleId: "com.resonaura.resostage.media",
    description: "ResoStage audio and video media conversion worker (FFmpeg)",
    copyright: "FFmpeg and its contributors; see Resources/FFmpeg" });
  verifyFFmpegRuntime(executableDirectory, "darwin", arch, name);
}
