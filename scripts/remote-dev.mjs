#!/usr/bin/env node
/**
 * Remote development helper: run Core on Windows, Electron UI on Mac.
 *
 * Usage:
 *   node scripts/remote-dev.mjs <windows-ip> [core-port]
 *
 *   node scripts/remote-dev.mjs 192.168.1.50 2899
 *
 * What it does:
 * 1. Builds Core on Windows via SSH (blaptop)
 * 2. Starts Core on Windows with --backend-port=<port> (headless, no Electron spawn)
 * 3. Starts Electron on Mac with --backend-host=<windows-ip> --backend-port=<port>
 *    (Electron connects to remote Core via HTTP/WebSocket instead of spawning local Core)
 *
 * Prerequisites:
 * - SSH access to Windows box (configured in blaptop.mjs)
 * - Windows has Visual Studio + CMake env (env.bat)
 * - Mac has Electron deps installed (pnpm install)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__dirname), "..");
const BLAPTOP = join(ROOT, "scripts", "blaptop.mjs");

function log(msg) {
  console.log(`→ ${msg}`);
}

function die(msg) {
  console.error(`��� ${msg}`);
  process.exit(1);
}

function run(cmd, args = [], opts = {}) {
  const { cwd = ROOT, env = process.env, allowFail = false } = opts;
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: false });
  if (r.error && !allowFail) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) process.exit(r.status ?? 1);
  return r.status ?? 0;
}

const [windowsIp, portArg] = process.argv.slice(2);
if (!windowsIp) {
  console.log(`
Remote dev helper: Core on Windows, Electron on Mac

Usage: node scripts/remote-dev.mjs <windows-ip> [core-port]

Example: node scripts/remote-dev.mjs 192.168.1.50 2899

Environment:
  CORE_PORT     Core HTTP port (default: 2899)
  JOBS        Parallel build jobs (default: CPU count)
`);
  process.exit(1);
}

const CORE_PORT = Number(portArg || process.env.CORE_PORT || 2899);

log(`Remote dev: Core@${windowsIp}:${CORE_PORT}, Electron@localhost`);

// 1. Build Core on Windows
log("Building Core on Windows...");
run("node", [BLAPTOP, `cmd /c "call C:\\\\Users\\\\tkach\\\\resostage\\\\env.bat && cd /d C:\\\\Users\\\\tkach\\\\resostage\\\\core\\\\build && cmake --build . --target ResoStage -j 8"`]);

// 2. Start Core on Windows in background (headless, with --backend-port)
log(`Starting Core on Windows (port ${CORE_PORT})...`);
const coreCmd = `cmd /c "call C:\\\\Users\\\\tkach\\\\resostage\\\\env.bat && cd /d C:\\\\Users\\\\tkach\\\\resostage\\\\core\\\\build\\\\app\\\\ResoStage_artefacts\\\\RelWithDebInfo && start /b ResoStage\\ Core.exe --backend-port=${CORE_PORT}"`;
run("node", [BLAPTOP, coreCmd], { allowFail: true });

// Give Core a moment to start
log("Waiting for Core to start...");
spawnSync("sleep", ["3"], { stdio: "ignore" });

// 3. Start Electron on Mac in remote mode
log("Starting Electron on Mac (remote mode)...");
const electronCmd = `pnpm --filter resostage-electron start -- --remote=${windowsIp} --backend-port=${CORE_PORT}`;
run("bash", ["-c", electronCmd], { cwd: join(ROOT, "electron") });

log("Remote dev session ended.");