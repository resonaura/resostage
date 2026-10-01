// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { existsSync, rmSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { BuildAdapter } from "./BuildAdapter.mjs";
import {
  ROOT,
  BUILD_DIR,
  BUILD_TYPE,
  PLATFORM_DIST_DIR,
  APP_TARGET,
  CORE_APP_NAME,
  SHELL_APP_NAME,
  log,
  ok,
  run,
  runQuiet,
  sleepMs,
  buildElectronShell,
  copyShellRuntimeDeps,
  findFileRecursively,
} from "../lib.mjs";

import { publishMac, adhocSignBundle, ENTITLEMENTS } from "../publish.mjs";

export class MacBuildAdapter extends BuildAdapter {
  get key() {
    return "mac";
  }

  getRawCoreAppBundle() {
    const candidates = [
      join(
        BUILD_DIR,
        "app",
        `${APP_TARGET}_artefacts`,
        BUILD_TYPE,
        `${APP_TARGET}.app`,
      ),
      join(BUILD_DIR, "app", `${APP_TARGET}_artefacts`, `${APP_TARGET}.app`),
      join(
        BUILD_DIR,
        "app",
        `${APP_TARGET}_artefacts`,
        BUILD_TYPE,
        `${CORE_APP_NAME}.app`,
      ),
      join(BUILD_DIR, "app", `${APP_TARGET}_artefacts`, `${CORE_APP_NAME}.app`),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return candidates[0];
  }

  getShellAppBundle() {
    return join(PLATFORM_DIST_DIR, `${SHELL_APP_NAME}.app`);
  }

  shellExecutablePath() {
    return join(this.getShellAppBundle(), "Contents", "MacOS", SHELL_APP_NAME);
  }

  appIsRunning() {
    return runQuiet("pgrep", ["-f", this.shellExecutablePath()]).status === 0;
  }

  killApp({ bestEffort = false } = {}) {
    if (!this.appIsRunning()) {
      log(`${SHELL_APP_NAME} is not running`);
      return;
    }
    log(`Stopping ${SHELL_APP_NAME}...`);
    runQuiet("osascript", [
      "-e",
      `tell application "${SHELL_APP_NAME}" to quit`,
    ]);
    for (let i = 0; i < 8; i++) {
      if (!this.appIsRunning()) {
        ok(`${SHELL_APP_NAME} stopped`);
        return;
      }
      sleepMs(250);
    }
    const exe = this.shellExecutablePath();
    runQuiet("pkill", ["-f", exe]);
    sleepMs(300);
    if (this.appIsRunning()) {
      log(`Force-killing ${SHELL_APP_NAME}...`);
      runQuiet("pkill", ["-9", "-f", exe]);
    }
    runQuiet("pkill", [
      "-f",
      `${CORE_APP_NAME}.app/Contents/MacOS/${CORE_APP_NAME}`,
    ]);

    if (this.appIsRunning()) {
      if (bestEffort) {
        log(`Warning: could not stop ${SHELL_APP_NAME} -- continuing anyway`);
        return;
      }
      throw new Error(`Could not stop ${SHELL_APP_NAME}`);
    }
    ok(`${SHELL_APP_NAME} stopped`);
  }

  embedWebUi() {
    const src = join(ROOT, "ui", "dist");
    if (!existsSync(src)) {
      log("ui/dist missing -- skipping web UI embed (run pnpm build:ui first)");
      return;
    }
    const dst = join(
      this.getRawCoreAppBundle(),
      "Contents",
      "Resources",
      "web",
    );
    log(`Embedding web UI -> ${dst}`);
    cpSync(src, dst, { recursive: true });
    ok("Web UI embedded as folder (Resources/web)");
  }

  assembleShellBundle() {
    this.killApp({ bestEffort: true });
    for (let i = 0; i < 20 && this.appIsRunning(); i++) sleepMs(250);

    buildElectronShell();
    const rawCore = this.getRawCoreAppBundle();
    if (!existsSync(rawCore)) {
      log(
        `${rawCore} missing -- skipping shell bundle assembly (build the app first)`,
      );
      return;
    }

    const shellBundle = this.getShellAppBundle();
    if (existsSync(shellBundle)) {
      log(`Cleaning old app bundle at ${shellBundle}...`);
      rmSync(shellBundle, { recursive: true, force: true });
    }

    log(`Assembling ${shellBundle}...`);
    run("node", [
      join(ROOT, "electron", "scripts", "brand-mac-app.mjs"),
      shellBundle,
    ]);

    const resources = join(shellBundle, "Contents", "Resources");
    const appDst = join(resources, "app");
    run("rm", ["-rf", appDst]);
    run("mkdir", ["-p", appDst]);
    cpSync(
      join(ROOT, "electron", "package.json"),
      join(appDst, "package.json"),
    );
    cpSync(join(ROOT, "electron", "dist"), join(appDst, "dist"), {
      recursive: true,
    });
    copyShellRuntimeDeps(appDst);

    const macIconsSrc = join(ROOT, "icons");
    if (existsSync(macIconsSrc)) {
      cpSync(macIconsSrc, join(appDst, "icons"), { recursive: true });
      cpSync(macIconsSrc, join(resources, "icons"), { recursive: true });
    }

    const coreDst = join(resources, `${CORE_APP_NAME}.app`);
    rmSync(coreDst, { recursive: true, force: true });
    cpSync(rawCore, coreDst, { recursive: true });

    // JUCE/CMake may reuse a generated Info.plist from an older configure.
    // The nested Core process (not Chromium) opens CoreAudio inputs, so its
    // own bundle must always carry the microphone purpose string.
    const corePlist = join(coreDst, "Contents", "Info.plist");
    const microphonePurpose =
      "ResoStage uses audio inputs for recording and real-time input monitoring.";
    try {
      execFileSync(
        "/usr/bin/plutil",
        [
          "-replace",
          "NSMicrophoneUsageDescription",
          "-string",
          microphonePurpose,
          corePlist,
        ],
        { stdio: "ignore" },
      );
    } catch {
      execFileSync("/usr/bin/plutil", [
        "-insert",
        "NSMicrophoneUsageDescription",
        "-string",
        microphonePurpose,
        corePlist,
      ]);
    }

    // Post-build icon patching: copy core.icns into ResoStage Core.app
    const coreIcns = join(ROOT, "icons", "core.icns");
    if (existsSync(coreIcns)) {
      const coreIconDst = join(
        coreDst,
        "Contents",
        "Resources",
        "AppIcon.icns",
      );
      cpSync(coreIcns, coreIconDst, { force: true });
      // The icon file alone is not enough: JUCE's generated plist can leave
      // CFBundleIconFile empty, in which case macOS shows a generic icon.
      execFileSync("/usr/bin/plutil", [
        "-replace", "CFBundleIconFile", "-string", "AppIcon.icns", corePlist,
      ]);
    }

    const hostRaw = join(
      BUILD_DIR, "app", "resostage_plugin_host_artefacts", BUILD_TYPE,
      "ResoStage Plug-in Host",
    );
    if (!existsSync(hostRaw)) {
      throw new Error("Live plug-in host executable is missing from the native build");
    }
    const hostBundle = join(coreDst, "Contents", "Helpers", "ResoStage Plug-in Host.app");
    const hostContents = join(hostBundle, "Contents");
    const hostMacOS = join(hostContents, "MacOS");
    const hostResources = join(hostContents, "Resources");
    mkdirSync(hostMacOS, { recursive: true });
    mkdirSync(hostResources, { recursive: true });
    // Keep the helper's asset separate from Core's. A dedicated host icon can
    // be added later without changing the bundle layout or executable path.
    const dedicatedHostIcon = join(ROOT, "icons", "plugin-host.icns");
    const hostIcon = existsSync(dedicatedHostIcon) ? dedicatedHostIcon : coreIcns;
    if (!existsSync(hostIcon)) {
      throw new Error(`Live plug-in host icon is missing: ${hostIcon}`);
    }
    cpSync(hostRaw, join(hostMacOS, "ResoStage Plug-in Host"));
    // Raw CMake copies a sibling helper beside Core's executable. The
    // shipping bundle launches the branded nested app instead.
    rmSync(join(coreDst, "Contents", "MacOS", "ResoStage Plug-in Host"), {
      force: true,
    });
    // CMake does not delete artifacts left by an older OUTPUT_NAME, so a
    // reused build directory can carry stale lowercase siblings into the app.
    rmSync(join(coreDst, "Contents", "MacOS", "resostage-plugin-host"), {
      force: true,
    });
    rmSync(join(coreDst, "Contents", "MacOS", "resostage-plugin-scanner"), {
      force: true,
    });
    cpSync(hostIcon, join(hostResources, "AppIcon.icns"));
    const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    if (!/^\d+(?:\.\d+){0,3}$/.test(version)) {
      throw new Error(`Invalid ResoStage bundle version: ${version}`);
    }
    writeFileSync(join(hostContents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.resonaura.resostage.pluginhost</string>
  <key>CFBundleName</key><string>ResoStage Plug-in Host</string>
  <key>CFBundleDisplayName</key><string>ResoStage Plug-in Host</string>
  <key>CFBundleExecutable</key><string>ResoStage Plug-in Host</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon.icns</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleGetInfoString</key><string>ResoStage isolated live plug-in host</string>
  <key>NSHumanReadableCopyright</key><string>Copyright Resonaura</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);
    execFileSync("/usr/bin/plutil", ["-lint", join(hostContents, "Info.plist")], {
      stdio: "ignore",
    });

    const kaishakuRawApp =
      findFileRecursively(BUILD_DIR, "ResoStage Kaishaku.app") ??
      findFileRecursively(BUILD_DIR, "kaishaku.app");
    const kaishakuRawBin = findFileRecursively(BUILD_DIR, "kaishaku");
    const kaishakuRaw = kaishakuRawApp ?? kaishakuRawBin;

    if (kaishakuRaw && existsSync(kaishakuRaw)) {
      if (kaishakuRaw.endsWith(".app")) {
        const targetAppName = "ResoStage Kaishaku.app";
        // Core and Electron both locate the one helper bundled inside Core;
        // duplicating this GUI app in the outer shell doubled packaged size
        // and made Finder show two indistinguishable applications.
        const kaishakuDst = join(
          coreDst,
          "Contents",
          "Resources",
          targetAppName,
        );
        rmSync(kaishakuDst, { recursive: true, force: true });
        cpSync(kaishakuRaw, kaishakuDst, { recursive: true });

        // Clean up legacy kaishaku.app if present
        const legacy1 = join(resources, "kaishaku.app");
        const legacy2 = join(coreDst, "Contents", "Resources", "kaishaku.app");
        if (existsSync(legacy1)) rmSync(legacy1, { recursive: true, force: true });
        if (existsSync(legacy2))
          rmSync(legacy2, { recursive: true, force: true });

        // Copy icon into ResoStage Kaishaku.app if present
        const kaishakuIcns = join(ROOT, "icons", "kaishaku.icns");
        if (existsSync(kaishakuIcns)) {
          const appResources = join(kaishakuDst, "Contents", "Resources");
          mkdirSync(appResources, { recursive: true });
          cpSync(kaishakuIcns, join(appResources, "AppIcon.icns"), { force: true });
        }

        try {
          execFileSync("codesign", [
            "--force",
            "--deep",
            "--sign",
            "-",
            kaishakuDst,
          ]);
        } catch {}
      } else {
        const kaishakuDst = join(coreDst, "Contents", "Resources", "kaishaku");
        rmSync(kaishakuDst, { force: true });
        cpSync(kaishakuRaw, kaishakuDst);

        try {
          execFileSync("chmod", ["+x", kaishakuDst]);
        } catch {}
      }
      log(`Bundled one Kaishaku executioner inside Core.app for Core and shell reuse`);
    } else {
      log(`Warning: kaishaku raw binary not found in ${BUILD_DIR}`);
    }

    const entitlementsPath = join(resources, "entitlements.plist");
    writeFileSync(entitlementsPath, ENTITLEMENTS);
    // A missing/expired local certificate must not make `pnpm dev`
    // unusable. Publish remains strict; development explicitly falls back
    // to an ad-hoc signature and prints the TCC persistence trade-off.
    adhocSignBundle(shellBundle, entitlementsPath, {
      allowAdhocFallback: true,
      allowLocalIdentity: true,
    });
    try {
      const lsregister =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
      if (existsSync(lsregister)) {
        execFileSync(lsregister, ["-f", shellBundle]);
      }
    } catch {}
    ok(`Assembled ${shellBundle}`);
  }

  publish() {
    publishMac();
  }
}
