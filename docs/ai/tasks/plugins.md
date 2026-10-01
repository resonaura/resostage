# AU/VST3 performance and stability

## Goal

After embedded FFmpeg is complete, improve predictable AU/VST3 performance for
heavy projects, small buffers, stopped monitoring, project reopen, and chain
edits. Preserve crash containment and audible state; optimize from evidence.

## Owners and entry points

- `core/app/plugins/PluginHostProcess`, `PluginHostRuntime`, and
  `PluginProcessorBank`: per-chain isolated helpers, IPC, worker wakes, state,
  editor windows, readiness, and deadlines.
- `core/engine/plugins/PluginHostProtocol.h` and `PluginPowerManager`: bounded
  shared memory, coalesced signals, and safe power management.
- `core/app/engine/AudioEnginePlugins.cpp`, `AudioEngine.cpp`, and routing/PDC:
  immutable bank publication, compatibility, project epoch, callback work.
- `core/tests/test_plugin_{performance,hardening,host_protocol,power_manager}`
  and `test_offline_renderer.cpp`: focused verification.

## Plan

1. Read `AGENTS.md` fully and identify writers, readers, lifetimes, bounds, and
   failure policies before touching callback/IPC code.
2. Measure optimized baseline and inspect avoidable per-block copies, scans,
   wakeups, allocation, control contention, buffer clearing, and stale results.
3. Fix specific evidenced bottlenecks without weakening epoch checks, helpers,
   cancellation, queues, or PDC. Reuse healthy chains; avoid reloading vendors
   for unrelated edits.
4. Verify rendering, monitoring, stop/seek/cycle, insert/reorder/bypass/remove,
   project replacement, host fault/restart, and saved state.
5. Record workload/build/machine/sample rate/buffer size and before/after cost,
   deadline misses, and idle CPU. Update architecture documentation only for
   material implemented changes.

## Invariants

Core audio never waits for the helper and never loads live vendor DSP in-process.
No unbounded retry, routine allocation, logging, I/O, or blocking locks in the
callback. Effects retain dry input on a missed result; instruments emit bounded
silence. Preserve sample-origin and plug-in latency compensation.

## Status

Read-only audit, the first focused implementation pass, and optimized focused
verification completed on 2026-09-30. The current
working tree also contains intentional copyright-header changes; do not revert
them while making focused plug-in changes.

## Findings, changes, and verification

### Baseline and its limits

Machine: macOS Apple Silicon `MacBookPro17,1`, 8 physical cores, 8 GiB RAM.
Existing native binary: `core/build/tests/resostage_engine_tests`, configured
`RelWithDebInfo`. Command:

```sh
core/build/tests/resostage_engine_tests --test-suite=PluginPerformance,PluginPowerManager --no-colors=true
```

Result: 12 test cases / 55 assertions passed. At 48 kHz the synthetic routing
graph (8 audio tracks, 2 send buses, 1 main) cost 1.264 / 2.269 / 4.696 / 8.566 /
16.967 microseconds per 64 / 128 / 256 / 512 / 1024-frame block. Eight synthetic
insert processors at 256 frames cost 3.951 microseconds per block. This is a
renderer/domain baseline; it does **not** measure vendor AU/VST3 execution,
shared-memory scheduling, callback p99, or a heavy real project. Do not present
these numbers as proof that actual plug-in dropouts are fixed.

The existing host integration suite also passed before implementation:
`--test-case='plug-in host*,isolated*' --no-colors=true` reported 11 test cases /
3315 assertions in 3.86 seconds. The AU instrument, AU effect, VST3 processing,
and editor tests ran without a fixture-skip message. This establishes a
functional baseline for focused changes, not a heavy-load performance claim.

### Evidenced work to remove first

1. `PluginProcessorBank.cpp::processChain` creates and zero-initializes an array
   of 512 `plugin_host::MidiEvent` objects on every hosted strip block (12 KiB
   even with no MIDI). Keep prepared scratch in `StripChain`; initialize only
   the used event entries. Use JUCE's raw `MidiMessageMetadata` range iterator
   rather than the deprecated iterator producing an owning `MidiMessage`.
   The current iterator can allocate for long SysEx before the IPC size check
   discards it. Preserve sample offsets, byte limits, and the 512-event bound.
2. The same method scans all chain nodes to decide instrument miss fallback on
   every callback. Prepare that immutable property when constructing the
   chain and share it with `stripHasInstrument`, whose current node scan is
   also called from audio MIDI dispatch. Missing instruments must still fail
   to silence; missing effects remain dry.
3. `PluginHostMain.cpp::runAudioWorker` calls `parentAlive` after each audio
   semaphore wake. That performs an OS process syscall (on Windows, also opens
   and closes a process handle). Parent supervision already has an independent
   250-ms watchdog and message-thread check. Remove redundant DSP-worker
   liveness work while preserving startup validation and the independent
   watchdog so parent death still terminates an idle helper.
4. Avoid scanning input audio for instrument nodes: their power activity
   decision uses MIDI only. Effects must continue to inspect the signal they
   actually receive after the preceding insert, including instruments.

### Reliability findings requiring a separate focused change

- The 4096-byte MIDI reservation was insufficient for 512 host packets of up
  to 16 bytes; the first implementation pass below fixes this. Its counters
  are available through the bank's diagnostic accessor but are not yet wired
  into UI/UDP health telemetry.
- `PluginSlotPowerTracker` exposes ordinary `flags` and
  `silentSamplesAccumulated` to both UI/control mutations and DSP processing.
  `setKeepAwake`, `unpark`, and `forceAwake` can race the helper's audio writer.
  Make the DSP thread the sole writer of follower/decay state and publish
  bounded atomic intents/guard flags; do not add a blocking lock.
- In isolated mode, `setSlotKeepAwake`, `parkSlot`, `unparkSlot`, and prewarm
  currently mutate the Core proxy node's tracker, not the actual helper node.
  Their UI state can therefore disagree with vendor processing. Carry typed
  bounded power controls through the host queue, version the ABI if its
  semantics change, and test remote power transitions. `Parked` currently
  skips processing but does not unload/serialize the instance; documentation
  must not promise unloading until that behavior exists.
- The helper main timer runs every 8 ms even when no editor command/state
  change exists. At 32 chains this is up to 4000 timer callbacks per second,
  independent of audio. Measure idle CPU first; then use event-triggered
  message-thread dispatch or a justified slower bounded timer. Do not move
  vendor editor work off the JUCE message thread.
- The real host tests currently prove 512-frame AU/VST3 basics, editor opening,
  and a short paced VST3 sequence. They do not cover 32-chain scheduling,
  dense MIDI, stop/seek/cycle, reopen, or fault injection. Some tests can
  skip if the local registry/vendor is absent; record skips explicitly.
- `AudioEngineEventDispatch.cpp::prewarmPluginsLookahead` is called on every
  callback (`AudioEngine.cpp`) and scans the whole song's audio/MIDI regions,
  then calls `MixGraph::find` for each overlapping region. Proxy prewarm does
  not currently reach helper trackers. Prepare a compact indexed upcoming
  activity snapshot when the song/region structure changes, and dispatch
  bounded remote wake intents only on the necessary state edge. Do not claim
  heavy-project optimization from fixing packet preparation alone.

### First implementation pass

- Added `core/app/plugins/PluginMIDIBuffer.h`: live ingress reserves exactly
  `512 * (16 + sizeof(int32) + sizeof(uint16)) = 11,264` JUCE bytes and rejects
  oversized/malformed/newest overflow events before storage can grow.
  Counters last for the bank lifetime and can be queried via
  `PluginProcessorBank::rejectedMidiEvents` off the callback. Full Stop/panic
  bursts have priority: an existing full music buffer is cleared and counted
  only if a complete 32/48-event channel-wide burst would not fit.
- Offline banks explicitly allow the previous full-SysEx/large-MIDI behavior
  on the non-realtime worker. Live Core and helper banks retain the existing
  IPC maximum of 512 events / 16 bytes per packet; increasing SysEx/live MIDI
  transport capacity is a separate protocol decision.
- Hosted MIDI scratch now belongs to the prepared strip chain. Raw JUCE
  metadata copying writes only present events, with sample/payload bounds,
  and never constructs an owning MIDI message. The helper's packet ingress
  also accepts raw bytes so valid 9–16-byte packets do not allocate a temporary
  message just to enter a prepared buffer.
- Chain instrument presence is computed at build/publication and reused by
  host miss fallback and `stripHasInstrument`. In-process generator nodes skip
  the irrelevant audio-input scan; effects still examine preceding output
  when MIDI alone has not already made them active.
- Removed per-audio-wake OS parent-liveness calls. Startup validation, the
  independent 250-ms parent watchdog, and message-thread supervision remain.
- No ABI, latency, queue, state restore, helper ownership, or PDC changes.
- Added focused tests for a complete 512 x 16-byte burst with stable storage,
  repeated capacity reuse, oversize/null/negative input rejection, raw packet
  view bounds/padding preservation, panic priority, and offline full SysEx.
  Added a comparison microbenchmark for former packet preparation versus raw
  prepared views at 0/4/512 events. This measures that preparation operation,
  not vendor DSP or scheduling tail latency.

### Verification results after implementation

The optimized shared build completed for `ResoStage`, plug-in host, and native
tests with these changes. After compilation finished (to avoid AU editor
timing failures under build load), the focused tests passed:

```sh
core/build/tests/resostage_engine_tests --test-suite='PluginPerformance,PluginPowerManager,PluginHardening' --no-colors=true
core/build/tests/resostage_engine_tests --test-case='plug-in host*,isolated*,offline plug-in MIDI*' --no-colors=true
```

First command: 16 cases / 873 assertions; second: 15 cases / 4939 assertions.
The actual AU effect/instrument, VST3 output, and editor tests ran without
fixture-skip messages. Total: 31 focused cases / 5812 assertions passed.
`git diff --check` passed for the edited plug-in sources/tests/task document.

Microbenchmark: same machine and optimized build as baseline, 20,000 prepared
512-frame iterations per workload at the 48-kHz test context. Times measure
only packet preparation; the previous algorithm (full scratch clear + owning
iterator) and new prepared/raw-view algorithm run in the same binary:

| Events per block | Previous preparation | Prepared raw views |
| --- | --- | --- |
| 0 | 0.1772 microseconds | 0.0021 microseconds |
| 4 | 0.1787 microseconds | 0.0216 microseconds |
| 512 | 4.6017 microseconds | 2.6206 microseconds |

The domain routing results remain consistent with baseline (1.154 / 2.280 /
4.376 / 8.640 / 17.073 microseconds at 64 / 128 / 256 / 512 / 1024 frames).
No claim is made about all vendors, 32-chain overload, device callback p99,
or load-dependent dropout elimination. Power-control ownership/remote intents,
indexed lookahead, heavy project measurements, and UI drop-counter telemetry
remain explicit follow-up work above. Coordinate `core/build` with other
agents; never run the shared CMake build directory concurrently.

### Verification for the first implementation pass

Build the optimized host and native tests after edits. Run `PluginPerformance`,
`PluginPowerManager`, `PluginHardening`, and all `plug-in host*` / `isolated*`
tests; the macOS catalog currently provides Apple DLSMusicDevice and a real
Voxengo MSED VST3 fixture. Preserve actual AU note sound and VST3 processed
output, editor open/close, two-callback origin, stale-completion rejection,
queue overflow, and wake coalescing. Add focused dense-MIDI/allocation tests
when changing MIDI preparation. For quantitative heavy-project claims, record
real helper count, chain composition, 48 kHz buffer size, callback wall/CPU
histograms, missed-input/output counters, and idle CPU before/after under the
same workload. A single synthetic average is insufficient.
