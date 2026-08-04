import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function findPio(): string {
  const candidates = [
    process.env.PIO,
    "pio",
    "platformio",
    path.join(homedir(), ".platformio", "penv", "bin", "pio"),
    "/opt/homebrew/bin/pio",
    "/usr/local/bin/pio",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (c === "pio" || c === "platformio") {
      const r = spawnSync(c, ["--version"], { encoding: "utf8" });
      if (r.status === 0) return c;
      continue;
    }
    if (existsSync(c)) return c;
  }

  throw new Error(
    "PlatformIO CLI not found.\n" +
      "  brew install platformio   # macOS\n" +
      "  pipx install platformio",
  );
}

export function runPio(firmwareRoot: string, args: string[]): number {
  const pio = findPio();
  const result = spawnSync(pio, args, {
    cwd: firmwareRoot,
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}
