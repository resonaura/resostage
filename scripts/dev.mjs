#!/usr/bin/env node
/**
 * ResoStage root dev CLI (ESM).
 *
 *   node scripts/dev.mjs <command>
 *   pnpm kill | start | rebuild | ...
 */
import {
  buildApp,
  buildUi,
  clean,
  configure,
  die,
  killApp,
  lintAll,
  log,
  ok,
  runTests,
  startApp,
} from "./lib.mjs";
import { publish } from "./publish.mjs";

const COMMANDS = {
  kill: {
    desc: "Stop a running ResoStage instance",
    run: () => killApp(),
  },
  start: {
    desc: "Launch the last-built ResoStage.app",
    run: () => startApp(),
  },
  restart: {
    desc: "Kill then start",
    run: () => {
      killApp();
      startApp();
    },
  },
  ui: {
    desc: "Build web UI (ui/dist)",
    run: () => buildUi(),
  },
  rebuild: {
    desc: "Full rebuild: web UI + ResoStage Core + electron shell",
    run: () => {
      buildUi();
      buildApp();
      ok("Full rebuild done");
    },
  },
  "rebuild:run": {
    desc: "Full rebuild, kill running app, launch new build",
    run: () => {
      buildUi();
      buildApp();
      killApp();
      startApp();
    },
  },
  app: {
    desc: "Incremental CMake build of ResoStage Core only",
    run: () => buildApp(),
  },
  "app:run": {
    desc: "App-only rebuild, kill running, launch",
    run: () => {
      buildApp();
      killApp();
      startApp();
    },
  },
  publish: {
    desc: "Build installers for this platform into build/publish",
    run: () => publish(),
  },
  "publish:rebuild": {
    desc: "Full rebuild, then build installers",
    run: () => {
      buildUi();
      buildApp();
      publish();
    },
  },
  test: {
    desc: "Build + run engine unit tests",
    run: () => runTests(),
  },
  lint: {
    desc: "oxlint + tsc for ui",
    run: () => lintAll(),
  },
  configure: {
    desc: "cmake -S . -B build (BUILD_TYPE / BUILD_DIR env)",
    run: () => configure(),
  },
  clean: {
    desc: "Remove build/ (pass --ui to also wipe ui/dist)",
    run: (args) => clean({ ui: args.includes("--ui") || args.includes("ui") }),
  },
  help: {
    desc: "List commands",
    run: () => printHelp(),
  },
};

function printHelp() {
  console.log("ResoStage dev scripts\n");
  console.log("Usage:  pnpm <script>   or   node scripts/dev.mjs <command>\n");
  const names = Object.keys(COMMANDS).filter((k) => k !== "help");
  const width = Math.max(...names.map((n) => n.length));
  for (const name of names) {
    console.log(`  ${name.padEnd(width + 2)} ${COMMANDS[name].desc}`);
  }
  console.log(`
Env:
  BUILD_DIR    cmake build dir (default: ./build)
  BUILD_TYPE   Debug | Release (default: Debug)
  JOBS         parallel build jobs (default: CPU count)

pnpm aliases: see root package.json ("pnpm run scripts")
`);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === "-h" || cmd === "--help") {
  printHelp();
  process.exit(0);
}

const entry = COMMANDS[cmd];
if (!entry) {
  die(`Unknown command: ${cmd}\nRun: node scripts/dev.mjs help`);
}

log(`dev.mjs ${cmd}`);
entry.run(args);
