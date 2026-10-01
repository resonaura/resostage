/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { installFFmpegRuntime, verifyFFmpegRuntime } from "../ffmpeg-runtime.mjs";

/** Installs the complete media worker before the containing Core app is signed. */
export function installMacMediaHelper(runtime, coreBundle, repoRoot, arch) {
  const name = "ResoStage Media";
  const contents = join(coreBundle, "Contents", "Helpers", `${name}.app`, "Contents");
  const executableDirectory = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  mkdirSync(resources, { recursive: true });
  installFFmpegRuntime(runtime, join(executableDirectory, name), join(resources, "FFmpeg"));
  const dedicatedIcon = join(repoRoot, "icons", "media.icns");
  const icon = existsSync(dedicatedIcon) ? dedicatedIcon : join(repoRoot, "icons", "core.icns");
  if (!existsSync(icon)) throw new Error(`Media helper icon is missing: ${icon}`);
  cpSync(icon, join(resources, "AppIcon.icns"));
  const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error(`Invalid bundle version: ${version}`);
  writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.resonaura.resostage.media</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon.icns</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleGetInfoString</key><string>ResoStage audio and video media conversion worker (FFmpeg)</string>
  <key>NSHumanReadableCopyright</key><string>FFmpeg and its contributors; see Resources/FFmpeg</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);
  execFileSync("/usr/bin/plutil", ["-lint", join(contents, "Info.plist")], { stdio: "pipe" });
  verifyFFmpegRuntime(executableDirectory, "darwin", arch, name);
}
