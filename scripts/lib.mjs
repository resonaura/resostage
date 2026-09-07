/**
 * Shared helpers for root pnpm / Node scripts (ESM).
 */
import { execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NtExecutable, NtExecutableResource, Data, Resource } from "resedit";

import { createBuildAdapter } from "./platform/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, "..");

let _buildAdapter = null;
export function getBuildAdapter() {
  if (!_buildAdapter) {
    _buildAdapter = createBuildAdapter();
  }
  return _buildAdapter;
}
export const buildAdapter = new Proxy({}, {
  get(_, prop) {
    const adapter = getBuildAdapter();
    const val = adapter[prop];
    return typeof val === "function" ? val.bind(adapter) : val;
  },
});
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
export const CORE_APP_NAME =
  process.platform === "darwin" ? "ResoStage Core" : "core";
export const SHELL_APP_NAME =
  process.platform === "darwin" ? "ResoStage" : "resostage";

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
  return buildAdapter.getShellAppBundle();
}
export function getNestedCoreAppBundle(shellBundle = getShellAppBundle()) {
  return join(shellBundle, "Contents", "Resources", `${CORE_APP_NAME}.app`);
}
// Raw JUCE build output straight out of CMake (core/build/), before it gets
// copied into the assembled shell bundle above.
// Deep-first search for a named file under a dir (used to find the Core exe
// regardless of which CMake generator / config produced it).
export function findFileRecursively(dir, name) {
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.name === name) {
      if (!e.isDirectory() || name.endsWith(".app") || name.endsWith(".framework")) {
        return full;
      }
    }
    if (e.isDirectory()) {
      const hit = findFileRecursively(full, name);
      if (hit) return hit;
    }
  }
  return null;
}

export function getRawCoreAppBundle() {
  return buildAdapter.getRawCoreAppBundle();
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
  const isWin = process.platform === "win32";
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: isWin,
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
  const isWin = process.platform === "win32";
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
    encoding: "utf8",
    shell: isWin,
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

export function shellExecutablePath() {
  return buildAdapter.shellExecutablePath();
}

export function appIsRunning() {
  return buildAdapter.appIsRunning();
}

export function killApp(opts) {
  return buildAdapter.killApp(opts);
}

// Embed icons/app.ico into a Windows PE executable's resource section. The
// shipped ResoStage.exe is a renamed copy of Electron's electron.exe, which
// carries Electron's own icon; patching the PE resources swaps it for ours.
// Equivalent to what electron-builder does via rcedit, done here in-process
// with the pure-JS resedit package (keeps the hand-rolled assembly dependency-
// free at runtime).
function patchWindowsExeMetadata(exePath, icoPath, exeName = "resostage.exe") {
  const exe = NtExecutable.from(readFileSync(exePath));
  const res = NtExecutableResource.from(exe);

  if (icoPath && existsSync(icoPath)) {
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
  }

  const desc =
    exeName === "core.exe"
      ? "ResoStage Core"
      : exeName === "kaishaku.exe"
        ? "ResoStage Kaishaku"
        : "ResoStage";

  // Patch PE VersionInfo metadata so Windows Task Manager displays "ResoStage"
  // instead of Electron's default "Electron" process metadata.
  const versionInfos = Resource.VersionInfo.fromEntries(res.entries);
  if (versionInfos && versionInfos.length > 0) {
    for (const info of versionInfos) {
      info.setStringValues(
        { lang: 1033, codepage: 1200 },
        {
          FileDescription: desc,
          ProductName: "ResoStage",
          CompanyName: "ResoStage",
          InternalName: exeName,
          OriginalFilename: exeName,
          LegalCopyright: "Copyright © ResoStage",
        },
      );
      info.outputToResourceEntries(res.entries);
    }
  }

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
    const child = spawn("open", [appBundle], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", appBundle], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
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
export function embedWebUi() {
  return buildAdapter.embedWebUi();
}

export function assembleShellBundle() {
  return buildAdapter.assembleShellBundle();
}

export function buildElectronShell() {
  if (!existsSync(join(ROOT, "electron", "package.json"))) {
    log("electron/ missing -- skipping Electron shell build");
    return;
  }
  log("Building Electron shell (electron/ -> dist/)...");
  run("pnpm", ["build"], { cwd: join(ROOT, "electron") });
  ok("Electron shell built (electron/dist)");
}

export function copyShellRuntimeDeps(appDst) {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "electron", "package.json"), "utf8"),
  );
  const deps = Object.keys(manifest.dependencies ?? {});
  if (!deps.length) return;

  const platformPrefix =
    process.platform === "win32"
      ? "win32_"
      : process.platform === "darwin"
        ? "darwin_"
        : "linux_";

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
      if (p.startsWith(platformPrefix)) continue;
      rmSync(join(prebuilds, p), { recursive: true, force: true });
    }
  }
  log(`Bundled shell runtime deps: ${deps.join(", ")}`);
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
  cmakeBuild("kaishaku");
  ok(`Core: ${getRawCoreAppBundle()}`);
  embedWebUi();
  buildElectronShell();
  assembleShellBundle();
}

export function buildTests() {
  log("Building resostage_engine_tests...");
  cmakeBuild("resostage_engine_tests");
}

export function getTestBinaryExecutable() {
  if (process.env.TEST_BINARY && existsSync(process.env.TEST_BINARY)) {
    return process.env.TEST_BINARY;
  }
  const testName = process.platform === "win32" ? "resostage_engine_tests.exe" : "resostage_engine_tests";
  const found = findFileRecursively(join(BUILD_DIR, "tests"), testName);
  if (found) return found;
  return join(BUILD_DIR, "tests", testName);
}

export function runTests() {
  buildTests();
  const testBin = getTestBinaryExecutable();
  if (!existsSync(testBin)) die(`Test binary missing: ${testBin}`);
  log(`Running ${testBin}`);
  run(testBin, []);

  log("Running ui tests (vitest)...");
  if (run("pnpm", ["test"], { cwd: join(ROOT, "ui") }) !== 0) {
    die("ui tests failed");
  }

  log("Running electron shell tests (vitest)...");
  if (run("pnpm", ["test"], { cwd: join(ROOT, "electron") }) !== 0) {
    die("electron tests failed");
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
