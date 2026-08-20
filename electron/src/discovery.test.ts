import { describe, it, expect } from "vitest";
import {
  parseDiscoveryPacket,
  isSelfAnnouncement,
  upsertDevice,
  pruneDevices,
  mergeDiscovered,
  normalizeRemoteHost,
  remoteOriginFor,
  ipv4ToInt,
  intToIpv4,
  subnetCandidates,
  DEFAULT_BACKEND_PORT,
  DISCOVERY_PORT,
  type DiscoveredDevice,
} from "./discovery.js";

const pkt = (over: Partial<Record<string, unknown>> = {}) =>
  Buffer.from(
    JSON.stringify({ type: "RESOSTAGE_DISCOVERY", name: "win", platform: "win32", port: 2899, protocolVersion: "1.0.0", discoveryEnabled: true, ...over }),
  );

describe("parseDiscoveryPacket", () => {
  it("parses a well-formed announcement", () => {
    const d = parseDiscoveryPacket(pkt(), "192.168.5.125");
    expect(d).toEqual({
      name: "win",
      platform: "win32",
      ip: "192.168.5.125",
      port: 2899,
      protocolVersion: "1.0.0",
      discoveryEnabled: true,
    });
  });

  it("returns null for non-discovery traffic", () => {
    expect(parseDiscoveryPacket(Buffer.from("hello"), "1.2.3.4")).toBeNull();
    expect(parseDiscoveryPacket(Buffer.from('{"type":"other"}'), "1.2.3.4")).toBeNull();
    expect(parseDiscoveryPacket(Buffer.from("{not json"), "1.2.3.4")).toBeNull();
  });

  it("falls back to defaults for missing/invalid fields", () => {
    const d = parseDiscoveryPacket(pkt({ port: "garbage", protocolVersion: undefined, discoveryEnabled: false, name: undefined }), "10.0.0.1");
    expect(d?.port).toBe(DEFAULT_BACKEND_PORT);
    expect(d?.protocolVersion).toBe("0.0.0");
    expect(d?.name).toBe("10.0.0.1");
    expect(d?.discoveryEnabled).toBe(false);
  });
});

describe("isSelfAnnouncement", () => {
  const local = ["127.0.0.1", "::1", "192.168.5.174"];
  it("flags loopback", () => {
    expect(isSelfAnnouncement("127.0.0.1", local)).toBe(true);
    expect(isSelfAnnouncement("::1", local)).toBe(true);
  });
  it("flags a matching local address", () => {
    expect(isSelfAnnouncement("192.168.5.174", local)).toBe(true);
  });
  it("lets remote addresses through", () => {
    expect(isSelfAnnouncement("192.168.5.125", local)).toBe(false);
  });
});

describe("upsert/prune", () => {
  it("dedupes by ip:port, keeping the latest sighting", () => {
    const map = new Map<string, unknown>();
    upsertDevice(map as never, { ...pktDev("192.168.5.125", 2899), name: "a" }, 100);
    upsertDevice(map as never, { ...pktDev("192.168.5.125", 2899), name: "b" }, 200);
    expect(map.size).toBe(1);
    expect(pruneDevices(map as never, 300)[0].name).toBe("b");
  });

  it("prunes stale devices", () => {
    const map = new Map<string, unknown>();
    upsertDevice(map as never, pktDev("192.168.5.125", 2899), 0);
    upsertDevice(map as never, pktDev("192.168.5.126", 2899), 0);
    const alive = pruneDevices(map as never, 20_000, 15_000);
    expect(alive).toEqual([]);
  });

  it("sorts survivors newest-first", () => {
    const map = new Map<string, unknown>();
    upsertDevice(map as never, pktDev("192.168.5.125", 2899), 100);
    upsertDevice(map as never, pktDev("192.168.5.126", 2899), 900);
    const alive = pruneDevices(map as never, 1000);
    expect(alive[0].ip).toBe("192.168.5.126");
    expect(alive[1].ip).toBe("192.168.5.125");
  });
});

describe("mergeDiscovered", () => {
  it("backend wins on ip:port; shell fills gaps", () => {
    const backend = [pktDev("192.168.5.125", 2899, "backend-name")];
    const shell = new Map<string, unknown>();
    upsertDevice(shell as never, pktDev("192.168.5.125", 2899, "shell-name"), 1);
    upsertDevice(shell as never, pktDev("192.168.5.200", 2899, "shell-only"), 1);
    const merged = mergeDiscovered(backend, shell as never);
    expect(merged).toHaveLength(2);
    const byIp = new Map(merged.map((d) => [d.ip, d]));
    expect(byIp.get("192.168.5.125")?.name).toBe("backend-name");
    expect(byIp.get("192.168.5.200")?.name).toBe("shell-only");
  });

  it("sorts by ip", () => {
    const merged = mergeDiscovered([pktDev("10.0.0.5", 2899)], new Map() as never);
    expect(merged).toHaveLength(1);
  });
});

describe("normalizeRemoteHost", () => {
  it("keeps a bare IP on the default port", () => {
    expect(normalizeRemoteHost("192.168.5.125")).toEqual({ host: "192.168.5.125", port: DEFAULT_BACKEND_PORT });
  });
  it("pulls an explicit port", () => {
    expect(normalizeRemoteHost("192.168.5.125:3100")).toEqual({ host: "192.168.5.125", port: 3100 });
  });
  it("strips scheme and trailing path", () => {
    expect(normalizeRemoteHost("http://192.168.5.125:3100/foo/bar")).toEqual({ host: "192.168.5.125", port: 3100 });
    expect(normalizeRemoteHost("wss://host.local:9000/")).toEqual({ host: "host.local", port: 9000 });
  });
  it("honours an explicit default", () => {
    expect(normalizeRemoteHost("1.2.3.4", 3000)).toEqual({ host: "1.2.3.4", port: 3000 });
  });
});

describe("constants", () => {
  it("matches the core discovery port", () => {
    expect(DISCOVERY_PORT).toBe(28991);
  });
  it("renders a remote origin key", () => {
    expect(remoteOriginFor("192.168.5.125", 2899)).toBe("192.168.5.125:2899");
  });
});

describe("IPv4 helpers", () => {
  it("round-trips an address", () => {
    expect(intToIpv4(ipv4ToInt("192.168.5.174"))).toBe("192.168.5.174");
    expect(ipv4ToInt("192.168.5.174")).toBe(0xc0a805ae);
  });

  it("derives gateway and directed-broadcast for a /24", () => {
    expect(subnetCandidates("192.168.5.174", "192.168.5.174/24")).toEqual([
      "192.168.5.174",
      "192.168.5.1",
      "192.168.5.255",
    ]);
  });

  it("derives them for a /16 too", () => {
    expect(subnetCandidates("10.1.2.3", "10.1.2.3/16")).toEqual([
      "10.1.2.3",
      "10.1.0.1",
      "10.1.255.255",
    ]);
  });
});

function pktDev(ip: string, port: number, name = ip): DiscoveredDevice {
  return { name, platform: "win32", ip, port, protocolVersion: "1.0.0", discoveryEnabled: true };
}