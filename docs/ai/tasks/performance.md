# Indexed plug-in activity and heavy-project acceptance

Status: current follow-up, 2026-10-02. Read [audit.md](audit.md) first. Earlier cross-thread power/bypass mailbox
work is implemented and preserved in [the power architecture](../../architecture/PLUGIN_POWER_MANAGEMENT.md)
and [dated benchmark evidence](../../performance/PLUGIN_BASELINE.md).

## Added requirements — 2026-10-03

The following are open requirements, not verified features. Update this file
after each implementation block with the exact source/test evidence and any
unverified platform or acoustic scope.

### Editor target identity hardening — 2026-10-03

The Core-side native editor registry and `PluginProcessorBank` editor
create/open/close operations now resolve by the pair `(stripId, slotId)`. The
previous bank API searched slot IDs across all strip chains, and the local
window registry also keyed only on `slotId`; a legacy/imported project with
duplicate slot IDs in different strips could therefore target the wrong
editor. The isolated helper already owns one serial strip chain and continues
to address its editor by chain-local slot index. No processor chain is
restarted by opening or closing an editor.

Verification: the optimized Core and `resostage_plugin_host` built, followed
by the complete native CTest target passing. This is a source-level identity
fix; the fixture suite does not construct two vendor editors with deliberately
duplicated slot IDs. It does not reproduce the reported writetest reload
coupling or prove AU/VST3 editor independence. Keep the private saved-project
reproduction, vendor windows, rapid retry, and helper restart-count checks
open.

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

- Implemented 2026-10-03 subset: isolated and in-process plug-in editor
  windows now have a Bypass toggle. Isolated editors send a bounded,
  per-slot latest-wins intent over shared-memory ABI v9; the intent carries
  the exact bypass-state token displayed by the editor. Core's message-thread
  poll ignores stale tokens and routes accepted requests through the same
  project-history edit as the Mixer, then publishes the state token back to
  the helper. The helper never changes DSP/project state from its UI thread.
  The existing proxy-bank bypass path reaches JUCE's `processBlockBypassed`
  in the vendor host and does not rebuild a healthy instance. The local editor
  fallback uses the same project mutation and refuses stale bank identity.
  Focused protocol tests cover initial state, repeated polling, latest-wins
  clicks, stale-token rejection and bounds. The dedicated test passed 17
  assertions; Core/helper builds and the complete native CTest target passed.
  Real vendor-window visual and acoustic acceptance is still required.
- Remaining: define and implement per-plugin preset save/load. Decide whether
  each operation changes a slot's project state or writes a user preset
  library before choosing persistence. Validate identity, byte size, format
  and restore result; atomic save, duplicate names, missing plugin, failed
  restore, undo, project clone, and concurrent Save/Render need explicit
  behavior. Never capture vendor state on the audio callback.
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

- Implemented 2026-10-03: channelClipHold.ts owns bounded stereo peak maxima and
  the clip latch keyed by Core origin/session/project epoch and stable strip
  ID. Live telemetry feeds it once; Timeline's combined fader-meter, compact
  track-header meter, Inspector strip and Mixer strip sample the same retained
  per-channel marker without a React render on each peak increase. The peak
  readout samples the same store on the shared UI frame loop. Clearing a strip
  resets both channels and the clip latch for every mounted view. State
  survives view unmount/remount, is isolated across project epochs, ignores
  non-finite/impossible peaks, and clears when live telemetry resets. Active
  entries remain capped at 8,192; if every retained identity is subscribed, a
  new identity is deliberately not admitted.
- Remaining: integration-test Inspector plus every bus/main identity, track
  switching with reused components, and reconnect/remote Core changes together.
  Unit tests cover shared subscribers, unmount/remount retention, reset, epoch
  isolation, per-channel maxima, clip transitions, invalid data, and telemetry
  ingestion. Focused tests passed 22/22; full UI passed 850 tests / 129 files;
  TypeScript and production build passed. Repository lint had 12 existing
  warnings in unrelated files and none in changed files. No device/remote
  visual acceptance is claimed.
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
- Implemented 2026-10-03 subset: Core publishes graph-evaluated gain/pan as
  separate optional per-view values for track, click, main and aux strips. The
  evaluator skips manually owned lanes and visits only prepared gain/pan
  bindings. Timeline, Mixer and the shared Inspector strip controls display
  them with reduced-motion-aware transitions while retaining
  manual/optimistic values as edit and Esc-cancel baselines. This uses existing
  JSON view state, not UDP meter frames, and never writes interpolated values
  back to Core. Automated send levels were added in the subsequent per-edge
  block below. Hosted-plugin parameter value surfaces and device/remote
  acceptance remain open; do not report all automatable displays as complete.
- Implemented 2026-10-03 follow-up: Timeline and Mixer numeric gain/pan labels
  now use the shared `EasedReadout` UI component. It writes text through one
  rAF-owned DOM node rather than triggering per-frame React renders, shares the
  existing UI frame driver, registers frame work only during active easing,
  removes the task on completion, bypasses interpolation during direct
  gestures and reduced motion, and snaps on a
  Core-session/project-epoch/song-index key change. It never writes a
  displayed/interpolated value back to Core.
  Verification: UI Vitest passed 853 tests / 130 files, `tsc -b` and
  production build passed, lint had zero errors and 12 existing unrelated
  warnings, and `git diff --check` passed. A later Inspector identity test
  verifies that the selected row's automation fields are forwarded through its
  shared strip path; automated-send values are covered by the per-edge block
  above. A multi-strip frame-cost benchmark, hosted plug-in parameter controls,
  mounted Inspector visual acceptance and remote-device acceptance remain open.
- Test same-strip values and peak reset in Timeline/Inspector/Mixer simultaneously,
  track switching with reused components, remote Core/session changes, delayed
  and reordered telemetry, disconnected/stale telemetry, clipping on either
  channel, and reset while audio remains hot. Verify stable output values and
  frame cost with many strips; audio-meter needles keep their dedicated
  ballistics rather than generic scalar easing.

### Shared rotary reset and MIDI CC Learn — implemented subset (2026-10-03)

`ui/src/components/daw/RotaryControlMenu.tsx` provides the common context menu
for app-owned rotary controls. Track, bus, master and click pan plus track/click
send amount expose Reset to Default, MIDI CC Learn and Clear MIDI Binding while
retaining their screen-specific pan-law and send-routing actions. Pan resets to
center; sends reset to their declared schema default (100%/unity). Reset still
uses the control's regular edit callback, not a display-only local override.

`rotaryMidiTarget.ts` constructs only typed continuous targets. Core's action
catalogue rejects empty/malformed target identities and continues excluding
structural/navigation/note-edit actions. CC handlers are consistent across
CoreMIDI, WinMM and ALSA. Continuous controls only learn Control Change; an
incompatible Note-On leaves learn armed. Track and bus IDs resolve after
reordering, with numeric `track_pan` indices retained for backward compatibility.

Tests: focused rotary UI tests 5/5; full UI suite 813/813 (122 files); UI
TypeScript build passed; lint exited 0 with 12 existing unrelated warnings;
Core build passed and full native suite passed 589/589 (428,716 assertions);
diff check passed. No hardware MIDI test was run. Important limit: MIDI mappings
are rig-wide `AppSettings`; IDs can recur in separate projects, so the new
targets are stable across reordering but are not yet project/song scoped.
Future rotary families must opt in through an explicit safe target factory and
carry the parameter's real reset default; vendor plug-in GUI controls are
outside this app-owned menu.

Earlier validation snapshots passed the Core build and focused/full regressions.
The current audit passed UI 706/Electron 39; its first native run passed 563/566.
An isolated AU rerun passed 67 assertions. Diagnose integrated failures and
publication ordering before declaring completion. None of these totals is
heavy-vendor acoustic acceptance or whole-callback allocation proof.
After audit fixes, the final native suite passed 572 cases/424,285 assertions
and both AU editor cases; final UI passed 724 tests/105 files. See the audit
for actual fixes and the still-open live publication/ownership contract.

## Current correctness/performance pass

### Retry/rebuild audit — scoped implementation, vendor proof still open (2026-10-03)

`AudioEngine::retryPluginSlot(slotId, stripId)` validates both identities in
the current project and captures a retry scope only when the published bank
matches project epoch, processor layout, sample rate, block size and pipeline
latency. Otherwise it performs the necessary full reconcile. A scoped request
counts and publishes progress/failures only for that strip. The selected strip
is one isolated serial chain, so every insert in that chain is reconstructed;
before doing so, Core snapshots that helper's current state and restores
available live state into the replacement, falling back to the saved project
resource if the host is already dead or capture fails. Snapshot-capture warnings
go to diagnostics and do not falsely classify successfully loaded plug-ins as
failed. Other matching chains retain their existing node objects and shared
helper, even if they are already degraded; they are neither reopened nor
snapshotted. Callback-owned MIDI activity remains shared instead of being read
from the builder thread. Transport is refreshed on the next audio callback.

Automatic dead-host restart remains bounded to once per strip/project epoch.
When several helpers fail, Core waits for the current bank build to settle
before scheduling the next one, avoiding latest-wins cancellation races. Exact
strip+slot load-state checks avoid ambiguous IDs in legacy projects. A project
switch or structural rebuild supersedes the scoped request through the existing
generation/epoch fence.

Verification: optimized `ResoStage` and `resostage_engine_tests` built;
`ctest --test-dir core/build --output-on-failure` passed; pure tests cover exact
stable-strip matching and scoped two-slot progress; actual Core
`scripts/verification/editor-state.mjs` passed its complete state/transport/
history/save/reopen suite. The actual-Core fixture contains no vendor plug-ins,
so none of these results proves an AU/VST3 process was preserved or that its
audio/editor remained uninterrupted. Still obtain a private-copy writetest
reproduction, helper launch/reuse counters, two failed chains, two failed slots
in one chain, rapid retries, superseding project replacement and real AU/VST3
state/audibility acceptance. Never mutate the Recent project for the test.

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

## Telemetry-driven control easing — implemented subset (2026-10-03)

Timeline meter-fader handles, Mixer gain-fader fill/caps, shared pan knobs, and
Mixer send arcs now use one CSS-only ease-out policy (`controlMotion.ts`) for
externally observed value movement. During a pointer gesture they switch to
`transition: none`, so the local control remains attached to the hand. The
motion preference is checked at render time and reduced-motion users get no
interpolation. This adds no React animation loop, telemetry-to-Core feedback,
or audio-callback work.

Focused control-value tests passed 9/9; full UI passed 847 tests across 129
files; UI TypeScript and production build passed; changed-file lint and
`git diff --check` passed. This smooths painted fader/knob geometry only;
numeric readout text is still updated at telemetry cadence, and Inspector or
hosted plug-in parameter controls are not yet covered. No hardware or remote
telemetry run was performed.
