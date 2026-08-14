/**
 * Shared helpers for root pnpm / Node scripts (ESM).
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NtExecutable, NtExecutableResource, Data, Resource } from "resedit";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, "..");
// All native C++ (JUCE app + engine + vendor + tools + tests) lives under
// core/ -- CMake is invoked with this as the source root. The raw/dirty
// CMake build tree also lives under core/ (core/build) -- it's disposable
// intermediate output, distinct from the clean distributable assembled
// below at the true repo root's build/<platform>/<arch>/.
export const CORE_DIR = join(ROOT, "core");
export const BUILD_DIR = process.env.BUILD_DIR || join(CORE_DIR, "build");
// RelWithDebInfo, not Debug: the engine's render path is per-sample DSP, and an
// unoptimised build of it costs ~3x the CPU of an optimised one -- enough, on a
// rig with many outputs and sends, to turn a comfortable audio block into a
// dropout. -O2 with full debug symbols keeps stack traces and source-level
// debugging usable, so this buys the speed without giving up diagnosability.
// Override per-invocation with BUILD_TYPE=Debug for a genuine unoptimised build.
export const BUILD_TYPE = process.env.BUILD_TYPE || "RelWithDebInfo";
// CMake target + JUCE artefact dir. Kept "ResoStage" even though the bundle
// is now branded "ResoStage Core" -- the target name drives _artefacts/.
export const APP_TARGET = "ResoStage";
// The nested JUCE backend bundle (juce_add_gui_app PRODUCT_NAME) vs. the
// outer Electron shell bundle the user actually launches -- see
// getShellAppBundle()/getNestedCoreAppBundle() below. Both stay quoted
// anywhere used (they contain spaces).
export const CORE_APP_NAME = "ResoStage Core";
export const SHELL_APP_NAME = "ResoStage";

function platformDirName() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  if (process.platform === "linux") return "linux";
  return process.platform;
}

// Clean distributable output root: build/<platform>/<arch>/ResoStage.app --
// the ONE thing both `pnpm run rebuild:run` and a real release launch, so
// dev iteration never diverges from what actually ships.
export const DIST_DIR = process.env.DIST_DIR || join(ROOT, "build");
export const PLATFORM_DIST_DIR = join(
  DIST_DIR,
  platformDirName(),
  process.arch,
);

// NOTE: call these fresh at each use site rather than caching the result --
// rebuild:run builds and launches in the same process, so a module-level
// constant computed at import time (before the build exists) would stay
// stale for the rest of the run.
export function getShellAppBundle() {
  if (process.platform === "darwin") {
    return join(PLATFORM_DIST_DIR, `${SHELL_APP_NAME}.app`);
  } else if (process.platform === "win32") {
    return join(PLATFORM_DIST_DIR, `${SHELL_APP_NAME}.exe`);
  } else {
    return join(PLATFORM_DIST_DIR, SHELL_APP_NAME);
  }
}
export function getNestedCoreAppBundle(shellBundle = getShellAppBundle()) {
  return join(shellBundle, "Contents", "Resources", `${CORE_APP_NAME}.app`);
}
// Raw JUCE build output straight out of CMake (core/build/), before it gets
// copied into the assembled shell bundle above.
// Deep-first search for a named file under a dir (used to find the Core exe
// regardless of which CMake generator / config produced it).
function findFileRecursively(dir, name) {
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFileRecursively(full, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return full;
    }
  }
  return null;
}

export function getRawCoreAppBundle() {
  if (process.platform === "win32") {
    const artefactsDir = join(
      BUILD_DIR,
      "app",
      `${APP_TARGET}_artefacts`,
    );
    // Prefer the configured build type. MSBuild multi-config generators put
    // the exe under <Config>/, Ninja single-config under the build type, so
    // fall back to scanning whatever the generator actually produced.
    const preferred = join(artefactsDir, BUILD_TYPE, `${CORE_APP_NAME}.exe`);
    if (existsSync(preferred)) return preferred;
    return (
      findFileRecursively(artefactsDir, `${CORE_APP_NAME}.exe`) ??
      join(artefactsDir, `${CORE_APP_NAME}.exe`)
    );
  }
  // macOS: .app bundle
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

export const TEST_BINARY =
  process.env.TEST_BINARY || join(BUILD_DIR, "tests", "resostage_engine_tests");
export const JOBS = Number(process.env.JOBS) || cpus().length || 4;

export function log(msg) {
  console.log(`→ ${msg}`);
}

export function ok(msg) {
  console.log(`✓ ${msg}`);
}

export function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/**
 * Run a command, inherit stdio. Throws / exits on non-zero unless `okExit` set.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, allowFail?: boolean }} [opts]
 */
export function run(cmd, args = [], opts = {}) {
  const { cwd = ROOT, env = process.env, allowFail = false } = opts;
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: true,
  });
  if (r.error) {
    if (allowFail) return r.status ?? 1;
    die(`${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) {
    process.exit(r.status ?? 1);
  }
  return r.status ?? 0;
}

/** Quiet command; returns { status, stdout, stderr }. */
export function runQuiet(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
    encoding: "utf8",
    shell: false,
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

export function sleepMs(ms) {
  spawnSync(
    process.execPath,
    ["-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`],
    {
      stdio: "ignore",
    },
  );
}

// Reads CMAKE_BUILD_TYPE back out of an existing cache, so a BUILD_TYPE change
// actually takes effect instead of silently reusing whatever the build dir was
// first configured with. Without this the default below would have been
// invisible on every machine that had already built once.
function cachedBuildType() {
  const cache = join(BUILD_DIR, "CMakeCache.txt");
  if (!existsSync(cache)) return null;
  const line = readFileSync(cache, "utf8")
    .split("\n")
    .find((l) => l.startsWith("CMAKE_BUILD_TYPE:"));
  return line ? line.slice(line.indexOf("=") + 1).trim() : null;
}

export function ensureCmakeConfigured() {
  const cached = cachedBuildType();
  if (cached === BUILD_TYPE) return;
  if (cached === null)
    log(
      `CMake not configured at ${BUILD_DIR} -- configuring (${BUILD_TYPE})...`,
    );
  else
    log(
      `Build type changed (${cached} -> ${BUILD_TYPE}) -- reconfiguring ${BUILD_DIR}...`,
    );
  run("cmake", [
    "-S",
    CORE_DIR,
    "-B",
    BUILD_DIR,
    `-DCMAKE_BUILD_TYPE=${BUILD_TYPE}`,
  ]);
}

export function cmakeBuild(target) {
  ensureCmakeConfigured();
  const args = ["--build", BUILD_DIR, `-j${JOBS}`];
  // Multi-config generators (Visual Studio) pick the configuration from
  // --config, NOT from CMAKE_BUILD_TYPE -- without this they build Debug by
  // default and the output lands in a <Config>/ subdir the rest of the build
  // doesn't look in. Harmless for single-config Ninja/Makefiles.
  if (process.platform === "win32") {
    args.push("--config", BUILD_TYPE);
  }
  if (target) {
    args.push("--target", target);
    log(`cmake --build ${BUILD_DIR} --target ${target} -j${JOBS}`);
  } else {
    log(`cmake --build ${BUILD_DIR} -j${JOBS}`);
  }
  run("cmake", args);
}

// The shipped/launched process is the Electron shell, fully rebranded by
// electron/scripts/brand-mac-app.mjs (executable renamed "Electron" ->
// SHELL_APP_NAME, same as CFBundleExecutable) -- matching by full path (-f),
// not just short process name, so this doesn't catch unrelated Electron
// apps running on the same machine.
function shellExecutablePath() {
  if (process.platform === "darwin") {
    return join(getShellAppBundle(), "Contents", "MacOS", SHELL_APP_NAME);
  } else if (process.platform === "win32") {
    return getShellAppBundle();
  } else {
    return getShellAppBundle();
  }
}

export function appIsRunning() {
  if (process.platform === "darwin") {
    return runQuiet("pgrep", ["-f", shellExecutablePath()]).status === 0;
  } else if (process.platform === "win32") {
    const exe = path.basename(shellExecutablePath());
    const result = runQuiet("tasklist", ["/FI", `IMAGENAME eq ${exe}`, "/FO", "CSV", "/NH"]);
    // tasklist returns 0 even when no matches; check output for actual process
    const shellUp = result.status === 0 && result.stdout.includes(exe);
    if (shellUp) return true;
    // The nested Core can outlive the shell; treat it as "running" too so
    // killApp() still takes it down (avoids a stale Core on :2899).
    const coreResult = runQuiet("tasklist", ["/FI", `IMAGENAME eq ${CORE_APP_NAME}.exe`, "/FO", "CSV", "/NH"]);
    return coreResult.status === 0 && coreResult.stdout.includes(`${CORE_APP_NAME}.exe`);
  } else {
    // Linux: check for process by name
    const exe = path.basename(shellExecutablePath());
    return runQuiet("pgrep", ["-f", exe]).status === 0;
  }
}

export function killApp({ bestEffort = false } = {}) {
  if (!appIsRunning()) {
    log(`${SHELL_APP_NAME} is not running`);
    return;
  }
  log(`Stopping ${SHELL_APP_NAME}...`);
  
  if (process.platform === "darwin") {
    // Prefer AppleEvent quit so save dialogs can finish, then escalate.
    runQuiet("osascript", ["-e", `tell application "${SHELL_APP_NAME}" to quit`]);
    for (let i = 0; i < 8; i++) {
      if (!appIsRunning()) {
        ok(`${SHELL_APP_NAME} stopped`);
        return;
      }
      sleepMs(250);
    }
    const exe = shellExecutablePath();
    runQuiet("pkill", ["-f", exe]);
    sleepMs(300);
    if (appIsRunning()) {
      log(`Force-killing ${SHELL_APP_NAME}...`);
      runQuiet("pkill", ["-9", "-f", exe]);
    }
    runQuiet("pkill", [
      "-f",
      `${CORE_APP_NAME}.app/Contents/MacOS/${CORE_APP_NAME}`,
    ]);
  } else if (process.platform === "win32") {
    const exe = path.basename(shellExecutablePath());
    runQuiet("taskkill", ["/IM", exe, "/F", "/T"]);
    // The nested JUCE Core stays bound to :2899 even after the shell exits;
    // a lingering ResoStage Core.exe would serve stale assets / steal the
    // port and cause a black window, so kill it too (mirrors the mac pkill).
    runQuiet("taskkill", ["/IM", `${CORE_APP_NAME}.exe`, "/F"]);
    sleepMs(500);
  } else {
    // Linux
    const exe = path.basename(shellExecutablePath());
    runQuiet("pkill", ["-f", exe]);
    sleepMs(300);
  }
  
  if (appIsRunning()) {
    if (bestEffort) {
      log(`Warning: could not stop ${SHELL_APP_NAME} -- continuing anyway`);
      return;
    }
    die(`Could not stop ${SHELL_APP_NAME}`);
  }
  ok(`${SHELL_APP_NAME} stopped`);
}

// Embed icons/app.ico into a Windows PE executable's resource section. The
// shipped ResoStage.exe is a renamed copy of Electron's electron.exe, which
// carries Electron's own icon; patching the PE resources swaps it for ours.
// Equivalent to what electron-builder does via rcedit, done here in-process
// with the pure-JS resedit package (keeps the hand-rolled assembly dependency-
// free at runtime).
function setWindowsExeIcon(exePath, icoPath) {
  const exe = NtExecutable.from(readFileSync(exePath));
  const res = NtExecutableResource.from(exe);
  const iconFile = Data.IconFile.from(readFileSync(icoPath));
  const RT_ICON = 3;
  const RT_GROUP_ICON = 14;
  // Drop every existing icon/group so our group id 1 is the only (and thus
  // lowest) one Windows will pick. replaceIconsForResource only swaps entries
  // that share the target group id, so leftover Electron icons would win.
  res.entries = res.entries.filter((e) => e.type !== RT_ICON && e.type !== RT_GROUP_ICON);
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1, // iconGroupID -- lowest id wins for display
    1033, // lang: en-US
    iconFile.icons.map((item) => item.data),
  );
  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
}

export function startApp() {
  const appBundle = getShellAppBundle();
  if (!existsSync(appBundle)) {
    die(
      `App not found: ${appBundle}\nBuild first:  pnpm build:app   (or  pnpm rebuild)`,
    );
  }
  if (appIsRunning()) {
    log(
      `${SHELL_APP_NAME} already running -- leaving it up (use pnpm kill first)`,
    );
    return;
  }
  log(`Launching ${appBundle}`);
  
  if (process.platform === "darwin") {
    const lsregister =
      "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
    if (existsSync(lsregister)) {
      run(lsregister, ["-f", appBundle], { allowFail: true });
    }
    run("open", [appBundle]);
  } else if (process.platform === "win32") {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -FilePath "${appBundle}"`,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
  } else {
    // Linux: launch detached so this script returns and the app
    // keeps running on its own.
    const child = spawn(appBundle, [], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
  }
  ok(`Launched ${SHELL_APP_NAME}`);
}

export function buildUi() {
  log("Building web UI...");
  run("pnpm", ["build"], { cwd: join(ROOT, "ui") });
  ok("Web UI built -> ui/dist");
}

// Copies ui/dist into the (raw, pre-assembly) JUCE bundle's Contents/
// Resources/web so the embedded WebServer can serve the SPA straight from
// disk -- no more giant EmbeddedAssets.h header with every asset baked in
// as C++ string literals.
function embedWebUi() {
  // Web UI embedding only applies to macOS .app bundles.
  // On Windows/Linux the Core is a bare executable and the web UI
  // is served by the Electron shell's dist/ folder.
  if (process.platform !== "darwin") {
    log("Skipping web UI embed (not macOS)");
    return;
  }
  const src = join(ROOT, "ui", "dist");
  if (!existsSync(src)) {
    log("ui/dist missing -- skipping web UI embed (run pnpm build:ui first)");
    return;
  }
  const dst = join(getRawCoreAppBundle(), "Contents", "Resources", "web");
  log(`Embedding web UI -> ${dst}`);
  cpSync(src, dst, { recursive: true });
  ok("Web UI embedded as folder (Resources/web)");
}

// Compiles electron/src/*.ts to electron/dist (ESM main.mjs + CJS preload.cjs).
function buildElectronShell() {
  if (!existsSync(join(ROOT, "electron", "package.json"))) {
    log("electron/ missing -- skipping Electron shell build");
    return;
  }
  log("Building Electron shell (electron/ -> dist/)...");
  run("pnpm", ["build"], { cwd: join(ROOT, "electron") });
  ok("Electron shell built (electron/dist)");
}

// Copies the shell's runtime `dependencies` next to its dist/, so the packaged
// app can require() them.
//
// Only koffi today, and it is not decoration: the native menu-item flash and
// the trackpad haptics both load their dylib through it. Shipping package.json
// + dist alone produced a bundle whose very first require("koffi") threw
// "Cannot find module" -- and both features catch that and downgrade to a
// warning, so the packaged app quietly had no haptics and no menu highlight
// while the dev run (which resolves up into the repo's node_modules) had both.
//
// pnpm links the package in from its store, so the copy has to dereference.
// koffi ships prebuilt binaries for eighteen platforms; only the macOS ones
// can ever load here, and dropping the rest keeps ~25 MB of Linux and Windows
// .node files out of the bundle.
function copyShellRuntimeDeps(appDst) {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "electron", "package.json"), "utf8"),
  );
  const deps = Object.keys(manifest.dependencies ?? {});
  if (!deps.length) return;

  for (const dep of deps) {
    const src = join(ROOT, "electron", "node_modules", dep);
    if (!existsSync(src)) {
      log(`WARNING: runtime dependency ${dep} not installed -- skipping`);
      continue;
    }
    cpSync(src, join(appDst, "node_modules", dep), {
      recursive: true,
      dereference: true,
    });

    const prebuilds = join(appDst, "node_modules", dep, "build", dep);
    if (!existsSync(prebuilds)) continue;
    for (const p of readdirSync(prebuilds)) {
      if (p.startsWith("darwin_")) continue;
      rmSync(join(prebuilds, p), { recursive: true, force: true });
    }
  }
  log(`Bundled shell runtime deps: ${deps.join(", ")}`);
}

// Assembles the final distributable bundle at build/<platform>/<arch>/
// ResoStage.app: a branded Electron shell (Dock name + icon, see
// electron/scripts/brand-mac-app.mjs) as the OUTER bundle -- what the user
// actually double-clicks -- containing this project's electron/package.json
// + dist/ at Contents/Resources/app (Electron auto-loads this with zero CLI
// args, unlike the JUCE-spawned dev/browser flow which passes an explicit
// app dir) and the built JUCE Core.app nested at Contents/Resources/ as the
// backend Electron spawns on a standalone launch (see main.mts spawnBackend
// / MainComponent's RESOSTAGE_SPAWNED_BY_SHELL check). One code-signing pass
// at the very end, since any change after signing invalidates it anyway.
function assembleShellBundle() {
  const rawCore = getRawCoreAppBundle();
  if (!existsSync(rawCore)) {
    log(
      `${rawCore} missing -- skipping shell bundle assembly (build the app first)`,
    );
    return;
  }

  if (process.platform === "darwin") {
    const shellBundle = getShellAppBundle();
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

    const coreDst = getNestedCoreAppBundle(shellBundle);
    run("rm", ["-rf", coreDst]);
    // Quote paths for shell (they may contain spaces, e.g. "ResoStage Core.app")
    run("cp", ["-R", `"${rawCore}"`, `"${coreDst}"`]);

    run("codesign", ["--force", "--deep", "--sign", "-", shellBundle]);
    ok(`Assembled ${shellBundle}`);
    return;
  }

  if (process.platform === "win32") {
    // Windows layout (build/win/<arch>/):
    //   ResoStage.exe        renamed Electron runtime
    //   resources/           Electron's own dir, incl. resources/app/ (the app)
    //   resources/app/       electron/package.json + compiled dist/ + deps
    //   ResoStage Core.exe   nested JUCE backend (at bundle root, next to exe)
    const shellBundle = getShellAppBundle(); // e.g., build/win/x64/ResoStage.exe
    const shellDir = path.dirname(shellBundle);
    log(`Assembling ${shellBundle}...`);
    mkdirSync(shellDir, { recursive: true });

    // Copy the ENTIRE Electron runtime. A hand-picked list here keeps silently
    // dropping files the renderer needs (d3dcompiler_47.dll, chrome_100/200
    // _percent.pak, vk_swiftshader_icd.json) -- a bundle that "builds" but
    // shows a black screen. Copying dist/ wholesale is both correct and
    // future-proof.
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

    // The renderer cannot start without these; if any is missing (e.g. held
    // open by a lingering process during the copy) fail loudly instead of
    // shipping a black screen.
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
      die(
        `Electron runtime incomplete: missing ${missingRuntime.join(", ")} in ${shellDir}`,
      );
    }

    // electron.exe is the runtime. Rename it to the product name so the
    // shipped executable is ResoStage.exe. Electron resolves its helper
    // processes and resources relative to its own executable path, so the
    // name swap is safe (mirrors brand-mac-app.mjs on macOS).
    const electronExeSrc = join(shellDir, "electron.exe");
    if (!existsSync(electronExeSrc)) {
      die(`Electron executable not found at ${electronExeSrc}`);
    }
    if (existsSync(shellBundle)) rmSync(shellBundle, { force: true });
    cpSync(electronExeSrc, shellBundle);

    // electron.exe ships with Electron's own icon embedded. Patch the copied
    // exe's PE resources so ResoStage.exe shows our icon in Explorer / the
    // taskbar (the Inno shortcuts already point at ResoStage.ico, but the exe
    // itself would otherwise keep the Electron logo). Mirrors what electron-
    // builder does via rcedit, done here with the pure-JS resedit package.
    const appIco = join(ROOT, "icons", "app.ico");
    if (existsSync(appIco)) {
      setWindowsExeIcon(shellBundle, appIco);
    } else {
      log(`Warning: icons/app.ico missing -- exe keeps Electron's default icon`);
    }

    // The app proper (package.json + compiled dist/ + runtime deps) must live
    // at resources/app/ -- that is the one place Electron looks for the
    // packaged app when launched with no arguments. Next to the exe (the old
    // layout) meant ResoStage.exe booted Electron's stock default_app.asar
    // instead of this app.
    const appDst = join(shellDir, "resources", "app");
    rmSync(appDst, { recursive: true, force: true });
    mkdirSync(appDst, { recursive: true });
    cpSync(join(ROOT, "electron", "package.json"), join(appDst, "package.json"));
    cpSync(join(ROOT, "electron", "dist"), join(appDst, "dist"), {
      recursive: true,
    });
    copyShellRuntimeDeps(appDst);

    // The SPA the Electron shell loads (EMBED_URL = http://localhost:<port>/)
    // is served by the nested Core's WebServer, not by the shell itself. The
    // Core looks for it at <exe dir>/resources/web (Windows) / Contents/
    // Resources/web (macOS), so copy the built UI there. Without this the
    // Core has no web root in the packaged bundle and serves "not found" --
    // a black window, even though a Core launched from the repo (where
    // ./ui/dist exists) serves it fine.
    const webSrc = join(ROOT, "ui", "dist");
    if (existsSync(webSrc)) {
      const webDst = join(shellDir, "resources", "web");
      rmSync(webDst, { recursive: true, force: true });
      cpSync(webSrc, webDst, { recursive: true });
    } else {
      log("WARNING: ui/dist missing -- the app will show a blank window (run pnpm rebuild)");
    }

    // Nested JUCE Core executable, at the bundle root next to ResoStage.exe
    // (findNestedCoreBinary() resolves it via process.resourcesPath).
    const coreDst = join(shellDir, `${CORE_APP_NAME}.exe`);
    if (existsSync(coreDst)) rmSync(coreDst, { force: true });
    const coreBuildDir = path.dirname(rawCore);
    const coreExe = join(coreBuildDir, `${CORE_APP_NAME}.exe`);
    if (existsSync(coreExe)) {
      cpSync(coreExe, coreDst);
    } else {
      log(`Warning: Core exe not found at ${coreExe}`);
    }

    ok(`Assembled ${shellBundle}`);
    return;
  }

  log(`Unsupported platform: ${process.platform}`);
}

export function buildApp() {
  // On Windows, a running instance locks the runtime files (icudtl.dat, etc.)
  // so they can't be overwritten during assembly. Kill it first.
  if (process.platform === "win32" && appIsRunning()) {
    log("Stopping running ResoStage (locks runtime files)...");
    killApp({ bestEffort: true });
    // Wait for any lingering ResoStage.exe / helper processes so the
    // assembly below never races against their open file handles (that race
    // used to silently drop chrome_*_percent.pak / d3dcompiler_47.dll and
    // yield a black screen).
    for (let i = 0; i < 20 && appIsRunning(); i++) sleepMs(250);
  }
  log(`Building ${CORE_APP_NAME} (${BUILD_TYPE})...`);
  cmakeBuild(APP_TARGET);
  ok(`Core: ${getRawCoreAppBundle()}`);
  embedWebUi();
  buildElectronShell();
  assembleShellBundle();
}

export function buildTests() {
  log("Building resostage_engine_tests...");
  cmakeBuild("resostage_engine_tests");
}

export function runTests() {
  buildTests();
  if (!existsSync(TEST_BINARY)) die(`Test binary missing: ${TEST_BINARY}`);
  log(`Running ${TEST_BINARY}`);
  run(TEST_BINARY, []);

  log("Running ui tests (vitest)...");
  if (run("pnpm", ["test"], { cwd: join(ROOT, "ui") }) !== 0) {
    die("ui tests failed");
  }
}

export function lintAll() {
  let failed = false;
  log("Lint ui (oxlint)...");
  if (run("pnpm", ["lint"], { cwd: join(ROOT, "ui"), allowFail: true }) !== 0) {
    failed = true;
  }
  log("Typecheck ui (tsc)...");
  if (
    run("pnpm", ["exec", "tsc", "-b", "--pretty", "false"], {
      cwd: join(ROOT, "ui"),
      allowFail: true,
    }) !== 0
  ) {
    failed = true;
  }
  if (failed) die("Lint / typecheck failed");
  ok("Lint + typecheck clean");
}

export function configure() {
  log(`Configuring ${BUILD_DIR} (CMAKE_BUILD_TYPE=${BUILD_TYPE})...`);
  run("cmake", [
    "-S",
    CORE_DIR,
    "-B",
    BUILD_DIR,
    `-DCMAKE_BUILD_TYPE=${BUILD_TYPE}`,
  ]);
  ok(`Configured ${BUILD_DIR}`);
}

export function clean({ ui = false } = {}) {
  killApp({ bestEffort: true });
  for (const dir of [BUILD_DIR, DIST_DIR]) {
    if (existsSync(dir)) {
      log(`Removing ${dir}...`);
      rmSync(dir, { recursive: true, force: true });
      ok(`Removed ${dir}`);
    } else {
      log(`No dir at ${dir}`);
    }
  }
  if (ui) {
    const dist = join(ROOT, "ui", "dist");
    if (existsSync(dist)) {
      log("Removing ui/dist...");
      rmSync(dist, { recursive: true, force: true });
      ok("Removed ui/dist");
    }
  }
}
