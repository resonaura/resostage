# Arrangement automation: verified state and remaining work

Updated 2026-10-03. Read [audit.md](audit.md), [handoff.md](handoff.md), complete `AGENTS.md` and
[automation model](../../architecture/AUTOMATION_MODEL.md). This task remains open.

## Audit findings

## Added requirements — 2026-10-03

### Implemented subset — project-persisted target-swap curve cache (2026-10-03)

Core format v11 stores detached curves on their owning `SongDef`. A
track-scope lane target swap validates the destination before history starts,
stashes the old curve, then restores a compatible cached curve for the new
target (or leaves the lane empty) in the same `ProjectHistory` transaction.
Returning to a previously-used target restores the original points and curve
shape. Adding a track-scope lane also restores a cached curve. Cache identity is
song + automation scope + domain + entity + parameter + value type; range
compatibility is checked before restore. Bounds are 128 cached targets and
65,536 total points per song; oldest entries are evicted deterministically.
Older projects default to an empty cache; `scripts/migrate.mjs` now emits v11.

Rebind destinations currently cover loaded/automatable track plug-in
parameters, track gain/pan/mute, a unique enabled track send, and MIDI CC/pitch
bend on MIDI-capable tracks. Missing targets, unloaded/unbound plug-in
parameters, malformed ranges, duplicate bindings, and region-scope lanes reject
before the edit is accepted. No cache data is read by the audio callback.

Verification: native cache identity/restore/eviction/invalid-curve and JSON
round-trip regressions pass with the full native CTest target. Project migration
tests pass 2/2, including the v10-to-v11 empty default and preservation of
existing lane/cache data. The real-Core acceptance fixture now swaps a populated
fader lane to pan, confirms the uncached destination is empty, swaps back and
checks exact point/curve restoration while transport continues.

The rebind path copies/validates the outgoing curve and reserves bounded cache
capacity before beginning ProjectHistory. Once the transaction starts there is
no validation-driven early return. Cache insertion and target replacement are
part of the same history snapshot.

The actual-Core fixture also saves a detached fader curve, starts a fresh Core
process on the same temporary project, and rebinds the lane to restore every
point and curve value. It confirms that save/reopen preserves dormant curve
data, not just the active lane.

This began as backend/schema coverage. The multi-lane Timeline UI now has
independent foldable pseudo-track rows and shared geometry; see the later
2026-10-03 implementation section. Browser/Core history and package
save/reopen acceptance, plugin metadata churn, and multi-song target mapping
remain open, so do not call the full multi-automation workflow complete.

### Implemented subset — target selector rebinds its current lane (2026-10-03)

The Timeline automation parameter selector now updates the target of the
currently selected persisted lane through the reliable
`automationLaneUpdate({ laneId, target })` history path. It no longer silently
switches to another existing lane or creates a temporary preview when a lane
already exists. Core's project-persisted target cache therefore detaches and
restores the previous curve on the same edit. When no lane exists yet, choosing
a target remains a non-editable effective-value preview; only `+` creates the
empty lane. Generated Core lane IDs are resolved from the selected target after
the authoritative echo. Rejected target changes remain on the existing lane
and show the command error.

Focused `AutomationTrackControls` tests passed 14/14; full UI passed 849 tests
across 129 files; `tsc -b`, production UI build, changed-file oxlint and
`git diff --check` passed. This fixes the lane-target behavior used by the
foldable pseudo-track UI below. At that point independent rows, stable collapse
state, row geometry and UI save/reopen acceptance were still open; the first
three now have a tested UI implementation, while browser/Core save/reopen
acceptance remains open.

The remaining automation/control requirements below preserve the existing lane
API/history path unless the model audit demonstrates a required
persisted-schema change. Each subsection states its implementation status and
evidence explicitly.

### Implemented subset — independent foldable automation pseudo-tracks (2026-10-03)

Timeline now renders every track-scope automation lane in its own pseudo-track
row below the audio/MIDI region row. Each row has its own chevron/fold state,
target selector, enable/mute, write mode and remove action. The target selector
is pinned to that lane ID: rebinding one row uses the reliable lane update and
project-persisted detach/restore cache, never selects a sibling lane. `+` is
exposed once at the end of the list and only creates the next eligible target;
with no lanes, the base header selector is a read-only value preview until the
user explicitly adds a lane. Parameter descriptors are shared across sibling
rows so a large plug-in table is not rescanned once per lane control.

Expanded pseudo rows use a zoom-aware bounded height, while a collapsed row
keeps a compact control header and hides only its curve. Sidebar and body use
the same calculation. The same row-height vector is used by region drag target
resolution, audio file drop, region marquee hit tests and scroll-to-track, so a
pseudo row belongs to its parent track and does not shift region or gesture
coordinates independently. Region/MIDI content stays in the base lane; each
automation envelope is editable in its own row. Row insertion/removal and fold
geometry update together without an animated height that could temporarily
desynchronize pointer coordinates; the chevron and curve visibility animate.

Collapse state is UI-only, bounded to 4,096 collapsed IDs, owned by Timeline,
scoped to project name + project epoch + song + lane ID, reset when the project
identity changes, and retained across child remounts. It is deliberately not
project content; only detached automation curves are portable persisted data.
This avoids silently adding editor layout preferences to the project schema.

Verification on 2026-10-03: focused automation/row-geometry/drag/drop/marquee
tests passed 54/54; full UI Vitest passed 864 tests across 133 files; `tsc -b`
and the production UI build passed. Full lint exited 0 with 12 existing
warnings in unrelated files after removing two test-only warnings;
`git diff --check` passed. Tests prove two independent header rows, one add
action, collapsed geometry, lane-specific target updates, cumulative row
hit-testing, and parent-track drop/drag/marquee mapping.

Still open: manually inspect fold transitions in Electron; exercise two lanes
through real Core history Undo/Redo and saved-project reopen; test plug-in
descriptor load/failure/replacement while multiple rows are mounted; and prove
cross-song rows resolve the appropriate track/slot targets where per-song IDs
differ. When exact target identity is absent, the Timeline shows a non-editable
empty baseline rather than rendering an unrelated lane. Region-scope automation
is governed by its separate model/UI and is not made multi-row by this
track-scope change.

### Implemented subset — gain/pan automation reaches live controls (2026-10-03)

Core now publishes evaluated gain and pan for track, click, main, and aux
strips as separate optional values in the existing per-view state DTO. It uses
the same `AutomationEvaluator` and prepared `StripAutomationPlan` bindings as
rendering, skips Core-owned manual lane overrides, and publishes only when the
active `MixGraph` epoch/revision exactly matches the project snapshot. Manual
project values are never overwritten. `visitControlValues()` indexes at most
one gain/pan binding per strip and one send binding per edge, so a 60 Hz
publication is bounded by prepared graph strips/edges and does not scan mute
lanes. The graph snapshot is shared with signal-flow projection so the values
correspond to that exact graph.

Timeline track gain/pan and Mixer track/bus/click gain/pan controls use these
values for display only. Optimistic user edits take precedence; fader/rotary
gesture and Esc-cancel baselines remain the manual values. Short transitions
honor reduced motion. These values travel through the existing per-view JSON
state path, not the binary meter UDP frame, and are never sent back to Core.

Still open: Inspector and hosted-plugin parameter controls, end-to-end
Touch/Latch/Write ownership on all surfaces, and visual/remote-session playback
acceptance. This does not complete all control-display requirements in this
document.

Verification on 2026-10-03: `ResoStage` and `resostage_engine_tests` built;
focused native automation telemetry passed 1 case / 19 assertions; the full
native suite passed 590 cases / 428,735 assertions and CTest passed 1/1. Focused
UI control/cancellation tests passed 10/10; the full UI suite passed 821 tests
across 124 files; UI TypeScript passed; lint exited 0 with 12 existing warnings
and none in changed files; `git diff --check` passed. No hardware/remote/vendor
playback test was run.

### Implemented subset — automation display on aux-send controls (2026-10-03)

The prepared `StripAutomationPlan` indexes each winning send automation lane
by its resolved graph edge. When the active graph epoch and history revision
match the project, Core projects the evaluated normalized value onto the
matching track/click output send as a distinct optional `automatedLevel` in
0..100 linear percent. It verifies source strip, edge slot, destination bus
and enabled state before publishing. This is per-view JSON state, not persisted
routing and not binary UDP meter telemetry.

Mixer send arcs display Core's evaluated amount and tooltip while retaining the
manual value as the control's write and Esc-cancel baseline. An edit suppresses
only its Core-owned automation lane, after which the manual value is shown.
Missing, disabled or stale edges do not redirect a lane to another send.

Verification on 2026-10-03: Core application and native test targets built;
the focused native automation-observation case passed 1 case / 29 assertions;
full CTest passed 1/1 and the direct native suite passed 590 cases / 428,745
assertions. Focused UI automation control tests passed 8/8; full UI passed 823
tests across 124 files; TypeScript passed; lint exited 0 with the existing 12
warnings and none in changed files; `git diff --check` passed. No live audio
device, remote Core or vendor plug-in playback was exercised.

### Automation lanes and the actual controls

- Automation playback must be visible on the relevant controls, not only as a
  curve in the timeline: track/bus gain faders, pan controls, sends, and
  supported hosted-plugin parameters should display the Core-evaluated value
  for the exact strip/slot/parameter and active song. Timeline, Mixer,
  Inspector, and plug-in UI must resolve the same stable target identity and
  not retain a prior track's value after selection changes.
- The displayed fader/knob position is an observation of the latest
  authoritative value, not a new source of automation. Preserve an in-progress
  manual gesture, Touch/Latch/Write ownership, safe return-to-automation
  behavior, and command rejection. Never ease stale telemetry through a live
  manual gesture or across song/project/Core epoch changes.
- `+` adds one independent automation pseudo-track (one existing
  `AutomationLane` entity) for the currently chosen target. Each pseudo-track
  has its own target selector, enabled/mute/mode controls, curve and history;
  selecting an option on that row rebinds that row, it does not select another
  pseudo-track or silently create one. `+` is the only explicit creation
  action. Different automation lanes can coexist for one strip.
- Each pseudo-track has a left chevron and reduced-motion-aware expand/collapse
  transition. Collapsed state must have a defined owner/persistence policy,
  survive virtualized row remounts, and never desynchronize sidebar/body
  heights, marquee hit testing, region gestures, or vertical zoom. The lane's
  edit controls and visible envelope must share one row geometry.
- Changing a pseudo-track's target detaches the old envelope and binds the new
  one as a single reliable project-history operation. Keep the previous curve
  in a bounded project-persisted cache keyed by full project/song/scope/domain/
  entity/parameter identity. Returning to a cached target restores its curve;
  an uncached target starts empty and displays its non-editable effective-value
  baseline. Cache eviction, duplicate target bindings, deletion, undo/redo,
  copied projects, missing plugin parameters, and schema migration must be
  deterministic. The cache is project content (portable across computers),
  not localStorage and not a UI-only draft. Reject before opening history if
  size/point limits or target validation fail. A plugin slot or parameter ID
  that later disappears must remain recoverable as detached data, not be
  silently discarded.
- Parameter choice must be validated against the current complete descriptor
  table. Loading, failed, missing, truncated, and genuinely unbound metadata
  remain different states. Plugin replacement or project epoch changes fence
  late selector responses and drafts.
- All rotary controls share an RMB context-menu affordance for Reset to
  Default and (when safe) MIDI Learn. Reset uses the parameter's declared
  default and normal reliable command path, including units, range, detent,
  optimistic gesture cancellation and automation recording semantics. Do not
  hard-code zero for plugin parameters.
- MIDI Learn eligibility is explicit metadata on the control/action
  catalogue, not inferred from being numeric. Eligible: continuous,
  reversible, bounded controls such as gain, pan, send level and a plugin's
  automatable continuous parameter. Exclude navigation, octave/transpose
  commands, destructive/structural actions, and controls with unsafe discrete
  side effects. Bind through the existing typed MIDI mapping flow; cancel,
  conflict, device/channel changes, and unbind must be visible and tested.

### MIDI controller-event overlays

- Existing partial support to preserve: `MidiRegionBlock` now derives bounded
  CC event markers and held spans for CC64–69, including channel state,
  trimmed-loop source mapping, and initial-held/missing-release cases. Arbitrary
  CC remains labeled by its number, not as Sustain. Piano Roll now offers
  distinct lanes for CC64–69. Core live recording now captures
  CC64–69 and publishes recent events plus still-held onset edges through the
  bounded MIDI preview frame and `WLiveRecordingRegion`; mounted UI views merge
  those IDs across latest-wins snapshots. The callback event history is capped
  at 4,096 events per recording session and the shared preview frame at 512 CC
  events, so overload/reattach completeness still needs explicit coverage.
- Render MIDI controller events (including sustain CC64 and other pedals) as a
  compact, non-obscuring overlay in both MIDI region previews and the Piano
  Roll/controller lane. Use explicit on/off state transitions, preserve event
  channel and source beat, and show a held span between state changes where a
  range view is more legible. Handle an initial down event before the clip,
  missing off events, loop source windows, trim/split, mute, take/record
  previews, zoom, overlapping channels, and all supported controller numbers;
  do not label arbitrary CC as Sustain.
- The overlay is derived from persisted MIDI CC events and active recording
  capture data. It must not invent notes or events, mutate playback, block note
  selection/drawing, or add an unbounded per-frame scan. Pre-index or bound the
  visible events and keep the preview consistent with MIDI export.
- Static region preview is implemented in
  `regions/logic/midiControllerPreview.ts`: scans at most 65,536 source events,
  expands at most 10,000 visible loop events, and collapses controller markers
  into at most 1,200 pixel bins. CC64–69 held spans are separate one-pixel
  track-color overlays; other CC events show compact value markers/tooltips.
  Switch state uses MIDI's off=0/on=nonzero rule. This only covers persisted
  regions; incomplete scans expose a display-limited hint and suppress held
  spans so a truncated release cannot imply a false pedal-down state. Live
  capture currently supports CC64–69 only; do not imply every arbitrary CC is
  recorded live or that the Piano Roll supports arbitrary CC lanes.
- Apple documents CC64 as sustain, its switch off/on values, and that the Piano
  Roll Automation/MIDI area can display region MIDI controller data; the Score
  Editor can render sustain pedal markings from CC64. Treat the overlay here as
  a compact DAW visualization, not as a claim that the Piano Roll uses Score
  Editor symbols. Sources: [Control change events](https://support.apple.com/guide/logicpro/control-change-events-lgcp2158ecea/10.7/mac/11.0),
  [Automation/MIDI area in Piano Roll](https://support.apple.com/guide/logicpro/automationmidi-area-in-the-piano-roll-editor-lgcpa90a61bf/mac),
  [Sustain pedal markers](https://support.apple.com/en-lamr/guide/logicpro/lgcp85358d26/mac).

### Acceptance for this addition

- UI tests prove two independent pseudo-tracks can coexist, target switching
  caches/restores exact curves, new targets start empty, and rapid target or
  project changes cannot publish stale state. Native tests prove one atomic
  history entry and exact undo/redo/save/reopen semantics for target swaps and
  cache bounds/migration.
- Browser/device inspection proves automated values reach matching Timeline,
  Mixer, Inspector and plugin controls without jumping during manual gestures,
  song switches, stale UDP, or remote Core changes. Reduced-motion and compact
  vertical zoom preserve geometry.
- MIDI overlay tests cover CC64 down/up, arbitrary CC, sustain state spanning
  view/loop boundaries, split/trim, live recording preview and stable selection
  gestures. No persistence or playback mutation is caused by merely showing it.

### Implemented subset — persisted MIDI-region CC preview (2026-10-03)

`MidiRegionBlock` now uses a memoized bounded controller-preview model. It
renders a compact track-colored event tick per occupied pixel bin, tooltip
metadata for controller/channel/value ranges, and distinct held spans for
standard pedal controls CC64–69. Region trims and loop phases use the shared
`midiRegionTiming` source mapping. Controller data is read-only and does not
change playback or selection handling. UI tests verify track tint, tooltips, and
normal region pointer selection. Piano Roll now offers individual lanes for
the six standard switch pedals; arbitrary CC lanes remain open. Live capture is
tracked in the following block.

Focused checks passed 11/11 across controller preview, region component, and
shared region-timing tests. Full UI passed 836 tests across 127 files;
`tsc -b` passed; lint exited 0 with 12 existing warnings, none in changed
files. No device or manual visual inspection was performed. Live recording
telemetry and Piano Roll CC lanes remain open.


Previous arrangement UI existed, but had significant functional gaps:
- Raw buttons/selects, hardcoded write-mode colors, abrupt display transitions.
- Sidebar added28 px without adding the same body lane height.
- Empty fallback lanes fabricated two gain points; creation invented a first
  point even when no automation was drawn.
- Parent marquee competed with automation pointer gestures.
- Negative pixel deltas were clamped, selected groups collapsed on click.
- Long JSON edits exceeded the server4096-byte cap; frontend swallowed rejection.
- Plugin picker invented generic Param1 instead of actual vendor metadata.
- Strip gain/pan/mute/send lanes were persisted but not dispatched by production
  live/offline code. Touch/Latch/Write enums/primitives were not integrated recording.

## Implemented foundations (verify latest commits)

`424e4f4`, `f436040`, `f747399`, `918ca4b`, `9f63e0b`, `250d59f`, `a15c648`, `1739b29`, `9bf4652`, `ba9cb39`, `b04353b`, `de27854`, `7808523`, `aa44fac`, `1577c11`, `c60cc68`, `e3a4da2`, `2683dc2`, `c595b4b` implement:
- Zero-allocation strip fader, pan, mute, and aux send automation in `MixRenderer` and `OfflineRenderer`
  via `StripAutomationPlan.h/.cpp` with 562 native tests passing (332,647 assertions)
- Dynamic PDC changed-latency refill continuity verified under continuous audio rendering with zero allocations
- Safe declicked mute automation (downstream of console meters, 10 ms audibility ramping)
  and edge-slot aux send automation bindings
- Direct numerical point editing (Return/Enter shortcut, "Set exact value…" context menu option,
  double-click on point, floating input popover with unit display and boundary clamping)
- Complete Copy, Cut, Paste, and Duplicate workflows for automation points:
  `automationClipboard.ts`, `automationEditing.ts` (`copySelectedAutomationPoints`, `pasteAutomationClipboard`, `duplicateAutomationSelection`),
  `useAutomationDrag.ts`, `useAutomationKeyboard.ts` (`Mod+C`, `Mod+X`, `Mod+V`, `Mod+D` shortcuts),
  `AutomationLaneOverlay.tsx` (Copy, Cut, Paste, Duplicate context menu actions, click-based paste targeting,
  automatic relative beat offset normalization, grid step alignment, and boundary clamping)
- Next-unautomated lane addition on + click with bullet indicators (`•`) on automated parameters in selector
- Touch, Latch, and Write manual-control recording foundations:
  `AutomationTouchController.ts` and `useAutomationTouchRecorder.ts` wired to `TrackHeaderControl`,
  `TrackGainControl`, `TrackPanControl`, `MeterFader`, `Knob`, and `useKnobDrag`.
  Includes local point collection, return-ramp calculation (`evaluateAutomationAt`),
  transport-stop punch-out and Write->Touch safety revert. The audited call site
  is still TimelineSidebar only. The hook now requires Core-session/project-epoch
  identity before starting a pass, cancels on song/project identity transition, uses
  the song TempoMap, observes playhead updates for best-effort cycle splitting,
  continues held Latch passes on retouch, retains the last actual release value,
  coalesces same-beat samples, and caps each gesture at 65,536 samples with
  endpoint-preserving compaction. The compacted marker is validated by Core and
  reported in its success status. A rejected/unknown reliable mutation raises
  the shared editor-command failure notification and is never blindly retried.
  A Core-owned transient manual lane override is now published with the
  immutable `MixGraph` for Timeline track gain/pan gestures. While that lane is
  owned, the callback skips its automation binding and leaves other lanes
  active. It is cleared on Stop, song change, and project replacement; it is
  not persisted or added to project history. This is only wired at the
  arrangement Sidebar and is not yet end-to-end audible/device proof. The
  telemetry-inferred cycle split cannot distinguish every seek or missed wrap.
  Rejected and unknown recording commits now retain a bounded recovery draft;
  only a definitely unsent or exactly rejected request can be explicitly
  retried, and unknown outcomes remain export-only. See the audit for exact
  capacity, storage and identity fences.
- Compact lane height density scaling (<= 32px), omitting curve handles, scaling breakpoint nodes,
  compact header/controls layout, and reduced-motion transitions
- Exclusive/cancellable gestures, full-point atomic replacement/empty creation,
  real vendor metadata/current values, stable vendor identities
- Shared HeroUI wrappers (`Select`, `Button`, `Tooltip`), DAW focus isolation (`tabIndex={-1}`)
- Piano Roll note draft retention until matching Core snapshot, snap quantize
- Translucent dashed baseline on empty lanes with no fake draggable nodes
- Project epoch guarding in `useMidiRegionEditorState` preventing stale snapshots
  and late creates from cross-contaminating reopened/switched projects
- Accessible typeahead search for automation parameter selector via `textValue`
- Bounded 128-slot immutable plug-in parameter descriptor cache keyed by Core
  project epoch/generation, slot, plug-in and load state. Live values are read
  separately through `GET /api/v1/plugins/slot/parameter-values`, which exposes
  the helper's published atomics without repeating descriptor serialization or
  invoking vendor code. The automation hook polls compact values only while the
  automation surface is visible, caps concurrency at four, retries loading
  slots at 250 ms, and preserves React snapshot identity when the values do not
  change. A project/generation/load-state transition invalidates old entries;
  stale asynchronous responses cannot publish into the new view.
- Real Core HTTP verification in `scripts/verification/editor-state.mjs` checks
  transport advancement while applying MIDI/lane edits, submitted Touch/Write
  gesture persistence/safety revert, active-playback and stopped-state Undo/Redo,
  rejected out-of-pass gesture atomicity, 413 and reopen.
  It does not drive React gestures or measure emitted audio/MIDI/vendor DSP.
- Final audit regression suites: 105 UI files/724 tests, Electron 39 tests,
  native 572 cases/424,285 assertions. Typechecks pass; lint has zero errors and
  12 existing warnings. These do not complete the open ownership/epoch contract.

## Detached plug-in lane recovery

The Editor timeline now surfaces plug-in automation lanes whose slot was
removed, whose plug-in failed/is missing, or whose parameter is absent from a
complete loaded descriptor table. It scans song, audio-region, and MIDI-region
lanes without assuming a track owner from the parameter target. Rebind options
come only from loaded automatable parameters; truncated/loading descriptor
tables remain unresolved rather than being called unbound. Recovery preserves
the curve and routes rebind/remove through the existing reliable automation
history commands. Core validates rebind targets before opening history and
rejects a stale or non-automatable destination without mutating the project.

Still required: inspect theme/geometry/read-only/empty-destination states and
verify a successful rebind against an actual hosted AU/VST3 parameter while
transport is active, then confirm undo/redo and save/reopen.

Verification on 2026-10-02: full UI suite 763 tests across 111 files, UI
TypeScript and production build passed, lint had zero errors with 12 existing
warnings, native CTest passed 584 cases / 428,677 assertions, and real-Core
`editor-state.mjs` confirmed absent-slot rebind rejection is atomic. Successful
live-vendor rebind and visual/device acceptance are not established.

## Finish in this order

1. Preserve implemented track-scope strip gain/pan/mute/send DSP and declicked
   audibility/edge modulation. Finish immutable note/automation publication and
   stable send identity, then prove actual live/offline output through edits.
2. Component/gesture tests and actual HTTP persistence/history acceptance are verified.
   Selected automation points delete with Delete/Backspace hotkey when focused, with
   pointer gestures isolated from parent arrangement marquee. Empty current-value
   baseline is translucent dashed and non-draggable. Parameter selection previews without
   calling `automationLaneAdd` until explicit + is clicked. Curves are preserved on edits.
3. Async metadata, MIDI, and point-edit drafts are guarded with project epoch
   (`${state.projectName}:${state.pluginLoading?.epoch ?? 0}`) and history navigation.
   Late creations and follow-up edits reject and discard on project change and Undo.
   Missing parameter IDs stay unbound with clear disabledReason banners. Manual
   touch sessions must gain the same epoch/late-completion protection; do not
   assume guarding the point editor also guards every recording path.
4. Visually verify light/dark themes, low/high vertical zoom, several songs, dense
   lanes, loading/failed plugins, reduced-motion transitions and header/body alignment.
   Numerical point editing and copy/cut/paste/duplicate workflows with hotkeys (`Mod+C`,
   `Mod+X`, `Mod+V`, `Mod+D`) and context menu are fully implemented and covered by unit tests.
5. Complete Touch/Latch/Write ownership and recording according to `audit.md`.
   Session identity, TempoMap lookup, bounded point storage, transport-stop and
   telemetry-observed cycle splitting exist. Core arbitration currently covers
   Timeline gain/pan only; prove audible Touch return, held Latch, Stop/seek,
   sparse cycle telemetry, multiple controls and all supported surfaces.
   Timeline Escape/pointercancel/lost-capture now revert and discard the
   unfinished pass; unmount discards without a stale index-based value write.
   Seek-vs-wrap authority and non-Timeline surface bindings remain open.
   Bounded rejected/unknown commit recovery is implemented; never blindly
   retry an unknown outcome.
6. Compile binding tables off audio instead of repeated string/region lookups.
   Native sample-offset vendor automation, Trim/relative layers, VCA and advanced
   hardware/lighting integrations remain separate explicit tasks.

Offline Write-mode policy is now explicit and tested: saved Write lanes are
suppressed in both live and offline playback; the offline renderer has no
manual gesture to replace them, so it uses the stored/static parameter state.
Do not reopen this as a mismatch unless live policy itself changes.

Capture-session verification on 2026-10-02: full UI suite 752/752 across 108
files, UI typecheck, production build, and lint (zero errors, 12 existing
warnings) passed. Core/helpers and native tests built; serialized full CTest
passed; real-Core `editor-state.mjs` passed automation recording/rejection and
project/history checks. A concurrent UI-build/native-test attempt exposed one
scheduler-sensitive miss in the real VST3 64-sample helper deadline; the
isolated VST3 test and serialized full suite passed. This is not device or
acoustic proof. Manual parameter ownership, missed-wrap/seek distinction,
and wider surface coverage remain open; bounded rejected/unknown draft
recovery is implemented below.

Timeline manual-ownership continuation (2026-10-02): Core now admits transient
owners only for enabled, unmuted, non-Read track-scope Strip gain/pan lanes on
the active song, with a 64-lane ceiling. The owner IDs are published as an
immutable graph snapshot; the audio callback performs read-only lane-ID lookup
and skips only the owned binding. Stop, song change and project replacement
clear the set. A native renderer regression confirms owned gain stays at the
manual graph value while an unrelated pan lane continues to automate. A UI API
test verifies project session/epoch fencing. This does not exercise a real UI
gesture, prove Touch/Latch/Write transition behavior, measure callback cost, or
prove audible hardware output. Mixer/inspector/plugin surfaces and seek-vs-wrap
authority remain open. Pointer cancellation/lost capture and bounded
rejected/unknown draft recovery are implemented in later blocks. Re-run focused
and full suites and record exact results before considering live acceptance
complete.

Verification for this implementation block: `cmake --build core/build --target
ResoStage resostage_engine_tests -j8` passed; the focused native ownership case
passed 1/1 test and 4/4 assertions; full native CTest passed 1/1 target. Focused
UI recorder/identity tests passed 15/15; full UI Vitest passed 774 tests across
114 files; `tsc -b`, production UI build and lint passed (zero lint errors,
12 existing warnings). This verifies compilation, project fencing and the
renderer arbitration rule, not live pointer ownership or device output.

Timeline cancellation verification (2026-10-02): shared knob and slider-revert
gestures now report cancellation distinctly from normal release. Escape,
pointercancel and lost capture restore the control's starting value, suppress
pending animation-frame commits, discard captured automation points and release
Core lane ownership. Unmount clears listeners/ownership and discards the draft
without sending a stale index-based rollback; ordinary pointerup still commits.
Focused cancellation/controller/recorder UI tests passed 25/25, TypeScript and
full UI Vitest (781 tests / 117 files) passed, production build passed, and lint
had zero errors with 12 existing warnings. No Core rebuild was needed for this
UI-only change. Real Core pointer integration, acoustic output, seek/wrap and
other control surfaces remain unverified.

Automation recovery verification (2026-10-03): a provisional draft is
persisted before Core submission; exact rejection permits one explicit retry
only after the same Core session/project epoch, song and lane are revalidated.
Unknown outcomes never resend. The queue is bounded to four gestures and 2 MiB
session storage, with JSON export for volatile drafts. Automation lane/point
APIs use shared exact-outcome failure reporting; Core's HTTP 503 queue-full
response is treated as a pre-enqueue rejection. Focused tests cover exact
rejection, explicit retry, unknown-outcome no-retry and queue-full reporting.
Full UI tests, typecheck, lint and production build are recorded in `audit.md`.
Manual device/audible Touch/Latch/Write and visual acceptance remain open.

Parameter discovery optimization verification on 2026-10-02: UI suite passed
757 tests across 109 files, TypeScript build passed, Core and native test
targets built, full CTest passed 584 cases / 428,677 assertions, and the actual
Core HTTP acceptance passed. The real hosted Apple AUDelay case passed 66
assertions for compact parameter indices and a live changed value. Lint passed
with zero errors; the existing warning set is listed in the audit. This does
not establish dense-project idle-cost targets, all vendor behavior, audio
continuity or device performance. Detached automation recovery is implemented;
vendor rebind and visual acceptance remain open.

## Acceptance evidence and limits

-49 focused UI gesture/model tests passed for `424e4f4`.
-10 automation commit/drag tests passed for `f747399`.
- Core/helper/tests build passed for `f436040`;19 focused native cases /
  3794 assertions include real Apple AUDelay metadata/current-value control.
- These counts are point-in-time evidence. Run current integrated suites after UI
  and DSP changes. Do not call generic model tests acoustic or platform acceptance.
- Need whole-lane add/draw/move/curve/smooth/delete, Undo/Redo branch, save/reopen,
  malformed/oversized/queue rejection, project replacement and delayed-echo checks.
- Need saved-state real AU/VST3 playback/render tests at multiple block sizes.
  Current vendor control bridge is block-rate, not sample-accurate.
- Need uninterrupted-playback edit tests (including Undo/Redo), confirming prompt
  authoritative application, stable sample clock, no partial snapshots/stuck
  voices/helper restarts and no waits/allocations on the callback.

## Live MIDI pedal recording preview — implementation in progress (2026-10-03)

The callback now captures switch-pedal controllers CC64–69 using the existing
fixed-size event storage. It also keeps each channel/controller's current held
state and original onset so a long pedal hold remains visible after that edge
falls out of the bounded latest-events preview. Captured events are still the
source of truth and are committed to the MIDI region on stop; preview telemetry
does not synthesize MIDI events.

The live preview `SeqLock` carries at most 512 controller events globally and
at most 64 recent events per recording session, plus held onsets. Stable
event IDs are deduplicated in the renderer across latest-wins state snapshots.
The UI clips colored markers and held spans to the viewport. The callback path
uses fixed arrays only and performs no allocation or lock acquisition.

Current verification: focused React live-preview/controller tests passed 20/20;
full UI suite passed 838 tests across 127 files; UI TypeScript, changed-file
lint, and `git diff --check` passed. Native helper test passed 2 cases / 21
assertions; `ResoStage` and `resostage_engine_tests` built and the full native
suite passed 592 cases / 428,766 assertions. No physical MIDI recording test
was run. The 4,096-event capture capacity and 512-event global preview
capacity can truncate dense or many-track sessions. A live-preview truncation
warning and arbitrary Piano Roll CC lane remain open. Do not describe this
bounded live view as lossless.

## Piano Roll switch-pedal lanes — implemented subset (2026-10-03)

The Piano Roll controller-lane selector now exposes CC64–69 individually
(sustain, portamento, sostenuto, soft pedal, legato footswitch, and hold 2).
The selected lane draws its actual MIDI event transitions and held spans,
including events before a trimmed region's visible start and repeated loops.
When several MIDI channels overlap, a span remains held until each active
channel has sent its release.
The projection bounds source scanning at 16,384 events, mapped work at 12,000
events, and loop passes at 1,200; a limited projection displays `CC VIEW
LIMITED` rather than silently implying a complete trace. No MIDI events are
created or changed by viewing the lane. Arbitrary CC controller lanes and
editing pedal events through this lane remain open.

Focused Piano Roll tests passed 10/10; the full UI suite passed 845 tests across
128 files; UI TypeScript, changed-file lint and production build passed.
`git diff --check` passed. No device playback/recording or manual visual
acceptance was performed.

## Display motion note — 2026-10-03

Automated gain, pan and send control geometry shares the CSS-only easing policy
documented in `performance.md`. Numeric gain/pan labels in the Timeline and
Mixer now use `components/daw/EasedReadout.tsx`: display-only easing runs on
the shared `rafLoop`, does not send interpolated values to Core or rerender
the owning strip every frame, and snaps during a direct gesture, reduced-motion
preference, or Core/project/song identity change. Timeline and Mixer pass the
same `stateSessionId:projectEpoch:songIndex` fence so a reused strip never
animates from a previous document or song.

Focused coverage verifies curve bounds, easing halfway through a transition,
identity-change snapping, and the existing automation control geometry.
The frame task is registered only while a readout is actively easing and is
removed as soon as it reaches its target; idle strips do not keep this feature's
frame work alive. Verification: full UI Vitest passed 853 tests across 130 files; TypeScript,
production build, lint and `git diff --check` passed. Lint reports the same
12 existing warnings in unrelated files. Automated sends still do not have a
numeric readout interpolation path; Inspector and plug-in parameter controls
also remain open. Do not describe every automatable value as smoothed.
