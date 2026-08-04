#!/usr/bin/env node
/**
 * ResoLight firmware CLI (TypeScript ESM).
 *
 *   pnpm --dir resolight/firmware build
 *   pnpm --dir resolight/firmware flash
 *   pnpm --dir resolight/firmware monitor
 *   pnpm --dir resolight/firmware list-strips
 *
 * Flow: load config.yaml → generate BoardConfig.h → PlatformIO.
 * Not embedded in the desktop app — flash stays an explicit operator step.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { LED_TYPES, loadConfig } from "./lib/config.ts";
import { generateBoardConfigHeader } from "./lib/generate.ts";
import { runPio } from "./lib/pio.ts";

const firmwareRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function usage(): never {
  console.log(`ResoLight firmware CLI

Usage:
  pnpm --dir resolight/firmware <command>

Commands:
  build          Compile (auto-generates BoardConfig.h from config.yaml first)
  flash          Compile + upload (same auto-gen)
  monitor        Serial monitor
  flash:monitor  flash then monitor
  clean          PlatformIO clean
  list-strips    Print supported LED strip types

Config:
  resolight/firmware/config.yaml   (gitignored — copy from config.example.yaml)
  BoardConfig.h is generated automatically on every build/flash — no separate step.
`);
  process.exit(1);
}

/** Always run before compile/upload: config.yaml → src/generated/BoardConfig.h */
function prepare(): { board: string } {
  const cfg = loadConfig(firmwareRoot);
  const out = generateBoardConfigHeader(firmwareRoot, cfg);
  console.log(
    `config: board=${cfg.board} leds=${cfg.leds.type}/${cfg.leds.order} ` +
      `pin=${cfg.leds.pin} count=${cfg.leds.count}` +
      (cfg.wifi.ssid ? ` wifi="${cfg.wifi.ssid}"` : " wifi=(SoftAP fallback)"),
  );
  console.log(`generated ${path.relative(firmwareRoot, out)}`);
  return { board: cfg.board };
}

function main(): void {
  const cmd = process.argv[2] ?? "build";
  const extra = process.argv.slice(3);

  if (cmd === "help" || cmd === "-h" || cmd === "--help") usage();

  if (cmd === "list-strips") {
    console.log("Supported leds.type values:\n");
    for (const [id, meta] of Object.entries(LED_TYPES)) {
      console.log(
        `  ${id.padEnd(14)} ${meta.label}${meta.needsClock ? "  (needs clockPin)" : ""}`,
      );
    }
    console.log("\nleds.order: rgb | rbg | grb | gbr | brg | bgr");
    process.exit(0);
  }

  if (cmd === "monitor") {
    process.exit(runPio(firmwareRoot, ["device", "monitor", ...extra]));
  }

  if (cmd === "clean") {
    // Prefer board from config if present; fall back to default env.
    let board = "esp32";
    try {
      board = loadConfig(firmwareRoot).board;
    } catch {
      /* no config yet — clean default env only */
    }
    process.exit(
      runPio(firmwareRoot, ["run", "-e", board, "-t", "clean", ...extra]),
    );
  }

  if (cmd === "build" || cmd === "flash" || cmd === "flash:monitor") {
    // Gen is not a separate step — always regenerate right before pio.
    const { board } = prepare();
    const args = ["run", "-e", board];
    if (cmd === "flash" || cmd === "flash:monitor") args.push("-t", "upload");
    if (cmd === "flash:monitor") args.push("-t", "monitor");
    args.push(...extra);
    process.exit(runPio(firmwareRoot, args));
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
}

main();
