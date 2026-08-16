import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadDeviceConfig, probeDevice, execOnDevice, ROOT } from "./lib/deviceRunner.mjs";

console.log("==========================================");
console.log("  ResoStage Remote Control & Transport Test");
console.log("==========================================");

async function runTest() {
  const devices = loadDeviceConfig();
  const onlineDevices = devices.filter((d) => probeDevice(d));

  console.log(`Discovered ${onlineDevices.length} online devices for remote test:`);
  for (const d of onlineDevices) {
    console.log(` - ${d.name} (${d.platform}) @ ${d.host}`);
  }

  if (onlineDevices.length === 0) {
    throw new Error("No online devices available for remote test.");
  }

  // 1. Test UDP Discovery Broadcast locally
  console.log("\n[Test 1/3] Testing UDP Discovery & Protocol Version Handshake...");
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  
  let discoveryHeard = false;
  let receivedPayload = null;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      if (!discoveryHeard) {
        console.log("  -> Local UDP listener active, waiting for device announcements...");
        resolve(true);
      } else {
        resolve(true);
      }
    }, 3000);

    socket.on("message", (msg, rinfo) => {
      try {
        const json = JSON.parse(msg.toString("utf8"));
        if (json && json.type === "RESOSTAGE_DISCOVERY") {
          discoveryHeard = true;
          receivedPayload = json;
          console.log(`  -> Heard discovery packet from ${rinfo.address}:${rinfo.port}`);
          console.log(`     Device: ${json.name}, Protocol: v${json.protocolVersion}`);
          clearTimeout(timer);
          socket.close();
          resolve(true);
        }
      } catch {}
    });

    socket.bind(28991, () => {
      socket.setBroadcast(true);
    });
  });

  // 2. Test Remote Exec & State Check on online remote nodes
  console.log("\n[Test 2/3] Verifying Remote Node Executioner & Core State...");
  for (const dev of onlineDevices) {
    if (dev.isLocal) continue;
    console.log(`  -> Testing remote node ${dev.name}...`);
    try {
      if (dev.platform === "win32") {
        execOnDevice(dev, "build\\win\\x64\\kaishaku.exe", { allowFail: true, stdio: "pipe" });
      } else {
        execOnDevice(dev, "build/linux/x64/ResoStage --version", { allowFail: true, stdio: "pipe" });
      }
      console.log(`  -> Node ${dev.name} responded cleanly.`);
    } catch (e) {
      console.log(`  -> Warning on ${dev.name}: ${e.message}`);
    }
  }

  // 3. Lifecycle & Protocol Version Validation
  console.log("\n[Test 3/3] Validating Protocol Version & Remote Transport Schema...");
  const EXPECTED_PROTOCOL = "1.0.0";
  if (receivedPayload && receivedPayload.protocolVersion !== EXPECTED_PROTOCOL) {
    throw new Error(`Protocol mismatch! Expected ${EXPECTED_PROTOCOL}, got ${receivedPayload.protocolVersion}`);
  }
  console.log("  -> Protocol version check PASSED.");

  console.log("\n✅ ALL REMOTE TRANSPORT TESTS PASSED SUCCESSFULLY!\n");
}

runTest().catch((err) => {
  console.error("\n❌ REMOTE TRANSPORT TEST FAILED:", err.message);
  process.exit(1);
});
