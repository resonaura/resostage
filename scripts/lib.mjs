/**
 * Shared helpers for root pnpm / Node scripts (ESM).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, "..");
export const BUILD_DIR = process.env.BUILD_DIR || join(ROOT, "build");
export const BUILD_TYPE = process.env.BUILD_TYPE || "Debug";
export const APP_NAME = "ResoStage";
export function getAppBundle() {
  if (process.env.APP_BUNDLE) return process.env.APP_BUNDLE;
  const directPath = join(BUILD_DIR, "app", `${APP_NAME}_artefacts`, `${APP_NAME}.app`);
  if (existsSync(directPath)) return directPath;
  const buildTypePath = join(BUILD_DIR, "app", `${APP_NAME}_artefacts`, BUILD_TYPE, `${APP_NAME}.app`);
  if (existsSync(buildTypePath)) return buildTypePath;
  return directPath;
}
export const APP_BUNDLE = getAppBundle();
export const APP_BINARY = join(APP_BUNDLE, "Contents", "MacOS", APP_NAME);
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
    shell: false,
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

export function ensureCmakeConfigured() {
  if (existsSync(join(BUILD_DIR, "CMakeCache.txt"))) return;
  log(`CMake not configured at ${BUILD_DIR} -- configuring (${BUILD_TYPE})...`);
  run("cmake", [
    "-S",
    ROOT,
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

export function appIsRunning() {
  const byName = runQuiet("pgrep", ["-x", APP_NAME]);
  if (byName.status === 0) return true;
  const byPath = runQuiet("pgrep", [
    "-f",
    `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`,
  ]);
  return byPath.status === 0;
}

export function killApp() {
  if (!appIsRunning()) {
    log(`${APP_NAME} is not running`);
    return;
  }
  log(`Stopping ${APP_NAME}...`);
  // Prefer AppleEvent quit so save dialogs can finish, then escalate.
  runQuiet("osascript", ["-e", `tell application "${APP_NAME}" to quit`]);
  for (let i = 0; i < 8; i++) {
    if (!appIsRunning()) {
      ok(`${APP_NAME} stopped`);
      return;
    }
    sleepMs(250);
  }
  runQuiet("killall", [APP_NAME]);
  sleepMs(300);
  if (appIsRunning()) {
    log(`Force-killing ${APP_NAME}...`);
    runQuiet("killall", ["-9", APP_NAME]);
    runQuiet("pkill", [
      "-9",
      "-f",
      `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`,
    ]);
  }
  if (appIsRunning()) die(`Could not stop ${APP_NAME}`);
  ok(`${APP_NAME} stopped`);
}

export function startApp() {
  if (!existsSync(APP_BUNDLE)) {
    die(
      `App not found: ${APP_BUNDLE}\nBuild first:  pnpm build:app   (or  pnpm rebuild)`,
    );
  }
  if (appIsRunning()) {
    log(`${APP_NAME} already running -- leaving it up (use pnpm kill first)`);
    return;
  }
  log(`Launching ${APP_BUNDLE}`);
  // macOS: `open` detaches cleanly; elsewhere spawn the binary detached.
  if (process.platform === "darwin") {
    const lsregister =
      "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
    if (existsSync(lsregister)) {
      run(lsregister, ["-f", APP_BUNDLE], { allowFail: true });
    }
    run("open", [APP_BUNDLE]);
  } else {
    const child = spawn(APP_BINARY, [], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => die(err.message));
    child.unref();
  }
  ok(`Launched ${APP_NAME}`);
}

export function buildUi() {
  log("Building web UI + embedding assets...");
  run("pnpm", ["build:embed"], { cwd: join(ROOT, "ui") });
  ok("Web UI embedded -> app/web/EmbeddedAssets.h");
}

export function buildApp() {
  log(`Building ${APP_NAME} (${BUILD_TYPE})...`);
  cmakeBuild(APP_NAME);
  ok(`App: ${APP_BUNDLE}`);
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
    ROOT,
    "-B",
    BUILD_DIR,
    `-DCMAKE_BUILD_TYPE=${BUILD_TYPE}`,
  ]);
  ok(`Configured ${BUILD_DIR}`);
}

export function clean({ ui = false } = {}) {
  killApp();
  if (existsSync(BUILD_DIR)) {
    log(`Removing ${BUILD_DIR}...`);
    run("rm", ["-rf", BUILD_DIR]);
    ok(`Removed ${BUILD_DIR}`);
  } else {
    log(`No build dir at ${BUILD_DIR}`);
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
