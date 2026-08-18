import { existsSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { BuildAdapter } from "./BuildAdapter.mjs";
import {
  ROOT,
  BUILD_DIR,
  PLATFORM_DIST_DIR,
  CORE_APP_NAME,
  SHELL_APP_NAME,
  log,
  ok,
  runQuiet,
  sleepMs,
  buildElectronShell,
  copyShellRuntimeDeps,
  findFileRecursively,
} from "../lib.mjs";

import { publishLinux } from "../publish.mjs";

export class LinuxBuildAdapter extends BuildAdapter {
  get key() {
    return "linux";
  }

  getRawCoreAppBundle() {
    const artefactsDir = join(BUILD_DIR, "app", "ResoStage_artefacts");
    return (
      findFileRecursively(artefactsDir, "ResoStage") ??
      findFileRecursively(artefactsDir, CORE_APP_NAME) ??
      join(artefactsDir, "ResoStage")
    );
  }

  getShellAppBundle() {
    return join(PLATFORM_DIST_DIR, SHELL_APP_NAME);
  }

  shellExecutablePath() {
    return this.getShellAppBundle();
  }

  appIsRunning() {
    const exe = basename(this.shellExecutablePath());
    return runQuiet("pgrep", ["-f", exe]).status === 0;
  }

  killApp({ bestEffort = false } = {}) {
    if (!this.appIsRunning()) {
      log(`${SHELL_APP_NAME} is not running`);
      return;
    }
    log(`Stopping ${SHELL_APP_NAME}...`);
    const exe = basename(this.shellExecutablePath());
    runQuiet("pkill", ["-f", exe]);
    sleepMs(300);

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
    log("Skipping web UI embed (Linux uses resources/web)");
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
    const shellDir = dirname(shellBundle);
    if (existsSync(shellDir)) {
      log(`Cleaning old build directory at ${shellDir}...`);
      rmSync(shellDir, { recursive: true, force: true });
    }

    log(`Assembling ${shellBundle}...`);
    mkdirSync(shellDir, { recursive: true });

    const electronDistSrc = join(
      ROOT,
      "electron",
      "node_modules",
      "electron",
      "dist",
    );
    if (existsSync(electronDistSrc)) {
      cpSync(electronDistSrc, shellDir, { recursive: true });
      const electronBinSrc = join(shellDir, "electron");
      if (existsSync(electronBinSrc)) {
        if (existsSync(shellBundle)) rmSync(shellBundle, { force: true });
        cpSync(electronBinSrc, shellBundle);
        rmSync(electronBinSrc, { force: true });
        try {
          execFileSync("chmod", ["+x", shellBundle]);
        } catch {}
      }
    }

    const appDst = join(shellDir, "resources", "app");
    rmSync(appDst, { recursive: true, force: true });
    mkdirSync(appDst, { recursive: true });
    cpSync(join(ROOT, "electron", "package.json"), join(appDst, "package.json"));
    cpSync(join(ROOT, "electron", "dist"), join(appDst, "dist"), {
      recursive: true,
    });
    copyShellRuntimeDeps(appDst);

    const iconsSrc = join(ROOT, "icons");
    if (existsSync(iconsSrc)) {
      cpSync(iconsSrc, join(appDst, "icons"), { recursive: true });
      cpSync(iconsSrc, join(shellDir, "resources", "icons"), { recursive: true });
    }

    const webSrc = join(ROOT, "ui", "dist");
    if (existsSync(webSrc)) {
      const webDst = join(shellDir, "resources", "web");
      rmSync(webDst, { recursive: true, force: true });
      cpSync(webSrc, webDst, { recursive: true });
    }

    const coreDst = join(shellDir, CORE_APP_NAME);
    const coreDstShort = join(shellDir, "core");
    if (existsSync(coreDst)) rmSync(coreDst, { force: true });
    if (existsSync(coreDstShort)) rmSync(coreDstShort, { force: true });
    if (rawCore && existsSync(rawCore)) {
      cpSync(rawCore, coreDst);
      cpSync(rawCore, coreDstShort);
      try {
        execFileSync("chmod", ["+x", coreDst]);
        execFileSync("chmod", ["+x", coreDstShort]);
      } catch {}
    }

    const kaishakuDst = join(shellDir, "kaishaku");
    const kaishakuRaw = join(coreBuildDir, "kaishaku");
    if (existsSync(kaishakuRaw)) {
      if (existsSync(kaishakuDst)) rmSync(kaishakuDst, { force: true });
      cpSync(kaishakuRaw, kaishakuDst);
      try {
        execFileSync("chmod", ["+x", kaishakuDst]);
      } catch {}
    }

    ok(`Assembled ${shellBundle}`);
  }

  publish() {
    publishLinux();
  }
}
