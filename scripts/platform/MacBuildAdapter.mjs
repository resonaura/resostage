import { existsSync, rmSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { BuildAdapter } from "./BuildAdapter.mjs";
import {
  ROOT,
  BUILD_DIR,
  BUILD_TYPE,
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

import { publishMac } from "../publish.mjs";

export class MacBuildAdapter extends BuildAdapter {
  get key() {
    return "mac";
  }

  getRawCoreAppBundle() {
    const directPath = join(
      BUILD_DIR,
      "app",
      `${APP_TARGET}_artefacts`,
      `${CORE_APP_NAME}.app`,
    );
    if (existsSync(directPath)) return directPath;
    const buildTypePath = join(
      BUILD_DIR,
      "app",
      `${APP_TARGET}_artefacts`,
      BUILD_TYPE,
      `${CORE_APP_NAME}.app`,
    );
    if (existsSync(buildTypePath)) return buildTypePath;
    return directPath;
  }

  getShellAppBundle() {
    return join(BUILD_DIR, "mac", process.arch, `${SHELL_APP_NAME}.app`);
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
    buildElectronShell();
    const rawCore = this.getRawCoreAppBundle();
    if (!existsSync(rawCore)) {
      log(`${rawCore} missing -- skipping shell bundle assembly (build the app first)`);
      return;
    }

    const shellBundle = this.getShellAppBundle();
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

    const coreBuildDir = dirname(rawCore);
    const kaishakuRaw = join(coreBuildDir, "kaishaku");
    if (existsSync(kaishakuRaw)) {
      const kaishakuDst1 = join(resources, "kaishaku");
      rmSync(kaishakuDst1, { force: true });
      cpSync(kaishakuRaw, kaishakuDst1);

      const kaishakuDst2 = join(coreDst, "Contents", "MacOS", "kaishaku");
      rmSync(kaishakuDst2, { force: true });
      cpSync(kaishakuRaw, kaishakuDst2);

      try {
        execFileSync("chmod", ["+x", kaishakuDst1]);
        execFileSync("chmod", ["+x", kaishakuDst2]);
      } catch {}
    }

    run("codesign", ["--force", "--deep", "--sign", "-", shellBundle]);
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
