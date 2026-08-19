import { existsSync, rmSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { NtExecutable, NtExecutableResource, Data, Resource } from "resedit";
import { BuildAdapter } from "./BuildAdapter.mjs";
import {
  ROOT,
  BUILD_DIR,
  PLATFORM_DIST_DIR,
  CORE_APP_NAME,
  SHELL_APP_NAME,
  log,
  ok,
  die,
  runQuiet,
  sleepMs,
  buildElectronShell,
  copyShellRuntimeDeps,
  findFileRecursively,
} from "../lib.mjs";

import { publishWindows } from "../publish.mjs";

export class WinBuildAdapter extends BuildAdapter {
  get key() {
    return "win";
  }

  getRawCoreAppBundle() {
    const artefactsDir = join(BUILD_DIR, "app", "ResoStage_artefacts");
    return (
      findFileRecursively(artefactsDir, "ResoStage.exe") ??
      findFileRecursively(artefactsDir, "ResoStage") ??
      findFileRecursively(artefactsDir, `${CORE_APP_NAME}.exe`) ??
      findFileRecursively(artefactsDir, CORE_APP_NAME) ??
      join(artefactsDir, "ResoStage.exe")
    );
  }

  getShellAppBundle() {
    return join(PLATFORM_DIST_DIR, `${SHELL_APP_NAME}.exe`);
  }

  shellExecutablePath() {
    return this.getShellAppBundle();
  }

  appIsRunning() {
    const exe = basename(this.shellExecutablePath());
    const result = runQuiet("tasklist", ["/FI", `IMAGENAME eq ${exe}`, "/FO", "CSV", "/NH"]);
    const shellUp = result.status === 0 && result.stdout.includes(exe);
    if (shellUp) return true;
    const coreResult = runQuiet("tasklist", ["/FI", `IMAGENAME eq ${CORE_APP_NAME}.exe`, "/FO", "CSV", "/NH"]);
    return coreResult.status === 0 && coreResult.stdout.includes(`${CORE_APP_NAME}.exe`);
  }

  killApp({ bestEffort = false } = {}) {
    if (!this.appIsRunning()) {
      log(`${SHELL_APP_NAME} is not running`);
      return;
    }
    log(`Stopping ${SHELL_APP_NAME}...`);
    const exe = basename(this.shellExecutablePath());
    runQuiet("taskkill", ["/IM", exe, "/F", "/T"]);
    runQuiet("taskkill", ["/IM", `${CORE_APP_NAME}.exe`, "/F"]);
    runQuiet("taskkill", ["/IM", "core.exe", "/F"]);
    sleepMs(500);

    if (this.appIsRunning()) {
      if (bestEffort) {
        log(`Warning: could not stop ${SHELL_APP_NAME} -- continuing anyway`);
        return;
      }
      die(`Could not stop ${SHELL_APP_NAME}`);
    }
    ok(`${SHELL_APP_NAME} stopped`);
  }

  embedWebUi() {
    const webSrc = join(ROOT, "ui", "dist");
    const shellDir = dirname(this.getShellAppBundle());
    const webDst = join(shellDir, "resources", "web");
    if (existsSync(webSrc)) {
      mkdirSync(dirname(webDst), { recursive: true });
      rmSync(webDst, { recursive: true, force: true });
      cpSync(webSrc, webDst, { recursive: true });
      ok(`Web UI copied -> ${webDst}`);
    }
  }

  patchWindowsExeMetadata(exePath, icoPath, exeName = "resostage.exe") {
    const exe = NtExecutable.from(readFileSync(exePath));
    const res = NtExecutableResource.from(exe);

    if (icoPath && existsSync(icoPath)) {
      const iconFile = Data.IconFile.from(readFileSync(icoPath));
      const RT_ICON = 3;
      const RT_GROUP_ICON = 14;
      res.entries = res.entries.filter((e) => e.type !== RT_ICON && e.type !== RT_GROUP_ICON);
      Resource.IconGroupEntry.replaceIconsForResource(
        res.entries,
        1,
        1033,
        iconFile.icons.map((item) => item.data),
      );
    }

    const desc =
      exeName === "core.exe"
        ? "ResoStage Core"
        : exeName === "kaishaku.exe"
          ? "ResoStage Kaishaku"
          : "ResoStage";

    let versionInfos = Resource.VersionInfo.fromEntries(res.entries);
    if (!versionInfos || versionInfos.length === 0) {
      const newVi = Resource.VersionInfo.createEmpty();
      newVi.setFileVersion(1, 0, 0, 0);
      newVi.setProductVersion(1, 0, 0, 0);
      versionInfos = [newVi];
    }

    for (const info of versionInfos) {
      const stringValues = {
        FileDescription: desc,
        ProductName: desc,
        CompanyName: "Resonaura",
        InternalName: exeName,
        OriginalFilename: exeName,
        LegalCopyright: "Copyright © Resonaura",
        FileVersion: "0.1.0.0",
        ProductVersion: "0.1.0.0",
      };
      const langs = info.getAvailableLanguages();
      if (langs && langs.length > 0) {
        for (const l of langs) {
          info.setStringValues(l, stringValues);
        }
      }
      info.setStringValues({ lang: 1033, codepage: 1200 }, stringValues);
      info.outputToResourceEntries(res.entries);
    }

    res.outputResource(exe);
    writeFileSync(exePath, Buffer.from(exe.generate()));
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
    if (!existsSync(electronDistSrc)) {
      die(`Electron runtime not found at ${electronDistSrc} (run pnpm install)`);
    }
    cpSync(electronDistSrc, shellDir, { recursive: true });

    const requiredRuntime = [
      "electron.exe",
      "chrome_100_percent.pak",
      "chrome_200_percent.pak",
      "d3dcompiler_47.dll",
      "resources.pak",
      "snapshot_blob.bin",
    ];
    const missingRuntime = requiredRuntime.filter(
      (f) => !existsSync(join(shellDir, f)),
    );
    if (missingRuntime.length) {
      die(`Electron runtime incomplete: missing ${missingRuntime.join(", ")} in ${shellDir}`);
    }

    const electronExeSrc = join(shellDir, "electron.exe");
    if (!existsSync(electronExeSrc)) {
      die(`Electron executable not found at ${electronExeSrc}`);
    }
    const oldShellExe = join(shellDir, "ResoStage.exe");
    if (existsSync(oldShellExe)) rmSync(oldShellExe, { force: true });
    if (existsSync(shellBundle)) rmSync(shellBundle, { force: true });
    cpSync(electronExeSrc, shellBundle);
    rmSync(electronExeSrc, { force: true });

    const appIco = join(ROOT, "icons", "app.ico");
    this.patchWindowsExeMetadata(shellBundle, existsSync(appIco) ? appIco : null, "resostage.exe");

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
    }

    const webSrc = join(ROOT, "ui", "dist");
    if (existsSync(webSrc)) {
      const webDst = join(shellDir, "resources", "web");
      rmSync(webDst, { recursive: true, force: true });
      cpSync(webSrc, webDst, { recursive: true });
    }

    const coreDst = join(shellDir, `${CORE_APP_NAME}.exe`);
    const coreDstShort = join(shellDir, "core.exe");
    if (existsSync(coreDst)) rmSync(coreDst, { force: true });
    if (existsSync(coreDstShort)) rmSync(coreDstShort, { force: true });
    if (rawCore && existsSync(rawCore)) {
      cpSync(rawCore, coreDst);
      cpSync(rawCore, coreDstShort);
      const coreIco = join(ROOT, "icons", "core.ico");
      this.patchWindowsExeMetadata(coreDst, existsSync(coreIco) ? coreIco : null, "core.exe");
      this.patchWindowsExeMetadata(coreDstShort, existsSync(coreIco) ? coreIco : null, "core.exe");
    }

    const kaishakuDst = join(shellDir, "kaishaku.exe");
    const kaishakuRaw =
      findFileRecursively(BUILD_DIR, "kaishaku.exe") ??
      join(coreBuildDir, "kaishaku.exe");
    if (kaishakuRaw && existsSync(kaishakuRaw)) {
      if (existsSync(kaishakuDst)) rmSync(kaishakuDst, { force: true });
      cpSync(kaishakuRaw, kaishakuDst);
      const kaishakuIco = join(ROOT, "icons", "kaishaku.ico");
      this.patchWindowsExeMetadata(kaishakuDst, existsSync(kaishakuIco) ? kaishakuIco : null, "kaishaku.exe");
    }

    ok(`Assembled ${shellBundle}`);
  }

  publish() {
    publishWindows();
  }
}

export { WinBuildAdapter as WindowsBuildAdapter };
