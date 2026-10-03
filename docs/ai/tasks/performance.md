# Indexed plug-in activity and heavy-project acceptance

Status: current follow-up, 2026-10-02. Read [audit.md](audit.md) first. Earlier cross-thread power/bypass mailbox
work is implemented and preserved in [the power architecture](../../architecture/PLUGIN_POWER_MANAGEMENT.md)
and [dated benchmark evidence](../../performance/PLUGIN_BASELINE.md).

## Added requirements — 2026-10-03

The following are open requirements, not verified features. Update this file
after each implementation block with the exact source/test evidence and any
unverified platform or acoustic scope.

### Per-instance load, editor, and offline render readiness

- Reproduce the writetest report from a private copy/read-only inspection:
  several slots fail to load, then reopening one slot appears to reopen all.
  Find whether this is shared bank generation, helper-per-chain restart, shared
  host state restore, a UI loading snapshot, or an editor request side effect.
  Opening/retrying one slot must affect only that chain/slot unless a real
  shared process/session failure is detected. Do not kill/recreate healthy
  helpers as the repair strategy.
- Audit slot identity across track/bus/plugin reorder, duplicate slot IDs,
  Undo/Redo, Save/Open, sample-rate change, project epoch and rapid repeated
  retry. Late helper replies from an old generation must never publish as the
  new slot. A failed/missing/loading instance must not be styled as active.
- Offline rendering must not enter a track before its private vendor processor
  has been constructed, prepared at the render sample rate/block size, marked
  non-realtime before prepare, and restored from its exact saved state.
  Implemented 2026-10-03 (fail-closed subset): `MainComponentRender.cpp`
  synchronously builds a private bank before `OfflineRenderer` enters its first
  block, then requires every non-bypassed main/click/track/bus slot to report
  `loaded`. Any missing/loading/failed slot aborts the render before output is
  written and names up to twelve owner/plug-in/load-state failures. Deliberate
  bypass does not block rendering. The private offline bank remains separate
  from live instances. This does not yet provide a bounded deadline for vendor
  construction/state restore, process isolation, cancellation during that
  synchronous setup, or proof that a successfully prepared vendor has emitted
  audible output on its first block; those remain open. Do not silently render
  startup silence while readiness is known to have failed.
- Test multi-chain restore order, delayed instruments, effect tails, one broken
  state blob, timeout, cancellation, project switch during load, and offline
  processBlock notification semantics. A focused `OfflineRenderer` regression
  proves a factory readiness failure does not create an output file. It does
  not exercise real AU/VST3 loading. Track render startup latency and ensure a
  slow plugin cannot hold the UI or live callback.

### Plugin UI and graph integration

- Every plugin editor/slot needs an explicit On/Off (bypass) control and
  per-plugin preset save/load. The command targets a stable project/slot ID,
  carries the project epoch, and changes only the intended instance. Bypass
  must be represented through the plugin-host ABI/process context as plugin
  bypass (the vendor receives the appropriate bypass state); do not implement
  it as track mute or destructive removal. Stale editor controls close or
  rebind visibly when their slot is replaced.
- Presets are per exact plug-in slot and portable project resources; define
  whether the operation is project-slot state or a user preset-library state
  before storing data. Validate identity, byte size, format and restore result;
  atomic save, duplicate names, missing plugin, failed restore, undo, project
  clone, and concurrent Save/Render all need explicit behavior. Never capture
  vendor state on the audio callback.
- Add real sidechain routing through track/bus source selection to a compatible
  plugin auxiliary input bus, across project schema, graph construction,
  plug-in host shared-memory ABI, AU/VST3 bus activation, offline render, save/
  reopen and UI. Define mono/stereo channel mapping, feedback/cycle rejection,
  latency/PDC, mute/solo, source deletion, duplicate sends, missing/disabled
  plugin buses, bypass, hot edits during playback and sidechain-free legacy
  project migration. Graph preparation and helper audio exchange remain bounded;
  never allocate or wait in the callback. Sidechain data is a distinct signal
  edge, not an ordinary post-summed insert input or a UI-only label.
- The current Audio Flow graph is in Settings > Audio. Extend that same graph
  so sidechain edges and plugin auxiliary-input endpoints are visible with a
  distinct theme-aware line style and label. See [audio-flow.md](audio-flow.md)
  for mixer bus graph buttons, focused/full-tree views and routing-layout
  acceptance.

### Shared peak/clip state and eased live values

- Implemented 2026-10-03: channelClipHold.ts owns one bounded retained latch
  keyed by Core origin/session/project epoch and stable strip ID. The live
  telemetry decoder feeds it, useChannelClipHold exposes the shared snapshot,
  Mixer controls reset it, and Timeline's MeterFader reads the same clip flag.
  State survives a view unmount/remount, is isolated across project epochs,
  ignores impossible peaks, and is cleared when live telemetry resets. Active
  entries are capped at 8,192; under impossible saturation of that many
  simultaneously subscribed strips a new latch is deliberately not admitted.
- Remaining: verify Inspector and every bus/main meter identity in integration,
  expose the held value consistently in Timeline, and exercise reconnect and
  remote Core switches in a multi-surface UI test. Unit tests cover shared
  subscribers, unmount/remount retention, reset, epoch isolation, invalid
  values and track/bus telemetry ingestion.
- Reset is a shared UI-latch clear for the unique strip, not an engine command
  and not a mutation of Core's raw peak telemetry. A new peak above 0 dBFS in
  the next telemetry frame re-latches it. Do not add per-view reset state or
  imply that this clears Core's audio history.
  On strip deletion, ID reuse after project replacement, Core reconnect, or
  meter row reorder, old holds must not leak into another strip. Bus/main
  meter identities follow the same rule where their controls share a display.
- Faders and all continuously displayed automatable values should interpolate
  smoothly between fresh authoritative telemetry samples. This is display
  smoothing only: do not feed eased values back to Core, delay direct manual
  response, alter audio coefficient smoothing, or animate through stale samples
  and target changes. Pointer gesture values win until release/rejection; then
  snap or ease to the latest accepted Core value. Respect reduced motion and
  avoid a React rerender of whole strips per meter frame.
- Test same-strip values and peak reset in Timeline/Inspector/Mixer simultaneously,
  track switching with reused components, remote Core/session changes, delayed
  and reordered telemetry, disconnected/stale telemetry, clipping on either
  channel, and reset while audio remains hot. Verify stable output values and
  frame cost with many strips; audio-meter needles keep their dedicated
  ballistics rather than generic scalar easing.

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
