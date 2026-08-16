import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const exe = join(root, "build", "win", "x64", "core.exe");

try {
  execSync('taskkill /F /IM core.exe >NUL 2>&1');
} catch {}

console.log("Starting Core engine on Windows...");
const proc = spawn(exe, ["--backend-port=2988", "--no-discovery"], {
  detached: true,
  stdio: "ignore",
});
proc.unref();

setTimeout(async () => {
  try {
    const res = await fetch("http://127.0.0.1:2988/api/v1/state");
    const json = await res.json();
    const settings = json.settings;

    console.log("\n==========================================");
    console.log("  JUCE AUDIO DRIVERS ON WINDOWS:");
    console.log("==========================================");
    console.log("Available Drivers:", settings.audioDrivers);
    console.log("Current Driver:", settings.currentAudioDriver);
    console.log("Has Control Panel:", settings.hasControlPanel);
    console.log("==========================================\n");

    // Test switching to ASIO driver if available
    if (settings.audioDrivers.includes("ASIO")) {
      console.log("Testing switch to ASIO driver...");
      const switchRes = await fetch("http://127.0.0.1:2988/api/v1/settings/audio-driver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "ASIO" }),
      });
      console.log("ASIO Switch Status:", switchRes.status);
    }
  } catch (err) {
    console.error("Test failed:", err.message);
  } finally {
    try {
      execSync('taskkill /F /IM core.exe >NUL 2>&1');
    } catch {}
    process.exit(0);
  }
}, 2500);
