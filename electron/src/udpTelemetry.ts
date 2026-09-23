/**
 * Validation and receive-side accounting for the native UDP telemetry lane.
 *
 * This module deliberately has no Electron or socket side effects. The main
 * process can therefore reject malformed/out-of-order datagrams before they
 * cross IPC, and the sequence arithmetic is covered by ordinary unit tests.
 */

export const TELEMETRY_MAGIC = 0x5253;
export const TELEMETRY_MIN_VERSION = 8;

export interface TelemetryDatagram {
  version: number;
  sequence: number;
}

export interface UdpTelemetryStats {
  state: "waiting" | "live" | "stale";
  localPort: number;
  source: string | null;
  receivedPackets: number;
  lostPackets: number;
  outOfOrderPackets: number;
  malformedPackets: number;
  receivedBytes: number;
  lastPacketAt: number | null;
  jitterMs: number;
}

export function parseTelemetryDatagram(data: Uint8Array): TelemetryDatagram | null {
  if (data.byteLength < 8) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint16(0, true) !== TELEMETRY_MAGIC) return null;
  const version = view.getUint8(2);
  if (version < TELEMETRY_MIN_VERSION) return null;
  return { version, sequence: view.getUint32(4, true) };
}

/** True when `candidate` is ahead of `previous` in a wrapping u32 sequence. */
export function isNewerSequence(candidate: number, previous: number): boolean {
  const delta = (candidate - previous) >>> 0;
  return delta !== 0 && delta < 0x80000000;
}

export class UdpTelemetryTracker {
  private lastSequence: number | null = null;
  private lastArrivalMs: number | null = null;
  private expectedIntervalMs = 1000 / 60;
  private stats: UdpTelemetryStats = {
    state: "waiting",
    localPort: 0,
    source: null,
    receivedPackets: 0,
    lostPackets: 0,
    outOfOrderPackets: 0,
    malformedPackets: 0,
    receivedBytes: 0,
    lastPacketAt: null,
    jitterMs: 0,
  };

  setLocalPort(port: number): void {
    this.stats.localPort = port;
  }

  reset(): void {
    const localPort = this.stats.localPort;
    this.lastSequence = null;
    this.lastArrivalMs = null;
    this.expectedIntervalMs = 1000 / 60;
    this.stats = {
      state: "waiting",
      localPort,
      source: null,
      receivedPackets: 0,
      lostPackets: 0,
      outOfOrderPackets: 0,
      malformedPackets: 0,
      receivedBytes: 0,
      lastPacketAt: null,
      jitterMs: 0,
    };
  }

  /**
   * Account for one packet and return whether it is safe to forward.
   * A gap longer than 1.5 s starts a new sequence epoch, which covers a Core
   * restart or switching machines without accepting late packets in normal use.
   */
  accept(data: Uint8Array, source: string, nowMs = Date.now()): boolean {
    const header = parseTelemetryDatagram(data);
    if (!header) {
      this.stats.malformedPackets += 1;
      return false;
    }

    const longGap = this.lastArrivalMs !== null && nowMs - this.lastArrivalMs > 1500;
    if (this.lastSequence !== null && !longGap) {
      if (!isNewerSequence(header.sequence, this.lastSequence)) {
        this.stats.outOfOrderPackets += 1;
        return false;
      }
      const delta = (header.sequence - this.lastSequence) >>> 0;
      if (delta > 1) this.stats.lostPackets += delta - 1;
    }

    if (this.lastArrivalMs !== null && !longGap) {
      const interval = nowMs - this.lastArrivalMs;
      const deviation = Math.abs(interval - this.expectedIntervalMs);
      this.stats.jitterMs += (deviation - this.stats.jitterMs) / 16;
      this.expectedIntervalMs += (interval - this.expectedIntervalMs) / 32;
    }

    this.lastSequence = header.sequence;
    this.lastArrivalMs = nowMs;
    this.stats.receivedPackets += 1;
    this.stats.receivedBytes += data.byteLength;
    this.stats.lastPacketAt = nowMs;
    this.stats.source = source;
    this.stats.state = "live";
    return true;
  }

  snapshot(nowMs = Date.now()): UdpTelemetryStats {
    const state =
      this.stats.lastPacketAt === null
        ? "waiting"
        : nowMs - this.stats.lastPacketAt > 1500
          ? "stale"
          : "live";
    return { ...this.stats, state, jitterMs: Math.round(this.stats.jitterMs * 10) / 10 };
  }
}
