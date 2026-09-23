import dgram from "node:dgram";
import { loadDeviceConfig } from "./lib/deviceRunner.mjs";

const MAGIC = 0x5253;
const MIN_VERSION = 8;
const DEFAULT_PORT = 2899;

function targetFromConfig() {
  const configured = loadDeviceConfig().find((device) => !device.isLocal && device.enabled !== false);
  const host = process.env.REMOTE_HOST || configured?.host;
  const port = Number(process.env.REMOTE_PORT || DEFAULT_PORT);
  if (!host) throw new Error("No remote device configured; set REMOTE_HOST");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Invalid REMOTE_PORT: ${process.env.REMOTE_PORT}`);
  return { host, port };
}

async function checkedFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs ?? 4000),
    headers: { "content-type": "application/json", ...options.headers },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function parseHeader(message) {
  if (message.length < 8 || message.readUInt16LE(0) !== MAGIC) return null;
  const version = message.readUInt8(2);
  if (version < MIN_VERSION) return null;
  return { version, sequence: message.readUInt32LE(4) };
}

function isNewer(candidate, previous) {
  const delta = (candidate - previous) >>> 0;
  return delta !== 0 && delta < 0x80000000;
}

async function bindUdpReceiver() {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "0.0.0.0", resolve);
  });
  const address = socket.address();
  if (typeof address === "string") throw new Error("Expected an IPv4 UDP socket");
  return { socket, port: address.port };
}

async function collectTelemetry(socket, expectedSource, durationMs = 3000) {
  const stats = {
    packets: 0,
    bytes: 0,
    lost: 0,
    duplicatesOrOutOfOrder: 0,
    malformed: 0,
    wrongSource: 0,
    versions: new Set(),
    intervals: [],
  };
  let previousSequence = null;
  let previousArrival = null;

  const onMessage = (message, remote) => {
    if (remote.address !== expectedSource) {
      stats.wrongSource += 1;
      return;
    }
    const header = parseHeader(message);
    if (!header) {
      stats.malformed += 1;
      return;
    }
    const now = performance.now();
    if (previousSequence !== null) {
      if (!isNewer(header.sequence, previousSequence)) {
        stats.duplicatesOrOutOfOrder += 1;
        return;
      }
      stats.lost += ((header.sequence - previousSequence) >>> 0) - 1;
    }
    if (previousArrival !== null) stats.intervals.push(now - previousArrival);
    previousArrival = now;
    previousSequence = header.sequence;
    stats.versions.add(header.version);
    stats.packets += 1;
    stats.bytes += message.length;
  };

  socket.on("message", onMessage);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  socket.off("message", onMessage);
  return stats;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function run() {
  const { host, port } = targetFromConfig();
  const baseUrl = `http://${host}:${port}`;
  console.log(`ResoStage native remote test -> ${baseUrl}`);

  const discovery = await checkedFetch(`${baseUrl}/api/v1/remote/discovery`);
  if (typeof discovery?.enabled !== "boolean")
    throw new Error("Remote Core returned an invalid discovery response");
  console.log("  control probe: OK");

  // This command only records the active SPA view. It proves the controller's
  // write path without starting/stopping audio or modifying the project.
  await checkedFetch(`${baseUrl}/api/v1/view`, {
    method: "POST",
    body: JSON.stringify({ view: "all" }),
  });
  const state = await checkedFetch(`${baseUrl}/api/v1/state`);
  if (!state || typeof state !== "object") throw new Error("Remote state response is invalid");
  console.log("  command + state round-trip: OK");

  const { socket, port: localPort } = await bindUdpReceiver();
  try {
    await checkedFetch(`${baseUrl}/api/v1/remote/subscribe-udp`, {
      method: "POST",
      body: JSON.stringify({ port: localPort }),
    });
    const stats = await collectTelemetry(socket, host);
    if (stats.packets < 30)
      throw new Error(`Only ${stats.packets} UDP telemetry packets arrived in 3 seconds`);
    if (stats.malformed > 0)
      throw new Error(`${stats.malformed} malformed UDP telemetry packets arrived`);
    const totalExpected = stats.packets + stats.lost;
    const lossPercent = totalExpected > 0 ? (stats.lost / totalExpected) * 100 : 100;
    if (lossPercent > 10)
      throw new Error(`UDP telemetry loss is too high: ${lossPercent.toFixed(2)}%`);

    const average = stats.intervals.length
      ? stats.intervals.reduce((sum, value) => sum + value, 0) / stats.intervals.length
      : 0;
    console.log(
      `  UDP telemetry: ${stats.packets} packets, ${stats.bytes} bytes, ` +
      `${lossPercent.toFixed(2)}% loss, avg ${average.toFixed(1)} ms, ` +
      `p95 ${percentile(stats.intervals, 0.95).toFixed(1)} ms, ` +
      `protocol v${[...stats.versions].join(",")}`,
    );
    if (stats.duplicatesOrOutOfOrder > 0)
      console.log(`  note: ${stats.duplicatesOrOutOfOrder} duplicate/out-of-order packets rejected`);
  } finally {
    socket.close();
  }

  console.log("Remote control and UDP telemetry test passed.");
}

run().catch((error) => {
  console.error(`Remote test failed: ${error.message}`);
  process.exitCode = 1;
});
