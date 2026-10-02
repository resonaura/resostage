# Indexed plug-in activity and heavy-project acceptance

Status: current follow-up, 2026-10-01. Earlier cross-thread power/bypass mailbox
work is implemented and preserved in [the power architecture](../../architecture/PLUGIN_POWER_MANAGEMENT.md)
and [dated benchmark evidence](../../performance/PLUGIN_BASELINE.md).

The 2026-10-01 native validation passed the Core build and 542 native test
cases / 287,112 assertions; the UI suite passed 553 tests. These are regression
results, not heavy-vendor acoustic acceptance or callback-allocation proof.

## Current correctness/performance pass

The following ownership changes are implemented in `d23fdeb` and retained:

- JUCE-free `PluginDelayBank`: builder never reads live mutable ring samples;
  unchanged topology/rate/delay shares the one DSP owner's ring. Changed
  delay/rate/topology starts fresh and can have a bounded refill transient.
- Fixed helper-owned held/sustained MIDI intent keeps silent long-attack
  instruments running. Overlapping notes/channel ownership, sustain and panic
  are counted without growing storage. Saturation conservatively stays awake.
- A guarded quiet tracker skips per-sample envelope work and starts a full
  quiet hold after its guard leaves. The second intent application after vendor
  processing is intentionally retained for concurrent control requests.

Do not claim these are hardware/dropout verified until the final native and
real AU/VST3 fixture tests finish. No IPC ABI or project schema change is needed.

## Indexed lookahead — implemented follow-up

`ProjectActivityIndex` now prepares all-song merged intervals and owned maps on
the message thread. `prewarmPluginsLookahead` queries only hosted strip indices;
missing preparation keeps chains awake, with no raw-region fallback. Fader/pan,
processor-only and cycle-locator publications reuse the cache. Content edits,
history, tempo, epoch, routing binding and rate changes invalidate it.

Gapless promotion selects the next song's prepared TempoMap, checks preallocated
event capacity before touching streams, and retains message-thread ownership of
retired publications/nested maps. Budget fallback maps have separate owners too.
See `core/tests/test_song_activity_index.cpp` for timing/interval, compatibility,
mutation-independent snapshots, nested retirement and preparation-limit tests.
The 10,000-region lookup comparison is a synthetic microbenchmark, not a full
audio callback measurement. Still obtain actual heavy saved-state AU/VST3
measurements, project-history and gapless device traces, and allocator-probe
evidence for the whole callback before claiming dropout elimination.

## Remaining host integrations

- Core R/I routing setters now update the active proxy bank and forward paired,
  coalesced guard controls to isolated helpers. New isolated snapshots persist
  their initial guard state. Protocol mailbox tests and the full Core target
  compile pass; add a real helper transition test when the harness can inspect
  track-level power state end to end.
- State capture defers instrument MIDI into a fixed-capacity per-node FIFO,
  replays with block-relative sample offsets, and degrades overflow to channel
  panic rather than silently leaving voices held. Snapshot publication stages a
  complete directory before replacing the previous state. Focused FIFO,
  overflow, helper load/render tests passed (1,995 assertions). Still exercise
  dense sustain-release/panic traffic during a deliberately slow real vendor
  state capture and verify acoustic continuity.
- Helper message-thread control timer is now event-driven: `runCommandWorker`
  dispatches `callAsync` to trigger immediate evaluation on the message thread
  upon `signalControlWake()`, eliminating editor command latency (~0.1 ms vs 8 ms).
  The timer adapts dynamically between 8 ms (when an editor is open or a command
  is pending) and 50 ms (when completely idle), reducing idle wakeups by ~84%.
- Actual deadline misses, dropped inputs, dropped controls, and rejected MIDI counters
  are now aggregated across isolated plug-in child helpers by PluginProcessorBank,
  published in SystemHealthSnapshot, forwarded over WebServer telemetry (WHealthTelemetry),
  merged into WebUiState, and displayed in HealthSettingsTab with real-time operator alerts
  for missed deadlines. Bounded IPC copies are preserved.
- Changed-latency PDC refill continuity is an explicit residual acoustic task;
  unsafe concurrent history copying is not an acceptable solution.

## Acceptance and measurements

Build optimized `RelWithDebInfo` with bounded job count (`-j2` on this 8 GiB Mac).
Run full native suite idle after builds, report vendor fixture skips honestly.
Record callback p50/p95/p99/max, hardware underruns, helper miss rate/CPU, meter
silence, control overflow, PDC alignment and loop/seek recovery for saved-state
AU/VST3 projects at 64/128/256/512 frames. Unit/synthetic microbenchmarks are not
proof of heavy-vendor acoustic stability. Use recent projects only without
overwriting them or changing the user's saved rig settings.

No waiting, spinning, process I/O, vendor-state capture or allocation on the
device callback. Preserve immutable publication epochs/layouts, helper reuse,
bounded restart, MIDI/live voice ownership, tails and dry/silence fallback.
