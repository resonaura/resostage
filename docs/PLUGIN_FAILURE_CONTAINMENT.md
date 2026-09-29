# Plug-in failure containment and live hosting

Status: live AU/VST3 execution moved out of Core on 2026-09-28. This protects
Core and unrelated chains from native plug-in crashes/hangs during live use. It
is process isolation, not an operating-system security sandbox. Offline renders
still execute plug-ins in the renderer process.

## Process layout

- `resostage-plugin-scanner` remains responsible only for plug-in discovery.
- Core launches the packaged `resostage-plugin-host` for each non-empty live
  serial strip chain (at most 32 helpers). A helper owns its plug-in instances,
  state restoration/capture, DSP execution, and editor windows. Empty chains
  do not start a helper.
- Core still owns the project, routing graph, transport, and output callback.
  The graph calls a pre-bound proxy in `PluginProcessorBank`; no vendor object
  or pointer crosses the process boundary.
- Rebuilds within the same project epoch reuse unchanged, healthy chain helpers.
  Only changed/failed chains are replaced. Whole-project replacement advances
  the epoch, invalidates pending work, and starts new helpers with only the
  incoming project's state.

## Audio/control protocol

The versioned `PluginHostProtocol.h` ABI maps three fixed-capacity audio slots
into shared memory. Each slot is an explicit ownership sequence
`Empty -> Writing -> Ready -> Processing -> Complete -> Empty`; generation and
layout are validated on both sides. Audio is planar float. Each block carries a
bounded transport snapshot and up to 512 MIDI 1.0 packets of at most 16 bytes;
larger MIDI/SysEx packets are not forwarded. Parameter and bypass changes use a
separate bounded MPMC queue. Commands for state capture and editor lifecycle
are non-audio operations.

The device callback never waits for a host, takes no process-control lock,
allocates no memory, and performs no filesystem or child-process work. It copies
into fixed arrays, advances lock-free slot state, and sends a non-waiting wake
signal. The asynchronous host has a one-callback pipeline; PDC includes the
nominal device callback quantum plus the plug-in-reported latency, not the
larger preallocated buffer capacity. If an effect response is late, that block
keeps its dry signal; if an instrument response is late, that block is silent.
Health counters record missed input/output blocks and rejected control events.
Runtime plug-in latency changes are published atomically by the helper and
cause Core to rebuild the delay plan without restarting an otherwise healthy
chain. Sample-rate or shared-buffer-capacity changes do require a new helper.

## Lifecycle, state, and recovery

- Helper startup has a bounded 30-second readiness deadline. Plug-in creation
  and restoration occur inside the child, so a native failure cannot unwind
  through Core.
- A non-realtime watchdog observes helper liveness, audio progress, and pending
  command age. A stalled/dead helper is terminated away from audio. The current
  chain becomes unavailable; Core makes one automatic restart attempt per
  strip/project epoch. Further attempts require an explicit retry, preventing
  an endless respawn loop. A crashed helper's in-flight state is not recoverable
  beyond the last saved project state.
- The child uses normal JUCE plug-in construction and runtime behavior; it is
  not given a sandbox profile or reduced OS permissions. A hostile plug-in may
  still access resources available to the current user or affect other child
  processes through external means.
- Project-provided state is extracted through the path-confined project loader
  and capped at 64 MiB per slot / 256 MiB per bank. The helper receives a
  private, per-chain project snapshot under a user-only directory on POSIX.
  Save asks the helper to capture state on a non-realtime worker; Core validates
  and copies bounded state files into the ordinary project save. Capture is
  isolated per plug-in from its audio call; it does not pause the whole chain.
- Parameter/bypass changes are delivered even while transport is stopped. Host
  parameter changes notify Core so the project can be marked dirty. Plug-in
  editors run in the owning helper, separate from Core's UI and audio callback.
- Same-project graph edits reuse unchanged hosts. Device/block-size changes
  rebuild delay compensation using the new nominal callback quantum without
  unnecessarily replacing a healthy chain helper.

## Scope and known limits

- Offline audio export uses the existing production renderer and a distinct
  in-process processor bank. Offline vendor crashes are not contained by this
  live-host guarantee.
- The shared protocol currently forwards MIDI 1.0 messages only and limits
  packets to 16 bytes; it does not transport arbitrary SysEx or MIDI 2.0 UMP
  packets through the live plug-in boundary.
- Per-chain helpers contain a crash to that serial chain, not one plug-in slot.
  A crash loses all plug-ins in that chain until recovery, while other chains
  and Core continue.
- The implementation is not a sandbox. It does not promise protection against
  plug-in data exfiltration, OS-level attacks, kernel faults, exhausting shared
  machine resources, or damage through intentionally shared external devices.
- The bounded pipeline adds a device-block of live latency. Low-latency
  monitoring policy remains responsible for bypassing unsafe/high-latency
  monitoring paths; no process IPC can provide same-callback plug-in output.

## Verification currently present

`test_plugin_host_protocol.cpp` covers ABI/generation validation, slot ownership
and malformed frames, concurrent bounded control producers, cross-process
shared memory and wake signaling, and a real helper-process round trip with
one-block latency and variable callback-size FIFO handling. Native build also
verifies that the host executable is linked and embedded beside Core. The test
suite does not yet inject a real third-party plug-in crash/hang or verify
restart with vendor-specific state; those remain important follow-up integration
tests on macOS, Windows, and Linux.

## Project switch / chain edit matrix

| Current state | Action | Required behavior |
| --- | --- | --- |
| Project A has several live chains | Load project B with different plug-ins | Advance epoch; A helpers become ineligible and are stopped away from audio; B restores only B state. |
| Project A has plug-ins | Load a project with no plug-ins | Publish an empty bank; no prior helper audio or MIDI remains. |
| Several chains are healthy | Add/remove/bypass one slot | Reuse unaffected helpers; replace only the edited chain, preserving a live state snapshot where available. |
| One helper crashes or stalls | Continue transport | Core remains alive; only that chain misses output; make one automatic restart, then require explicit retry. |
| State parser crashes during live restore | Open project | Helper exits; Core remains alive and reports the affected chain failed. |
| State parser crashes during offline render | Export | Renderer process may fail; this live-host safety boundary does not apply. |
| Project A build is slow; then load B | Rapid replacement | A's stale result/helper cannot publish into B's project epoch. |
