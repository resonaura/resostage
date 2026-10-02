# Indexed plug-in activity and heavy-project acceptance

Status: current follow-up, 2026-10-01. Earlier cross-thread power/bypass mailbox
work is implemented and preserved in [the power architecture](../../architecture/PLUGIN_POWER_MANAGEMENT.md)
and [dated benchmark evidence](../../performance/PLUGIN_BASELINE.md).

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

- Forward actual arm/monitor guard changes to helper DSP if semantics require
  keeping silent monitored instruments awake. Existing setters have no normal
  production callers; a proxy-only flag is not vendor power ownership.
- State capture skips node execution while the vendor serializes. Test note-off,
  sustain release, panic and dense MIDI during long state capture; retain them
  through a bounded node-owned queue rather than dropping them or allocating.
- Helper message-thread control timer wakes at 8 ms even idle. Replace polling
  only with a verified event-driven/coalesced edge that preserves editor,
  parameter/state and latency-response time. Merely slowing it increases delay.
- Surface actual deadline misses/control/MIDI rejection counters and realistic
  recovery behavior. Don't remove meaningful bounded IPC copies speculatively.
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
