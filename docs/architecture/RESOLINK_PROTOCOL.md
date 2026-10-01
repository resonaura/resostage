# ResoLink session synchronization foundation

Status: engine protocol/PLL primitives and tests implemented; application
network-session, clock actuation, redundancy, and distributed DSP integration
remain proposed. Source review: 2026-10-01.

## Do not confuse remote control with Core-to-Core synchronization

Native remote control is implemented: Electron commands a playback Core over
HTTP and receives UDP telemetry. ResoLink is a different prospective topology
for several playback Cores. The existence of packet structures or a PLL test
does not make redundant playback or remote instruments a shipped capability.

| Path | Current scope |
| --- | --- |
| Electron/Core telemetry | Current v9 sampled state on a controller-selected UDP port, plus reliable HTTP commands. |
| ResoLink primitives | Version-1 beacon and ping/pong encoding, validation, and follower-clock calculation in `core/engine/resolink/`. |
| ResoLink app session | No implemented Core network-session owner/dispatch or rate-actuation path found in `core/app/` during this review. |
| Distributed audio/MIDI | Proposed; no shipped remote vendor-render/audio-return routing verified. |

QUIC, TCP fallback, audio jitter buffers, leader election, and automatic
glitch-free failover are design possibilities, not implemented transports.

## Implemented binary primitives

`ResoLinkProtocol.h` defines magic `0x52534C4B`, version 1, and the proposed
default port 28992. Little-endian encode/decode helpers validate packet shape
and fields. `ResoLinkBeacon` is 72 bytes and carries sequence, flags, time
signature, tempo-map version, leader identity/time, signed sample position,
sample rate, beat position, and BPM. `ResoLinkPingPong` is 56 bytes and carries
peer IDs, ping sequence, and three monotonic timestamps. Those concrete
structures are the ABI; earlier smaller illustrative beacon examples are not.

## Implemented follower-clock calculation

`SessionClock` owns configurable role/lock state and publishes a bounded
`SeqLock<SessionClockSnapshot>` for readers. Defaults from `SessionClock.h`:

- maximum calculated frequency slew: ±100 ppm;
- lock tolerance: 1 ms;
- sample-snap request above 50 ms phase error;
- holdover after 500 ms without a beacon;
- unlocked after two seconds without a beacon.

Beacon/pong handlers calculate drift/offset and can request a sample snap.
They do not themselves change the audio hardware clock or insert a fractional
resampler. A prospective session worker must own all mutating PLL calls and
apply transport/rate changes through established engine boundaries. “PTP-grade”
or sub-millisecond end-to-end synchronization requires network/hardware evidence
beyond the math primitive.

## Persisted execution metadata

`TrackDef` can retain `ExecutionTarget::Local` or `RemotePeer`, along with peer
metadata. This is preparatory schema, not proof that remote tracks are rendered
on another machine or that network latency is included in live PDC. Implement
and test the command, timing, stream, failure, and recovery paths together.

## Remaining implementation/acceptance

1. Define a bounded session worker, peer lifecycle, trustworthy packet source,
   delivery policies, and stale-generation handling.
2. Integrate clock calculations with authoritative transport/sample timing,
   without callback I/O, blocking, allocation, or abrupt rate changes.
3. Specify practical leader selection, loss/holdover, seek, restart, and
   mismatched-tempo/device behavior.
4. Design distributed MIDI/audio transport and bounded jitter/PDC only if that
   scope is accepted; do not build it implicitly from an execution-target flag.
5. Validate real multi-machine phase/error distributions, failover, long runs,
   cable loss, and clock drift before advertising redundancy.

`core/tests/test_resolink_protocol.cpp` covers packet round-trips, malformed
frames, follower PLL/snap/holdover, ping/pong calculation, and concurrent
snapshot reads. It does not exercise a running two-Core session.
