# Indexed plug-in activity and heavy-project acceptance

Status: current follow-up, 2026-10-02. Read [audit.md](audit.md) first. Earlier cross-thread power/bypass mailbox
work is implemented and preserved in [the power architecture](../../architecture/PLUGIN_POWER_MANAGEMENT.md)
and [dated benchmark evidence](../../performance/PLUGIN_BASELINE.md).

Earlier validation snapshots passed the Core build and focused/full regressions.
The current audit passed UI 706/Electron 39; its first native run passed 563/566.
An isolated AU rerun passed 67 assertions. Diagnose integrated failures and
publication ordering before declaring completion. None of these totals is
heavy-vendor acoustic acceptance or whole-callback allocation proof.
After audit fixes, the final native suite passed 572 cases/424,285 assertions
and both AU editor cases; final UI passed 724 tests/105 files. See the audit
for actual fixes and the still-open live publication/ownership contract.

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
  overflow, helper load/render tests passed (1,995 assertions). Dense sustain-release/panic
  traffic during deferred MIDI state capture is covered by the dense queue test
  in `test_plugin_host_protocol.cpp` (582 assertions): validates interleaved multi-channel
  pedal (CC 64), pitch bend, and notes, verified overflow degradation to 48-event 16-channel
  panic (AllSoundOff, ResetControllers, CenterPitch), and clean post-recovery note handling.
  It does not process vendor audio; acoustic continuity still needs a real helper test.
- Helper message-thread control timer is now event-driven: `runCommandWorker`
  dispatches `callAsync` to trigger immediate evaluation on the message thread
  upon `signalControlWake()`, avoiding dependence on the periodic timer for control dispatch.
  The timer adapts dynamically between 8 ms (when an editor is open or a command
  is pending) and 50 ms (when completely idle). These are scheduling policies,
  not measured whole-application latency/idle-CPU guarantees.
- Actual deadline misses, dropped inputs, dropped controls, and rejected MIDI counters
  are now aggregated across isolated plug-in child helpers by PluginProcessorBank,
  published in SystemHealthSnapshot, forwarded over WebServer telemetry (WHealthTelemetry),
  merged into WebUiState, and displayed in HealthSettingsTab with real-time operator alerts
  for missed deadlines. Bounded IPC copies are preserved.
- Changed-latency PDC refill continuity is verified by `Dynamic PDC changed-latency refill continuity and alignment during active rendering`
  in `test_plugin_performance.cpp` across all standard hardware block sizes (64, 128, 256, 512 frames):
  no detected ordinary C++ allocations in the synthetic render section across
  latency transitions (64 -> 128 samples). Audit commit `695df99` additionally
  asserts the first 128 samples are zero and every following sample has the
  expected delayed phase. This bounds the synthetic refill transient, not
  device/helper scheduling or a heavy vendor's output continuity.
- Varying renderer-block continuity is covered by `MixRenderer varying block sizes (64, 128, 256, 512 frames) with PDC maintain probed zero allocations and phase continuity`
  in `test_plugin_performance.cpp`: verifies zero heap allocations across varying hardware buffer sizes (cycling 64, 128, 256, 512, 64, 256...),
  zero NaN/Inf, and sample-accurate phase continuity across non-uniform renderer
  block boundaries. This is not physical device reconfiguration acceptance;
  the allocation probe is disabled on MSVC and does not cover all allocators.

## Acceptance and measurements

User requirement added2026-10-01: edits must be supported during active playback,
including MIDI notes/regions, automation and supported controls. Prepare work
off audio; publish complete compatible snapshots without Stop/Play, clock reset,
transport seek or healthy-helper restart. Acceptance must measure edit latency,
callback deadlines, held/live-note ownership and audible continuity while drawing,
deleting, quantizing and undoing edits under a dense project/cycle. Saving correctly
while stopped does not satisfy this requirement.

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
