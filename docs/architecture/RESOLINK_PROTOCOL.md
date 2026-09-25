# Architecture Specification: ResoLink Session Synchronization & Distributed Engine Protocol

**Status**: `IN_PROGRESS` (Phase 6)

---

## 1. Motivation & Principles

Modern live productions often deploy multiple redundant or distributed computers:
- **Redundant Playback**: Primary and Secondary Core engines running in lockstep with automatic glitch-free failover.
- **Distributed Processing**: Offloading heavy synth instruments or sample libraries to a secondary rack machine, while mixing and master bus processing remain on the main rig.
- **Multi-Musician Jam / Session Sync**: Multiple performers running ResoStage synchronizing tempos, section boundaries, and transport without manual MIDI clock cables.

ResoLink provides a native, low-latency Core-to-Core protocol designed specifically for show-critical reliability.

---

## 2. Protocol Boundaries: ResoLink vs Electron Telemetry

It is vital to distinguish between ResoStage's existing UI telemetry and ResoLink:

| Feature | Electron UI Telemetry (v8) | ResoLink Session Protocol |
| --- | --- | --- |
| **End-Points** | Core -> Electron Renderer / UI | Core <-> Core (Peer-to-Peer / Leader-Follower) |
| **Transport** | Ephemeral UDP (Port 2898/ephemeral) | QUIC (TCP fallback) + UDP Real-Time Datagrams |
| **Payload** | Meter levels, playhead position, health counters | Transport locks, TempoMap diffs, Clock Beacons, Multi-channel Audio/MIDI streams |
| **Reliability** | Latest-wins sampled (drops are ignored) | Guaranteed delivery for states; Jitter-buffered for audio/clock |
| **Clock Precision** | Millisecond UI smoothing (~60 Hz) | Sub-millisecond sample phase synchronization |

---

## 3. Clock Synchronization: `SessionClock`

### 3.1. Anchor Beacons
The designated ResoLink Master (elected or configured) periodically transmits Anchor Beacons over UDP:

```cpp
struct ResoLinkAnchorBeacon {
    uint32_t magic;             // 'RSLK' (0x52534C4B)
    uint16_t protocolVersion;   // 1
    uint16_t flags;             // e.g. IS_LEADER, TRANSPORT_RUNNING
    uint64_t leaderMonotonicNs; // SystemMonotonicClock ticks of the sender
    uint64_t samplePosition;    // Master hardware sample counter
    uint32_t sampleRate;        // e.g. 48000
    uint32_t tempoMapVersion;   // Version of the authoritative TempoMap
    double playheadBeats;       // Authoritative musical beat position
};
```

### 3.2. Follower Clock Tracking
Follower Core engines listen to the Anchor Beacons:
1. Measure round-trip time (RTT) and one-way network jitter using ping/pong timestamps.
2. Filter clock drift using a proportional-integral (PI) phase-locked loop (PLL).
3. If follower hardware sample clock drifts from master, a fractional Sinc resampler adjusts audio output stream pitch by less than $\pm 10\text{ PPM}$ ($\pm 0.001\%$), ensuring phase lock with zero audible pitch artifacts.

---

## 4. Distributed Instrument Execution

ResoLink allows individual tracks to specify an execution target:

```text
TrackDef:
  kind: TrackKind::Instrument
  executionTarget: ExecutionTarget::RemotePeer("synth-rack-mac-studio")
```

When transport runs:
1. Primary machine sends sample-aligned MIDI events over ResoLink UDP stream to the remote peer.
2. Remote peer renders the synth instrument through its local `MixProcessorView`.
3. Remote peer streams audio frames back via low-latency uncompressed UDP datagrams.
4. Primary machine's `MixRenderer` receives the remote audio stream directly into the preallocated track scratch buffer.
5. Plug-in delay compensation (PDC) automatically accounts for network buffer round-trip time, phase-aligning the remote instrument with local tracks.
