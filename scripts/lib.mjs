/**
 * Shared helpers for root pnpm / Node scripts (ESM).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
export function getRawCoreAppBundle() {
  if (process.platform === "win32") {
    const buildTypePath = join(
      BUILD_DIR,
      "app",
      `${APP_TARGET}_artefacts`,
      BUILD_TYPE,
      `${CORE_APP_NAME}.exe`,
    );
    if (existsSync(buildTypePath)) return buildTypePath;
    const directPath = join(
      BUILD_DIR,
      "app",
      `${APP_TARGET}_artefacts`,
      `${CORE_APP_NAME}.exe`,
    );
    return directPath;
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
    return result.status === 0 && result.stdout.includes(exe);
  } else {
    // Linux: check for process by name
    const exe = path.basename(shellExecutablePath());
    return runQuiet("pgrep", ["-f", exe]).status === 0;
  }
}

export function killApp() {
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
    sleepMs(500);
  } else {
    // Linux
    const exe = path.basename(shellExecutablePath());
    runQuiet("pkill", ["-f", exe]);
    sleepMs(300);
  }
  
  if (appIsRunning()) die(`Could not stop ${SHELL_APP_NAME}`);
  ok(`${SHELL_APP_NAME} stopped`);
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
    // On Windows, just execute the .exe directly
    run(appBundle, [], { detached: true, stdio: "ignore" });
  } else {
    // Linux
    run(appBundle, [], { detached: true, stdio: "ignore" });
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
    // Windows: create a simple folder structure with .exe + dist + Core
    const shellBundle = getShellAppBundle(); // e.g., build/win/x64/ResoStage.exe
    const shellDir = path.dirname(shellBundle);
    log(`Assembling ${shellBundle}...`);
    
    // Ensure directory exists
    mkdirSync(shellDir, { recursive: true });
    
    // Copy Electron shell dist to same folder as .exe
    const distSrc = join(ROOT, "electron", "dist");
    const distDst = join(shellDir, "dist");
    if (existsSync(distDst)) rmSync(distDst, { recursive: true, force: true });
    cpSync(distSrc, distDst, { recursive: true });
    
    // Copy Electron executable and rename to ResoStage.exe
    const electronExeSrc = join(ROOT, "electron", "node_modules", "electron", "dist", "electron.exe");
    if (existsSync(electronExeSrc)) {
      cpSync(electronExeSrc, shellBundle);
    } else {
      die(`Electron executable not found at ${electronExeSrc}`);
    }
    
    // Copy package.json
    cpSync(join(ROOT, "electron", "package.json"), join(shellDir, "package.json"));
    
    // Copy Core executable (rename to ResoStage Core.exe)
    const coreDst = join(shellDir, `${CORE_APP_NAME}.exe`);
    if (existsSync(coreDst)) rmSync(coreDst, { force: true });
    // Core build outputs "ResoStage Core.exe" - find it
    const coreBuildDir = path.dirname(rawCore);
    const coreExe = join(coreBuildDir, `${CORE_APP_NAME}.exe`);
    if (existsSync(coreExe)) {
      cpSync(coreExe, coreDst);
    } else {
      log(`Warning: Core exe not found at ${coreExe}`);
    }
    
    // Create a simple launcher batch file that sets up paths
    const launcher = join(shellDir, "ResoStage.cmd");
    writeFileSync(launcher, `@echo off
cd /d "%~dp0"
start "" "%~dp0ResoStage.exe" %*
`);
    
    ok(`Assembled ${shellBundle}`);
    return;
  }

  log(`Unsupported platform: ${process.platform}`);
}

export function buildApp() {
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
  killApp();
  for (const dir of [BUILD_DIR, DIST_DIR]) {
    if (existsSync(dir)) {
      log(`Removing ${dir}...`);
      run("rm", ["-rf", dir]);
      ok(`Removed ${dir}`);
    } else {
      log(`No dir at ${dir}`);
    }
  }
  if (ui) {
    const dist = join(ROOT, "ui", "dist");
    if (existsSync(dist)) {
      log("Removing ui/dist...");
      run("rm", ["-rf", dist]);
      ok("Removed ui/dist");
    }
  }
}
