# AU/VST3 power-control ownership and predictable callback work

## Objective

Remove verified races between plug-in control requests and DSP power tracking,
and make isolated helper power controls affect the vendor chain rather than
only Core's proxy. Preserve crash containment, latency, tails, and bounded
non-waiting callback work.

## Owners and boundaries

- `core/engine/plugins/PluginPowerManager.h`: DSP-owned follower and silent
  sample accumulator; atomic cross-thread guard/request publication.
- `core/engine/plugins/PluginHostProtocol.h`: fixed, versioned power mailboxes
  and helper-published state, separate from the parameter/event queue.
- `core/app/plugins/PluginHostProcess`, `PluginHostRuntime`, and
  `PluginProcessorBank`: forwarding requests and reading actual helper state.
- `core/tests/test_plugin_power_manager.cpp` and
  `test_plugin_host_protocol.cpp`: concurrent controls, bounds, actual AU/VST3
  power transitions, and regression coverage.

Root owns project-load readiness/play gating and history/state publication.
Do not change those paths or bank build signatures in this focused pass.

## Plan

1. Read the full architectural contract and record an optimized baseline.
2. Keep envelope/decay counters exclusively on the DSP thread. Public power
   methods publish coalesced atomic intentions; snapshots expose current
   requested state without accessing mutable DSP fields.
3. Forward coalesced bounded power controls to the helper, including one
   chain-level prewarm edge. Do not flood the 256-entry parameter queue from
   per-block arrangement lookahead.
4. Publish real helper power state through fixed atomic per-slot telemetry;
   do not report proxy-only suspension or unloading that does not occur.
   Bypass is also a paired latest-wins mailbox intent, so a saturated musical
   parameter queue cannot erase On/Off. Same-project history changes to bypass
   or keep-awake synchronize reused healthy helpers without vendor restart.
5. Verify guard changes, park/unpark, sustained tails, concurrent writers,
   actual AU/VST3 output, and zero queue growth. Coordinate the shared native
   build directory with root before compiling.

## Initial evidence (2026-10-01)

macOS Apple Silicon, optimized `RelWithDebInfo` build, 48 kHz synthetic graph
context. `PluginPerformance,PluginPowerManager` baseline: 13 cases / 577
assertions passed. Eight synthetic insert chains at 256 frames cost 3.951
microseconds per block. This is not a heavy-vendor/device dropout claim.

`setKeepAwake`, `setRecordArmed`, `setInputMonitoring`, `forceAwake`, and
`unpark` currently modify ordinary flags/counters beside DSP processing.
Isolated proxy controls do not reach the helper. Arrangement lookahead still
scans all song regions per callback; preparing a compact indexed activity
snapshot is a separate follow-up after this ownership fix is verified.

## Status

Complete. Verified 2026-10-01.
- `PluginPowerManager` maintains decay and envelope counters exclusively on the DSP thread; control calls publish atomic intents (`PluginPowerControl.h`).
- Shared-memory mailbox ABI v6 cleanly isolates power and bypass mailboxes from parameter queue.
- Coordinated optimized native rebuild and full test suite passed: `test_plugin_power_manager.cpp` (4 cases / 12 assertions passed), `test_plugin_host_protocol.cpp` (15 cases / 18,929 assertions passed including real Audio Unit AUDelay and VST3 MSED).
- MixRenderer 8-insert chain benchmarks confirmed: ~4.19 µs/block (0.078% of audio deadline at 256 frames).


## Ownership verification

`PluginPowerManager.h` and `PluginHostProtocol.h` pass a C++23 syntax check.
An independent optimized ThreadSanitizer probe on Apple Silicon completed
successfully with zero reports: two concurrent control writers each issued
100,000 guard/wake/park/unpark operations while the sole DSP thread processed
64-sample silent blocks. The final pinned-awake and unpinned-suspended checks
passed. This verifies the tracker/follower ownership change, not third-party
vendor internals or the whole application.

The repository's native test reproduces the same concurrent ownership workload
at 20,000 iterations. The helper integration coverage additionally exercises
AUDelay and MSED park/unpark, wake dominance, and sample-time suspension.
