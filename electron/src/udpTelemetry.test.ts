import { describe, expect, it } from "vitest";
import {
  isNewerSequence,
  parseTelemetryDatagram,
  UdpTelemetryTracker,
} from "./udpTelemetry.js";

function frame(sequence: number, version = 8): Uint8Array {
  const data = new Uint8Array(8);
  const view = new DataView(data.buffer);
  view.setUint16(0, 0x5253, true);
  view.setUint8(2, version);
  view.setUint32(4, sequence, true);
  return data;
}

describe("UDP telemetry framing", () => {
  it("parses the v8 header", () => {
    expect(parseTelemetryDatagram(frame(42))).toEqual({ version: 8, sequence: 42 });
  });

  it("rejects malformed and obsolete frames", () => {
    expect(parseTelemetryDatagram(new Uint8Array(7))).toBeNull();
    expect(parseTelemetryDatagram(frame(1, 7))).toBeNull();
  });

  it("compares wrapping sequence numbers", () => {
    expect(isNewerSequence(0, 0xffffffff)).toBe(true);
    expect(isNewerSequence(10, 9)).toBe(true);
    expect(isNewerSequence(9, 10)).toBe(false);
  });
});

describe("UdpTelemetryTracker", () => {
  it("counts gaps and drops duplicate/out-of-order packets", () => {
    const tracker = new UdpTelemetryTracker();
    expect(tracker.accept(frame(10), "192.168.5.115", 1000)).toBe(true);
    expect(tracker.accept(frame(13), "192.168.5.115", 1017)).toBe(true);
    expect(tracker.accept(frame(12), "192.168.5.115", 1020)).toBe(false);
    expect(tracker.snapshot(1020)).toMatchObject({
      receivedPackets: 2,
      lostPackets: 2,
      outOfOrderPackets: 1,
      state: "live",
    });
  });

  it("accepts a fresh epoch after a Core restart gap", () => {
    const tracker = new UdpTelemetryTracker();
    tracker.accept(frame(50_000), "host", 1000);
    expect(tracker.accept(frame(1), "host", 2601)).toBe(true);
    expect(tracker.snapshot(2601).lostPackets).toBe(0);
  });
});
