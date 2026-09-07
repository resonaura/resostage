import { existsSync, rmSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
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

import { publishMac, adhocSignBundle } from "../publish.mjs";

export class MacBuildAdapter extends BuildAdapter {
  get key() {
    return "mac";
  }

  getRawCoreAppBundle() {
    const candidates = [
      join(BUILD_DIR, "app", `${APP_TARGET}_artefacts`, BUILD_TYPE, `${APP_TARGET}.app`),
      join(BUILD_DIR, "app", `${APP_TARGET}_artefacts`, `${APP_TARGET}.app`),
      join(BUILD_DIR, "app", `${APP_TARGET}_artefacts`, BUILD_TYPE, `${CORE_APP_NAME}.app`),
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
    runQuiet("osascript", ["-e", `tell application "${SHELL_APP_NAME}" to quit`]);
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
    const dst = join(this.getRawCoreAppBundle(), "Contents", "Resources", "web");
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
      log(`${rawCore} missing -- skipping shell bundle assembly (build the app first)`);
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
    cpSync(join(ROOT, "electron", "package.json"), join(appDst, "package.json"));
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

    // Post-build icon patching: copy core.icns into ResoStage Core.app
    const coreIcns = join(ROOT, "icons", "core.icns");
    if (existsSync(coreIcns)) {
      const coreIconDst = join(coreDst, "Contents", "Resources", "AppIcon.icns");
      cpSync(coreIcns, coreIconDst, { force: true });
    }

    const kaishakuRawApp =
      findFileRecursively(BUILD_DIR, "ResoStage Kaishaku.app") ??
      findFileRecursively(BUILD_DIR, "kaishaku.app");
    const kaishakuRawBin = findFileRecursively(BUILD_DIR, "kaishaku");
    const kaishakuRaw = kaishakuRawApp ?? kaishakuRawBin;

    if (kaishakuRaw && existsSync(kaishakuRaw)) {
      if (kaishakuRaw.endsWith(".app")) {
        const targetAppName = "ResoStage Kaishaku.app";
        const kaishakuDst1 = join(resources, targetAppName);
        rmSync(kaishakuDst1, { recursive: true, force: true });
        cpSync(kaishakuRaw, kaishakuDst1, { recursive: true });

        const kaishakuDst2 = join(coreDst, "Contents", "Resources", targetAppName);
        rmSync(kaishakuDst2, { recursive: true, force: true });
        cpSync(kaishakuRaw, kaishakuDst2, { recursive: true });

        // Clean up legacy kaishaku.app if present
        const legacy1 = join(resources, "kaishaku.app");
        const legacy2 = join(coreDst, "Contents", "Resources", "kaishaku.app");
        if (existsSync(legacy1)) rmSync(legacy1, { recursive: true, force: true });
        if (existsSync(legacy2)) rmSync(legacy2, { recursive: true, force: true });

        // Copy icon into ResoStage Kaishaku.app if present
        const kaishakuIcns = join(ROOT, "icons", "kaishaku.icns");
        if (existsSync(kaishakuIcns)) {
          const res1 = join(kaishakuDst1, "Contents", "Resources");
          const res2 = join(kaishakuDst2, "Contents", "Resources");
          mkdirSync(res1, { recursive: true });
          mkdirSync(res2, { recursive: true });
          cpSync(kaishakuIcns, join(res1, "AppIcon.icns"), { force: true });
          cpSync(kaishakuIcns, join(res2, "AppIcon.icns"), { force: true });
        }

        try {
          execFileSync("codesign", ["--force", "--deep", "--sign", "-", kaishakuDst1]);
          execFileSync("codesign", ["--force", "--deep", "--sign", "-", kaishakuDst2]);
        } catch {}
      } else {
        const kaishakuDst1 = join(resources, "kaishaku");
        rmSync(kaishakuDst1, { force: true });
        cpSync(kaishakuRaw, kaishakuDst1);

        const kaishakuDst2 = join(coreDst, "Contents", "MacOS", "kaishaku");
        rmSync(kaishakuDst2, { force: true });
        cpSync(kaishakuRaw, kaishakuDst2);

        const kaishakuDst3 = join(shellBundle, "Contents", "MacOS", "kaishaku");
        rmSync(kaishakuDst3, { force: true });
        cpSync(kaishakuRaw, kaishakuDst3);

        try {
          execFileSync("chmod", ["+x", kaishakuDst1]);
          execFileSync("chmod", ["+x", kaishakuDst2]);
          execFileSync("chmod", ["+x", kaishakuDst3]);
        } catch {}
      }
      log(`Bundled kaishaku executioner into shell resources and Core.app`);
    } else {
      log(`Warning: kaishaku raw binary not found in ${BUILD_DIR}`);
    }

    try {
      adhocSignBundle(shellBundle);
    } catch (e) {
      log(`Warning: adhocSignBundle: ${e?.message || e}`);
    }
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
