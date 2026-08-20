// Pure LAN-discovery helpers shared by the Electron shell's UDP listener and
// the IPC bridge that reports discovered devices to the SPA.
//
// Kept free of Electron/Node side effects so the whole thing is unit-testable
// (see discovery.test.ts). The shell binds a UDP socket on 28991 and feeds
// each datagram through parseDiscoveryPacket(); the SPA-side handlers merge
// the shell's hear-set with whatever the active backend reports.
//
// Self-announcements are filtered using the host's own addresses, because a
// machine that is ALSO broadcasting (it is itself a ResoStage node) would
// otherwise list itself. The backend's C++ UdpDiscovery filters the same way.

export interface DiscoveredDevice {
  name: string;
  platform: string;
  ip: string;
  port: number;
  protocolVersion: string;
  discoveryEnabled: boolean;
}

export const DISCOVERY_PORT = 28991;
export const DEFAULT_BACKEND_PORT = 2899;
const STALE_MS = 15_000;

type ShellEntry = { dev: DiscoveredDevice; seen: number };

/**
 * Parse one UDP datagram into a DiscoveredDevice. Returns null when the
 * packet is not a RESOSTAGE_DISCOVERY announcement (or is malformed) so a
 * shared 28991 listener can ignore unrelated traffic.
 */
export function parseDiscoveryPacket(
  buf: Buffer,
  senderIp: string,
): DiscoveredDevice | null {
  try {
    const data = JSON.parse(buf.toString("utf8"));
    if (!data || data.type !== "RESOSTAGE_DISCOVERY") return null;
    const port = Number(data.port);
    return {
      name: String(data.name ?? senderIp),
      platform: String(data.platform ?? "unknown"),
      ip: senderIp,
      port: Number.isInteger(port) && port > 0 ? port : DEFAULT_BACKEND_PORT,
      protocolVersion: String(data.protocolVersion ?? "0.0.0"),
      discoveryEnabled: data.discoveryEnabled !== false,
    };
  } catch {
    return null;
  }
}

/** True when a packet's source address is one of this host's own addresses. */
export function isSelfAnnouncement(ip: string, localAddrs: string[]): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  return localAddrs.includes(ip);
}

/** Record a fresh sighting into the indexed hear-set (keyed by ip:port). */
export function upsertDevice(
  map: Map<string, ShellEntry>,
  dev: DiscoveredDevice,
  nowMs: number,
): void {
  map.set(`${dev.ip}:${dev.port}`, { dev, seen: nowMs });
}

/**
 * Drop entries not seen within `staleMs` and return the survivors, newest
 * first (a device that just announced rises to the top of the list).
 */
export function pruneDevices(
  map: Map<string, ShellEntry>,
  nowMs: number,
  staleMs = STALE_MS,
): DiscoveredDevice[] {
  for (const [key, entry] of map) {
    if (nowMs - entry.seen > staleMs) map.delete(key);
  }
  return [...map.values()]
    .sort((a, b) => b.seen - a.seen)
    .map((e) => e.dev);
}

/**
 * Merge a backend-provided device list with the shell's own hear-set. The
 * backend wins for identical ip:port (its fields are fresher); the shell
 * fills in anything the backend missed (e.g. when the local Core isn't
 * running, or during a remote session where we query a different host).
 */
export function mergeDiscovered(
  backend: DiscoveredDevice[],
  shell: Map<string, ShellEntry>,
): DiscoveredDevice[] {
  const out = new Map<string, DiscoveredDevice>();
  for (const d of backend) out.set(`${d.ip}:${d.port}`, d);
  for (const entry of shell.values()) {
    const key = `${entry.dev.ip}:${entry.dev.port}`;
    if (!out.has(key)) out.set(key, entry.dev);
  }
  return [...out.values()].sort((a, b) => a.ip.localeCompare(b.ip));
}

/**
 * Normalize a user-typed or discovered host string into a clean host + port.
 * Strips scheme and any trailing path, and pulls an explicit `:port` out so a
 * bare IP keeps the default backend port.
 */
export function normalizeRemoteHost(
  raw: string,
  defaultPort = DEFAULT_BACKEND_PORT,
): { host: string; port: number } {
  let s = (raw || "").trim();
  s = s
    .replace(/^https?:\/\//i, "")
    .replace(/^wss?:\/\//i, "")
    .replace(/\/.*$/, "");
  let port = defaultPort;
  if (s.includes(":")) {
    const idx = s.lastIndexOf(":");
    const p = parseInt(s.slice(idx + 1), 10);
    if (Number.isInteger(p) && p > 0) {
      port = p;
      s = s.slice(0, idx);
    }
  }
  return { host: s, port };
}

/** Canonical "host:port" string used as a remote-session key / display. */
export function remoteOriginFor(host: string, port: number): string {
  return `${host}:${port}`;
}

/** IPv4 dotted-quad to an unsigned 32-bit integer. */
export function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

/** Unsigned 32-bit integer back to an IPv4 dotted-quad string. */
export function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((s) => ((n >>> s) & 255).toString()).join(".");
}

/**
 * Subnet topology derived from one of this host's IPv4 interface addresses
 * (plus its CIDR), used to pick reliable unicast targets for triggering macOS
 * Local-Network privacy (see triggerLocalNetworkPermission in main.mts).
 */
export function subnetCandidates(ip: string, cidr: string): string[] {
  const bits = parseInt(cidr.split("/")[1], 10) || 24;
  const ipInt = ipv4ToInt(ip);
  const mask = bits <= 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = ipInt & mask;
  const gateway = (net | 1) >>> 0;
  const directedBcast = (net | (~mask >>> 0)) >>> 0;
  return [ip, intToIpv4(gateway), intToIpv4(directedBcast)];
}