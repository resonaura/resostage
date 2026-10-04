# Post-completion audit and continuation contract

Updated 2026-10-04. Start here, then read the complete `AGENTS.md` and inspect
`git status`/recent commits. This audit supersedes completion claims in older
task snapshots. Do not repeat finished implementation or overwrite concurrent
work. Commit each verified block in English; do not push.

UI entry paths abbreviated as `timeline/...` below are relative to
`ui/src/screens/editor/`. Core paths are repository-relative.

## Evidence and limits

### Latest continuation addendum — plug-in editor bypass and Inspector automation (2026-10-03)

Commit `8535b290` adds a Bypass control to isolated and in-process native
plug-in editor windows. Isolated windows submit a bounded per-slot intent with
the exact bypass-state token shown by the editor; Core applies only a current
request on its message thread through the ordinary history-backed bypass path,
then publishes the new state. This prevents a helper UI from mutating project
or DSP state. Protocol tests cover latest-wins behavior, stale tokens and
bounds; Core/helper builds and native CTest passed. Real AU/VST3 editor-window
visual/acoustic acceptance remains open.

The Inspector automation path uses the shared track/bus strips. New UI
regressions verify stable selected-track forwarding and ensure live automation
gain/pan changes remain render-significant across the strip memo boundary,
while meter-only fields remain ignored. Full UI Vitest passed 867 tests across
134 files; UI TypeScript, changed-file lint and `git diff --check` passed.
This does not prove mounted visual easing, reconnect handling or remote Core
behavior.

Plugin Automation now displays the selected hosted parameter's latest
normalized Core-host value. Its visible-only sequential 500 ms polling is
fenced by session/project identity, plug-in-load generation, slot, plug-in,
load state and parameter. Focused coverage passed 6/6; the full UI passed 873
tests across 135 files, with TypeScript, production build, changed-file lint
and diff check passing. This is low-rate UI feedback, not sample-accurate
telemetry or proof against real AU/VST3 behavior. End-to-end Touch/Latch/Write,
remote/vendor acceptance and any need for a dedicated high-rate value channel
remain open.

Follow-up regression hardening (2026-10-03): the parameter descriptor catalog
is fenced by the same session/project/plugin-load/slot identity. When the user
switches slots or a project/plugin generation changes, old descriptors are
immediately hidden; a late response cannot select or poll an index on the new
slot. Only descriptors with explicit `automatable=true` are offered for a
lane. Discovery pauses while hidden and retries a loading host sequentially
every 250 ms only while visible. An interaction regression covers an
unresolved old catalog during a slot switch and a false-automatable descriptor.
Focused tests passed 10/10; full UI passed 877 tests across 136 files;
production build, targeted lint and diff check passed. Vendor/remote visual and
audio behavior is still unverified.

Follow-up — chain-scoped parameter API (2026-10-03): the Plugin Automation
modal now supplies `(stripId, slotId)` for both descriptor and live-value GETs.
Core resolves the requested processor within that exact chain and echoes both
IDs; the UI rejects mismatched echoes. Slot-only requests remain as a legacy
compatibility path. Actual-Core editor-state acceptance probes both endpoints
with an exact strip and a nonexistent slot, asserting the echoed pair and
`missing` rather than cross-chain fallback. Core/native build, CTest, 26
focused UI/API tests, full UI 881/881, TypeScript and production build passed.
No live vendor duplicated-slot bank fixture ran. Timeline's bulk
`useAutomationParameters` caller still used slot-only queries at the time of
this chain-API entry; the arrangement follow-up below closes that gap.

Arrangement follow-up (2026-10-03): `useAutomationParameters` now requests and
caches catalogs and current values by `(stripId, slotId)`, validates response
identity, and accepts an older unscoped response only when that slot ID is
unique in the current project. Duplicate slot IDs are marked ambiguous: their
legacy persisted automation lanes are not attached to either track, are listed
for recovery, and cannot be newly bound until identity is repaired. The
persisted automation target schema still stores only `entityId=slotId`; a
future schema change is required to automate two duplicate-ID slots
independently. Focused tests passed 45/45, full UI passed 887/887 across 136
files, TypeScript and production build passed, and changed-file lint passed.

### Latest continuation addendum — persisted plug-in automation identity (2026-10-03)

This supersedes the earlier note above that the project target schema still
lacked strip identity. The project AutomationTarget now persists additive
stripId alongside the existing slot entityId and stable parameterId. Add and
rebind commands resolve the pair against the current project and loaded
automatable descriptor; successful legacy unique-slot targets are normalized
to the exact strip. Core telemetry and project JSON round-trip the field, and
old files that omit it remain readable. Live block dispatch uses one bounded
strip/slot scan and the node's prepared parameter binding before queueing the
helper event; offline rendering applies the same exact pair. Neither path may
select the first of duplicate slots on different chains.

Timeline catalog requests and recovery destinations deduplicate alias rows
that share one physical effectiveStripId; legacy slot-only metadata is
considered unique across physical chains, not UI rows. Recovery counts distinct
strips and still surfaces old ambiguous lanes. Existing unbound targets are
filtered by exact strip so one chain's parameter cannot appear in another
chain's selector. Focused automation UI tests passed 52/52 across five files;
full UI passed 894/894 across 136 files; TypeScript/production build and
changed-file lint passed. Core and native tests built; CTest passed 1/1.
Project JSON round-tripping confirms old targets without stripId still load
unscoped. No vendor AU/VST3 playback or remote-Core acceptance was exercised.

### Latest continuation addendum — exact live plug-in slot state (2026-10-03)

The Core plug-in bank now resolves state and control operations through one
bounded `(stripId, slotId)` lookup. Load/error/power telemetry, parameter
catalogs/values, parameter-ID resolution, bypass, keep-awake, park and unpark
no longer act on the first matching slot ID from another chain. Legacy
slot-only callers resolve only a unique bank node and otherwise fail closed.
Timeline state publication passes each bank's strip identity, and offline
render readiness checks each slot against its owning strip rather than a
project-wide slot ID. The identity matcher regression covers exact duplicate
IDs, ambiguous legacy requests, and duplicate IDs within one chain.

The Core and plug-in host built; the focused native case passed 9/9 assertions
and full CTest passed 1/1. Full UI passed 894 tests across 136 files;
TypeScript, production build, changed-file lint and `git diff --check` passed.
No real AU/VST3 duplicate-slot fixture or audible vendor acceptance was run,
so this closes identity leakage in code paths, not the full writetest
reload/reopen report.

### Latest continuation addendum — live helper generations and Writetest retry (2026-10-03)

Plug-in slot telemetry now includes volatile `hostGeneration`, the live helper
process generation shared by all slots on one isolated strip chain. It is
diagnostic only, is not persisted, and does not itself mean a plug-in loaded or
produced audible output. The new private-copy actual-Core probe observed all
five AU slots in the user's Writetest project reaching `loaded`: IOF Drummer 4
and Magma StressBox (s) on one chain, Serum 2 on each of two chains, and Ozone
9 Elements on Main. A second copied fixture deliberately changed one AU
identifier to an unavailable ID, retried its exact `(stripId, slotId)`, and
asserted that only the target chain got a new helper generation; all three
unrelated live chain generations were unchanged. The test uses temporary copies
and removes only its own temporary directory.

This demonstrates current project loading and scoped retry/reuse under this
fixture, but does not reproduce the historical reopen symptom, verify editor
windows, or measure/audibly confirm audio continuity. Still test multi-chain
failures, same-chain multi-slot failure, rapid retry and project-switch races,
plus vendor-state/audibility with real playback. Keep the full harness output
and recovery assertions; never replace this with an unverified UI loading-state
claim.

### Latest continuation addendum — foldable automation lanes (2026-10-03)

The Timeline now shows simultaneous independent track-scope automation lanes
as foldable pseudo-track rows. Each row owns its target selector and lane ID;
the single `+` action creates the next eligible target. Collapse state is
bounded UI state owned by Timeline and scoped by project name, project epoch,
song and lane; detached envelope data remains the separate project-persisted
cache. A shared row-height vector drives both sidebar/body plus region drag,
marquee, file-drop and scroll-to-track geometry. Regions remain in the parent
track's base lane and pseudo-row hit areas map to that parent.

Verification: focused row/automation tests passed 54/54; full UI passed 864
tests across 133 files; TypeScript and production build passed. Lint exited 0
with 12 warnings in unrelated files; `git diff --check` passed. Browser visual
inspection, live Core two-lane history/Undo/Redo, save/reopen through the UI,
plug-in metadata churn and cross-song target resolution for differing track
IDs remain unverified. See [automation.md](automation.md) for the detailed
geometry and policy contract. This closes the first pseudo-row UI slice, not
the whole automation workflow.

Follow-up verification adds a chevron regression for the exact scoped
project/epoch/song/lane key. The focused automation editing/overlay/control/
layout suite passed 60 tests across six files; the full UI suite passed 904
tests across 138 files, TypeScript passed, changed-test lint passed, and
`git diff --check` passed. No production source changed in this follow-up.

### Latest continuation addendum — plug-in editor identity (2026-10-03)

Core editor creation/open/close now requires both stable strip and slot IDs;
the native editor-window registry uses the same pair. This closes an ambiguity
where duplicate legacy slot IDs in separate chains could target the wrong
editor. Optimized Core and isolated helper built; native CTest passed 1/1.
There is not yet a fixture that opens simultaneous vendor editors with
duplicate IDs, and this does not establish the reported writetest reload cause
or AU/VST3 independence. Details and remaining acceptance are in
`performance.md`.

### Latest continuation addendum — 2026-10-03

The global transport BPM/meter popover had not actually been operable: its
native button was rendered directly as a Popover child, and HeroUI's
PressResponder had no trigger. It now uses the explicit Popover.Trigger
compound component. A UI interaction test opens it, edits BPM/numerator/
denominator, submits, and verifies the reliable song patch targets the active
song. This validates front-end interaction/payload only; the Core tempo-map
application remains covered by the separate Core/editor-state acceptance.
After this fix, the full UI suite passed 854 tests across 131 files, the
production build passed, and lint had zero errors with the same 12 warnings in
unrelated files.

Timeline and Mixer fader/pan numeric labels now ease between current Core
automation telemetry values through the shared UI frame driver. The readout
keeps text updates outside React's per-frame reconciliation and receives a
Core-session/project-epoch/song-index identity fence; manual gestures,
reduced-motion mode and identity changes snap immediately. Full UI verification
passed 853 tests across 130 files; TypeScript and production build passed; lint
had zero errors and the 12 pre-existing warnings in unrelated files; diff check
passed. Automated-send numeric labels, Inspector/plugin parameter controls,
frame-cost benchmarking, and visual acceptance remain open.

Core project format v11 now persists a bounded per-song cache for curves
detached by track-lane target swaps. Rebind validation, staging and cache
capacity reservation precede the single ProjectHistory transaction; serialization
and the v10→v11 migrator preserve existing lanes and initialize absent caches.
The backend target set currently accepts loaded automatable plug-in parameters,
track gain/pan/mute, unique enabled sends, and MIDI CC/pitch bend for MIDI tracks.
The Timeline selector now reliably rebinds its current lane through the exact
Core mutation, resolves a Core-generated lane ID from the selected target after
the state echo, and uses the cache for curve detach/restore. With no lane, the
selected target remains preview-only until explicit `+` creation. Independent
foldable pseudo-track rows and shared sidebar/body/gesture geometry are
implemented; the initial-audit claim that only one lane is displayed is
superseded by the addendum above and `automation.md`. Remaining UI acceptance is
real Core Undo/Redo and save/reopen, plug-in metadata churn, and differing
per-song target IDs.

Latest verification for this block: `cmake --build core/build --target
resostage_engine_tests ResoStage -j4` passed; `ctest --test-dir core/build
--output-on-failure` passed 1/1; migration tests passed 2/2; the actual-Core
`scripts/verification/editor-state.mjs` passed target swap, empty new target,
exact point/curve restore and continued playback. It also saved a detached
curve, reopened the package in a fresh Core process and restored the exact curve
on rebind; `git diff --check` passed. No UI suite was rerun because no UI source
changed in this block. These results do not verify history Undo/Redo of dormant
curves via the UI or its visible save/reopen workflow; preserve those as
explicit acceptance gaps.

The follow-up target-selector UI change passed focused `AutomationTrackControls`
tests 14/14, full UI Vitest 849/849 across 129 files, `tsc -b`, the production
UI build, changed-file oxlint and `git diff --check`. It verifies the exact
reliable target-update request and generated-lane target resolution, not live
Core cache round-trip through the browser, duplicate-target failure recovery,
history undo/redo, or foldable pseudo-track UI.

Plug-in retry now carries an exact stable strip scope inside its captured
project epoch. The builder recreates only that strip's isolated helper chain,
snapshots its live state first, and retains every compatible non-target chain
and helper—including unrelated degraded chains. Chain atomicity remains: all
inserts in the selected helper are reconstructed together. Per-chain progress
and failure totals no longer count the whole project. Automatic failed-host
recovery waits for the active bank build to settle before it queues the next
failed strip, so a latest-wins request cannot silently cancel its predecessor.
Slot readiness during retry is resolved by strip+slot identity, so duplicate
legacy slot IDs cannot report the wrong strip as loaded. This is source-level
behavior plus pure scope tests, not yet a real AU/VST3 restart-count acceptance;
see performance.md for the outstanding fixture matrix.

The audited starting revision was `35166f50`. The current audit's initial UI
run passed 706 tests; an expanded run passed 724 tests across 105 files. After
the Piano Roll playhead/seek TempoMap fix, UI Vitest passed 729 tests across
106 files. Electron passed 39 tests. UI lint has zero errors and 12 pre-existing
warnings. The initial native run passed
563 of 566 cases. An isolated AU rerun passed 67 assertions; a retry does not
erase an integrated failure or establish the reason for it. Investigate timing,
load and publication order before claiming the native matrix is green.
After audit fixes and the optimized rebuild, the integrated native suite passed
576 cases/424,353 assertions, including both AU editor cases. Core/helpers built
successfully; UI and Electron typechecks passed. The final 576-case run includes
scalar point admission and partial strip-plan preparation. These results
supersede the initial failure for regression status, not for unmeasured acoustic
guarantees.

`scripts/verification/editor-state.mjs` exercises real Core HTTP admission,
authoritative state, transport advancement, history and save/reopen. Its fixture
uses an external MIDI track with MIDI endpoints disabled. It does **not** sample
audio, test a physical device transition, prove vendor DSP parameter changes,
or drive manual faders through React. At the starting revision Undo/Redo was
checked only after Stop; the extended harness now passes active-playback
Undo/Redo, an admitted invalid recording pass with unchanged points/mode/playing,
Write safety revert, 413 rejection, large edits and save/reopen against the
final Core build. These are actual HTTP/state tests, not DSP/manual-override proof.

`test_plugin_performance.cpp` exercises synthetic `MixRenderer`/PDC paths.
Varying `numSamples` is not physical audio-device reconfiguration. The allocation
probe covers ordinary C++ `new`/`new[]` on supported non-MSVC builds, not every
allocator or the complete `AudioEngine` callback. The dense deferred-MIDI test
checks packet content/order and panic recovery, not acoustic continuity.

Keep these distinctions in test names, log messages, documentation and the
final report. Test totals are dated evidence, not permanent acceptance promises.

## Main implementation mistakes found in the previous pass

- Persisted gesture points and a green HTTP endpoint were treated as proof that
  Touch/Latch controlled the live parameter. No Core-owned manual override
  currently arbitrates against playback. The hook is only wired from
  TimelineSidebar and omits cycle, TempoMap, project-epoch, bounded-session and
  rejection recovery. These modes cannot be described as complete.
- Project edits were called atomic while callback automation/MIDI/event paths
  still read mutable `Project` vectors. The callback routing try-lock only
  protects writers that use that same lock; normal builder mutations do not.
  An edit can therefore race vector replacement/reallocation during playback.
- Draft reconciliation used field-value coincidence in some flows, and HTTP
  admission was treated like an applied/rejected result. Same-Core reopen,
  reused IDs, reorder, late replies or multiple sends on one track can make old
  work target the wrong state. A command-count cap also left retained client
  payload bytes unbounded.
- Validation was added to selected automation endpoints but not every ingestion
  path. Legacy scalar point-add and initial-point fields could overflow when
  narrowed to `float`; repeated points could grow a lane without a cap. MIDI
  region embedded lanes now use the shared bounded parser at HTTP admission and
  again on the message thread before history/mutation; see the closed audit
  block below.
- One invalid or over-budget strip lane originally rejected the entire prepared
  automation plan and disabled valid sibling envelopes. Commit `18db49b`
  isolates invalid/excess lanes, retains valid siblings, and logs the skipped
  lane. Focused tests confirm actual output from the valid sibling; the final
  native suite is green. The whole-plan song-count/OOM failure remains separate.
- Synthetic tests and docs overstated their results as acoustic or physical
  device proof. A fixed wall-time speed ratio was also scheduler-sensitive; it
  is now diagnostic while deterministic work/phase assertions gate regressions.
- Inline numerical editing used custom focus/blur behavior that let global
  capture blur before Escape could cancel. The shared HeroUI Input now owns
  transactional Enter/Escape handling, covered through the real dispatcher.

Treat each test as evidence only for the behavior it actually drives. Do not
reuse old completion claims without rerunning their named acceptance.

## P1 — safe publication during live editing

Entry points: `core/app/engine/AudioEngineAutomation.cpp`,
`AudioEngineMidiRegionDispatch.cpp`, the callback/event dispatch callers,
`core/engine/automation/StripAutomationPlan.*`, and the existing graph/snapshot
publication and retirement paths.

Confirmed race: callback-side MIDI/automation dispatch used `project().tracks`
while plug-in/region dispatch traversed mutable song vectors. The message thread
owns those vectors, and builder replacements do not take a common reader lock;
the callback's routing `try_lock` therefore did not protect project lifetime.

Implemented in the current source block (not a hardware/acoustic proof):

- `MixGraph` owns a `shared_ptr<const ProjectPlaybackSnapshot>` prepared on the
  message thread. It contains playback track routing/channel/input/R-I values
  and immutable per-song region, MIDI, event, automation and `TempoMap` data.
  Unchanged song content is shared when its content revision is unchanged.
- Preparation validates bounded counts and an estimated 128 MiB copied-data
  budget before publication. Failure retains the last valid graph, reports the
  failure, and never falls back to mutable project vectors.
- Callback readers pin the graph snapshot and verify project/content revisions.
  `SongActivityIndex` refuses stale revisions; a track-layout generation fence
  prevents an old graph from being combined with newly resized callback scratch.
- Current song index and song-length frames are atomic across message and audio
  owners; each callback pins the song/index pair once instead of racing a
  gapless-transition write or mixing multiple songs' state in one block.
- The audited callback translation units no longer directly call
  `loader.project()`, `project()`, or `trackDefAt()`. Sequenced events use the
  pinned snapshot; live held-note panic remains independently routed.
- Native coverage includes snapshot copy/reuse/revision/budget behavior and
  stale activity-index rejection. The full native suite and the real-Core
  HTTP editor-state harness pass (exact current totals below).

Snapshot-build failure now remains distinguishable from successful playback
publication in exact editor results: `applied` means project history changed,
while `playbackApplied`, `playbackProjectEpoch`, and `playbackRevision` confirm
the immutable graph. `ProjectHistory` currently preserves its mutation
generation across document replacement, but the number is not a document
identity and must not be used as one; the AudioEngine playback epoch fences
stale or future reset/reuse cases. The result is published with the same state
frame; the renderer refreshes the
authoritative project and rejects blind retry when audio still uses its
last-good graph. This is explicit mismatch recovery, not transactional rollback:
the stored project edit is not undone if snapshot preparation fails. The
message-thread snapshot-publication failure path now has a real-Core test hook
and HTTP acceptance; sanitizer/concurrent stress coverage, callback
deadline/allocation measurements, and audible/sample continuity tests with
loaded AU/VST3 chains remain open. Resolved vendor parameter indices are not yet fully
prebound in this playback snapshot; automation parameter metadata caching
remains separate pending work.

Acceptance exercised: concurrent note/automation edits and Undo/Redo through
the HTTP harness while transport advances; snapshot revision/budget and stale
index cases in native tests; same-session save/reopen. This does not prove
acoustic continuity, heavy-project callback deadlines, vendor plug-in behavior,
or sanitizer cleanliness. Continue the explicit acceptance below rather than
marking the full P1 lifecycle complete.

## P1 — command epoch, applied acknowledgements and bounded retained payloads

Entry points: `ui/src/lib/state/api.ts` (`serializeCommand`, `postReliable`,
`postContinuousImpl`), `historyNavigation.ts`, MIDI/automation draft hooks,
`core/app/server/WebServer` command admission, and message-thread application.

Implemented in the current continuation block (2026-10-02):

- `ui/src/lib/state/commandQueue.ts` now provides the single reliable renderer
  queue: at most 256 admitted commands and 32 MiB of retained serialized JSON
  bodies. Bodies are serialized before queueing, their UTF-8 byte lengths are
  counted without creating an encoder copy, and both reservations are released
  on success or failure. `postReliable` returns count/byte exhaustion to the
  transactional gesture owner. History reserves its exact `{}` body too.
- Continuous controls coalesce by path plus sorted stable identity fields.
  Only the continuous value field for that route is omitted; `trackIndex` plus
  `busId` and optional send semantics are retained, so sends to two buses cannot
  overwrite each other. Individual bodies are capped at 4 KiB and coalesced
  pending strings at 1 MiB.
- Project identity is published as `(stateSessionId, projectEpoch)`. The epoch
  advances on each authoritative project replacement, independently of entity
  IDs. Renderer command-queue entries capture this identity before queueing,
  attach it to project-scoped HTTP posts, and refuse to send if Core or project
  identity changes while queued. The Core checks session at HTTP admission and
  checks the captured epoch again on the JUCE message thread immediately before
  applying the command. Legacy requests without headers remain compatible, but
  Core binds them to the state snapshot observed at admission.
- Active-document lifecycle requests (New, Save, Save As, Open Recent, Export,
  and native open-dialog requests) are also fenced. Recent-list clearing and
  quit/open confirmation responses remain app/dialog state, not active-document
  edits. Recent-project opens and native file-picker results route through
  `openProjectFromIpc`, so unsaved edits now block replacement behind the
  existing Save/Don't Save/Cancel prompt rather than bypassing it.
- Media import begin tickets preserve session/epoch through streamed upload and
  final message-thread conversion. A project switch between begin and upload
  now settles the import as a failure, removes temporary bytes and cannot
  mutate a reused track index in the new project.
- Undo/Redo and editor transactions publish exact request-ID outcomes in
  bounded 256-entry rings. These now cover song/track/bus/event/section/cycle
  structural edits, audio/MIDI region add/update/remove, automation lane and
  point edits, one submitted automation-record gesture, and lighting
  configuration/fixture/track/cue edits. Lighting results declare
  `applicationDomain: "lighting"`; `lightingApplied` confirms the synchronous
  immutable-project handoff to LightEngine. This does not prove a frame reached
  hardware and must not be conflated with audio `playbackApplied`. Import jobs,
  plug-in lifecycle, active-document dialogs and high-rate scalar controls
  remain distinct protocols. Structural plug-in chain edits (add, replace,
  remove, move) now use exact editor outcomes because these handlers commit
  project history and publish the matching routing/audio graph. This confirms
  the chain edit and graph revision only, not vendor plug-in readiness; load
  state remains owned by (project epoch, generation) plug-in telemetry.
  Bypass/Keep Awake target live plug-in bank/host state, and Retry/editor/
  park/unpark are lifecycle operations; do not claim their HTTP admission is
  exact audio application or fold them into the graph result ring without a
  host-specific acknowledgement contract. Audio results carry project epoch/history
  revision and graph publication revision. `playbackApplied` only becomes true
  when the published graph's monotonic ProjectHistory revision covers the edit;
  project identity remains independently fenced by the Core session/epoch.
  History advances its legacy applied high-water mark only on a real mutation.
  Expired results remain unknown; the renderer never infers success from an
  unrelated later request. Transactional UI calls wait for their exact result
  and do not blind-retry after timeout or graph-publication failure.
- The existing renderer queue remains capped at 256 requests/32 MiB; captured
  identity is included in coalescing keys for continuous values. Deferred-Core
  queue exhaustion and stale-epoch rejection now settle exact history/editor
  outcomes and media-job failure instead of leaving accepted requests pending.
- Core HTTP command admission is capped at 1024 preallocated queue entries as
  well as 32 MiB of aggregate payload. Exhaustion is explicit `503`; the queue
  implementation's larger-block growth is no longer an unbounded fallback.
- Verification on 2026-10-02: `pnpm --dir ui test` passed 741 tests in 108
  files; `pnpm --dir ui exec tsc -b --pretty false` passed; optimized Core
  target built with `cmake --build core/build --target ResoStage -j2`; the real
  Core `scripts/verification/editor-state.mjs` harness passed, including
  active-playback Undo/Redo, save/reopen, stale media ticket, stale MIDI edit,
  stale destructive New Project rejection, and 413 admission. The current
  continuation additionally passes exact Core HTTP outcomes for lighting
  configuration, fixture add/duplicate/update/remove and absent-remove
  rejection, track add/update/move/remove and invalid-remove rejection, and cue
  add/update/remove. The UI identity suite passes its lighting-specific case,
  including a successful lighting result while the audio graph revision is
  behind. This does not
  establish acoustic/device behavior, vendor plug-in continuity, sanitizer
  cleanliness or physical-platform coverage.

Lighting-domain acceptance on 2026-10-02: the actual Core harness verifies all
12 lighting mutation routes (config, fixture CRUD/duplicate, light-track CRUD/
move, cue CRUD), exact request IDs/project revisions, LightEngine snapshot
handoff, and rejected absent/invalid removals. The focused UI identity test
confirms lighting edits do not fail solely because the audio graph trails
project history. Full UI Vitest passed 782 tests / 117 files; UI TypeScript and
production build passed; lint had zero errors and 12 warnings. Core build
passed. Native CTest passed 585 cases / 428,681 assertions on the serial rerun.
An initial CTest run concurrent with the full UI suite had one AU-host block-
progress timing failure; its isolated rerun (1 case / 66 assertions) and the
subsequent serial full CTest passed. This is consistent with load sensitivity,
but does not establish the failure's cause or acoustic behavior.

Latest continuation verification (2026-10-02): UI TypeScript passed and the
complete UI suite passed 745 tests across 108 files; production UI build passed;
lint had zero errors and
12 existing warnings. The optimized Core target built and `ctest --test-dir
core/build --output-on-failure` passed 1/1 native targets, including a
deterministic bounded-snapshot rejection test proving an incomplete graph
cannot replace the last-good routing publication and fixed command/byte
admission reservation tests. The real-Core
`editor-state.mjs` harness passed audio/MIDI region CRUD, song/bus/event/section/
cycle structural outcomes, concurrent request IDs, 257-edit result-ring
eviction, playback graph revision checks, project-epoch fences, active-playback
Undo/Redo, import/stale edit/reopen, Core restart/session fencing with numeric
request-ID reuse, and 413 cases. Focused UI tests confirm an
expired exact result triggers one refetch, remains unknown and is not retried,
and fire-and-forget command failures are surfaced in the shell without retry.
An additional UI regression rejects a playback acknowledgement whose
AudioEngine epoch differs even when its reported history revision is larger
than the edit. This is state/protocol evidence, not audible continuity or
vendor/hardware proof. No Electron suite was rerun.

Follow-up transport-continuity investigation (2026-10-02): the real-Core
acceptance now waits for the expected forward playhead observation after the
live strip-automation edit and includes audio callback, underrun, silent-block,
sample-rate and device-alarm fields in timeout diagnostics. One standalone run
and five consecutive serialized runs passed on the same optimized Core. This
did not reproduce the earlier intermittent freeze, so it narrows the evidence
but does not close the issue or prove uninterrupted audio output. Keep the
failure-injection, callback/device, deadline and acoustic acceptance open until
the original symptom is reproduced or runtime signals are observed under a
representative stress test.

Actual Core failure-injection acceptance (2026-10-02): a dedicated
`RESOSTAGE_ENABLE_TEST_HOOKS` CMake option (default `OFF`) adds a test-only
loopback command and one-shot message-thread flag. With the option enabled, the
real-Core HTTP harness forced the next content snapshot to fail while playing.
It verified the exact result reported `applied=true` and
`playbackApplied=false`, the committed lane remained in project state, the
previous graph epoch/revision remained active, playhead continued, and the next
successful edit published the previously missed project revision without a
transport stop. The hook was removed from the local build configuration before
the ordinary acceptance run. This covers the injected publication
boundary, not allocation failure, acoustic output, loaded plug-ins, or
whole-callback deadline guarantees.

Still open; do not call this full editor transactionality:

- A failed playback snapshot is now observable and surfaced, but the editor
  mutation remains committed in project history; no safe per-command rollback
  exists because repeated gesture IDs intentionally coalesce several commands
  into one history entry. Do not undo a whole gesture to compensate for a
  single graph failure. Recovery currently refreshes state and tells the user
  audio remains on the last-good graph. Native tests prove the existing
  bounded validator rejects an oversized snapshot and `RoutingEngine` refuses
  an incomplete candidate while retaining the last-good graph. The actual
  Core-level failure-injection test also observes the exact command result and
  transport playhead progress on the retained and recovered graph. A new UI
  integration test feeds the same exact result shape through the real editor
  mutation API and verifies it rejects, refreshes, does not resend, and appears
  as an error in the app footer. These Core/UI tests are separate processes;
  together they do not constitute one real-Core-to-renderer failure-injection
  run. Transactional rollback or retry needs an isolated edit transaction
  model.
- Exact outcomes now cover the structural/audio/MIDI/automation and lighting
  route families listed above, but not plug-in lifecycle, active-document
  save/open completion, or most scalar/mixer controls. Media import has its
  separate bounded ticket/status result; the real async job is exercised
  concurrently with an editor mutation below, but is not in the editor
  command-result ring. The
  session/epoch fence covers their admission/application boundary, but this is
  not per-request applied acknowledgement for every app mutation. Project
  lifecycle admission, upload and browser-export transport failures now surface
  through the shared shell failure notice; asynchronous Save/Open terminal
  completion still comes from Core status/busy telemetry and is not correlated
  by a per-operation result ID. The focused UI suite verifies queue-full Save,
  HTTP 413 browser upload and export-status failure messages. On 2026-10-03 the
  project-identity suite passed 14 tests and full UI Vitest passed 802 tests /
  119 files; TypeScript and production build passed, lint had zero errors and
  the same 12 warnings. Native dialogs, disk-full and slow successful export
  remain platform smoke tests.
- Reordered concurrent audio/MIDI edits and matching graph revisions pass the
  real-Core harness. A 257-edit run proves the exact result ring retains only
  the latest 256 request IDs. A UI test proves an expired result remains
  unknown, triggers one state refetch, and never resends the accepted command.
  The real-Core harness now pauses dequeue through test-only loopback hooks,
  fills all 1024 HTTP command slots, confirms the next request gets 503, then
  drains and confirms admission recovers. It separately holds the deferred
  message-thread gate, fills all 1024 deferred slots and exactly 4 MiB of
  deferred command bodies, verifies each overflow probe has an exact
  `applied=false` result and unchanged project revision, then drains and
  confirms both count and byte admission recover. This deterministic hold
  exercises the real deferred admission path but does not replace the separate
  real-I/O overlap acceptance below. Same-Core reopen with stable entity IDs,
  process-local request-sequence continuity, and a late exact result retaining
  its old project epoch now pass. A separate loopback-test-hook run pauses
  command dequeue, verifies an accepted edit has no result and no state effect,
  kills Core, restarts it, confirms the persisted project is unchanged, and
  verifies a stale retry receives HTTP 409. A process restart also proves a
  fresh session may safely reuse the same numeric request ID. HTTP queue
  admission failure has no editor-result ring entry because that command was
  never accepted.
- Admission result rings remain bounded and process-local. A client that misses
  an exact result does not infer success from field coincidence or a later
  revision; after its bounded wait it refreshes state and reports the outcome
  as unknown. The operator must not retry blindly.
- Verify stale/reordered behavior for remaining project-scoped command
  families, plug-in/project loading overlap, active-document lifecycle
  completion, and upload-ticket expiry. Same-Core replacement, exact-result
  ring eviction, bounded queue admission/recovery, and late renderer-poll
  attribution are now covered. Refine route classification if a new project
  mutation endpoint is added.

## Closed this audit — structural plug-in chain edit outcomes

Structural plug-in chain add/replace/remove/move commands now receive exact
editor request IDs and terminal graph-publication outcomes. Their renderer
callers use the reliable project mutation path, so queue rejection, stale
identity, and a graph snapshot that does not cover the saved edit are surfaced
instead of silently disappearing. A project-epoch regression verifies that a
plug-in removal accepted just before same-Core document replacement settles
as `applied=false` on the JUCE mutation thread without changing the replacement
project. An invalid slot removal likewise receives an exact rejection.

Verification (2026-10-02): focused project-identity and plug-in-slot UI tests
passed 14/14; the complete UI suite passed 784 tests in 117 files; UI TypeScript
build passed; optimized Core built; the actual Core HTTP/state harness passed,
including real queue admission, exact rejected plug-in edit, stale-epoch
fencing, project replacement, persistence and active playback Undo/Redo. No
vendor plug-in load, audio output or hardware behavior is inferred from these
checks. Bypass/Keep Awake and Retry/editor/park/unpark
remain outside this graph-result protocol because their effects are applied by
the plug-in bank/host or editor lifecycle; they need a host-specific ACK before
the UI may claim host completion.

## Closed this audit — guard unsaved state for project replacement

Web Recent-project opens, the native Electron Recent menu, native file-picker
selections and browser project uploads previously called direct loaders in
some paths, bypassing the existing unsaved-change confirmation used by
Finder/Explorer opens. Both Recent entry points share
`openRecentProjectFromPath` and `openProjectFromIpc`; browser uploads now enter
the same Save/Don't Save/Cancel decision before replacement. A pending upload's
temporary file is removed on Cancel, failed Save, failed load, queue rejection
or Core shutdown. Only a genuinely missing Recent path is removed from history;
an existing but invalid project remains recoverable. A competing open cannot
retarget the visible prompt, even if another action clears the dirty flag
before the operator responds.

The project epoch and current in-memory content remain authoritative until a
successful replacement. Cancel preserves the document. If the user explicitly
discards edits but an uploaded package is malformed, parse failure preserves
the existing in-memory document and reports the error; it does not claim the
discarded work was saved.

Verification (2026-10-03): the optimized Core build with
`RESOSTAGE_ENABLE_TEST_HOOKS=OFF` and the full actual-Core editor-state harness
passed. The acceptance verifies
Recent first raises `openConfirmPending`, leaves unsaved MIDI edits and epoch
unchanged, preserves them on Cancel, and only replaces the same-ID project
after explicit Don't Save. Browser upload also prompts, Cancel preserves the
document, and discarding into a malformed package leaves the prior in-memory
content/epoch intact. A competing Recent open cannot replace a pending upload
target. The optional test-hook acceptance also passed on 2026-10-02 with the
Recent confirmation path before Core restart testing. This tests malformed
upload recovery, not successful browser archive round-trip or media inclusion.
Save-path terminal feedback still uses busy/status state; no claim is made that
Save/Open have request-specific operation IDs.

## Closed this audit — project Save button status

The Project menu previously treated generic `state.busy` as “Saving…”, but Core
uses that flag for both project saves and media imports. The button now follows
only save-specific `Saving…` and `Saved` status messages and resets for other
work. Save is already single-flight at Core admission, Save As has its own
dialog state, and open confirmation is an explicit modal state; the UI does not
currently await individual lifecycle request IDs. Do not add a second result
ring unless a caller needs request-specific terminal outcomes.

Verification (2026-10-02): regression test covers saving, saved, importing,
busy rejection and absent status; full UI suite passed 785 tests in 118 files;
TypeScript build passed. This is status presentation only, not a Save As dialog,
filesystem-failure, or remote-device acceptance.

## Closed this audit — Electron Save As request settlement

Two lifecycle gaps are closed. First, direct embedded Save As requests passed
an empty completion callback, so Core never published `saveAsPending` and the
Electron shell had no signal to open its native dialog. Core now publishes a
non-empty completion token even without a continuation, preserves the first
token on duplicate requests, and settles it on cancel or completion. Second,
the remote Save As path exports a copy to the controller and previously failed
to clear the remote Core's pending callback on cancel or several error paths.
That flow now sends a cancellation request to the original captured Core in
`finally` on every terminal path and never adopts the controller path as the
remote project's path. If the remote Core is disconnected, application cannot
be confirmed. The downloaded package is written to an exclusive sibling
staging file, flushed, and renamed into the selected destination so an
interrupted write cannot truncate the existing project. Failed publication
cleans only the staging file and preserves the selected destination.

The Electron state watcher also catches local native dialog Promise rejection,
sends the same `cancel_save_as` action as explicit dismissal, best-effort shows
an error, and clears its active guard in `finally`. It latches one dialog
launch per `saveAsPending` interval, so stale frames cannot reopen it before
Core settles the callback.

Verification (2026-10-03): Electron typecheck/build passed; 47 Vitest tests and
both Node alias-resolution tests pass. UI-independent tests cover remote export
success, start failure, timeout, destination cancel, native dialog rejection,
download rejection, write failure and message-box failure. Filesystem tests
verify atomic replacement and that a failed rename preserves the existing
destination and cleans the staging file. The actual-Core harness verifies
direct Save As publishes its pending state, a duplicate does not replace it,
and cancellation clears it without changing project identity. Core production
build and the full actual-Core harness pass. Native OS dialog rejection and
actual disk-full behaviour remain platform smoke-test limits; power-loss
durability and actual AppKit/Win32 dialog behaviour are not emulated.

Next implementation:

1. Perform local native Save As smoke tests on macOS/Windows/Linux, including
   user cancellation and write failure. Add host-specific acknowledgements for
   plug-in bypass/Keep Awake/retry only if callers need to know host
   application. Structural chain edits have exact editor outcomes, but that is
   not proof a vendor instance finished loading. Document lifecycle currently
   uses fenced admission, single-flight busy/status state, and explicit prompt
   flags; do not overload the editor-history result ring or treat Save/Open as
   history mutations. The UI now has a regression where an accepted edit's
   state poll returns an old-epoch exact result only after the observed project
   changes; it rejects the stale result, triggers refresh, and verifies there
   is one POST only. Core-side restart coverage pauses loopback dequeue,
   accepts an edit without a result/state effect, kills Core, and proves
   unchanged reload plus HTTP 409 on stale retry. Keep accepted-result expiry
   unknown and never infer application from another request's later
   state.
2. Add exact completion only to remaining structural mutations that truly
   participate in history. Do not make high-rate fader or knob streams await
   one ACK per value; keep continuous latest-wins controls separate. HTTP/TCP
   remains the reliable-command channel; UDP remains sampled telemetry and a
   WebSocket/Socket.IO swap does not supply these semantics.
3. The API-to-footer recovery path is now unit-tested with a simulated exact
   graph-publication failure result. If extending this, preserve separate
   evidence labels: current real-Core injection proves backend state/transport;
   the UI test proves refetch/rejection/no-resend/footer behavior. A single
   real-Core-to-renderer injected run remains future integration work.

Real asynchronous I/O overlap verification (2026-10-02):
`editor-state.mjs` uploads a private 64 MiB PCM WAV through the actual
begin-ticket/raw-body/status endpoints while the project package already holds
a separate private 64 MiB resource. It observes the actual import busy window,
submits a reliable MIDI-region edit, waits for the exact media-import terminal
status, verifies the edit applies only after the same-epoch project package is
reopened, and checks the full imported audio-region duration, song-boundary
extension, and preservation of the pre-existing package resource. This uses no
test-only import pause. It does not prove plug-in-state serialization, acoustic
continuity, or active-playback import: the current import path intentionally
stops playback before package mutation.

Pending-command process-restart verification (2026-10-02):
With a separate Core build configured `RESOSTAGE_ENABLE_TEST_HOOKS=ON`, the
optional `RESOSTAGE_TEST_PENDING_RESTART=1` harness path pauses the command
consumer through a loopback-only endpoint. It asserts an accepted editor edit
is still queued, absent from the exact-result ring, and absent from project
state, then terminates Core with SIGKILL. The next process has a different
session ID, reloads the unchanged persisted MIDI region, has no fabricated
result for the old request, and rejects a retry carrying the dead session's
identity with HTTP 409. The test build flag must remain `OFF` for ordinary
Core builds. This tests lost in-flight admission semantics; there is no old
process left to deliver an actual late HTTP response after SIGKILL.

Late renderer-poll verification (2026-10-02):
`projectIdentity.test.ts` pauses the state poll after an editor command is
admitted, advances the observed project epoch, then releases a successful exact
result for the prior epoch. The real UI API rejects it as stale, schedules its
normal state refresh, and has only one mutation POST. This is a controlled
fetch-level race test, not a live Electron/network restart test.

Same-Core replacement/late-response verification (2026-10-02):
After a clean restart, the real-Core harness queues a MIDI edit followed by
opening the same saved project package. The edit's exact result is present in a
later state frame but carries the pre-reopen project epoch; the reopened
project retains the same MIDI entity ID and its persisted contents, and the
next edit continues the same Core-local request-ID sequence. This proves the
server-side result remains attributable across a same-process replacement; it
does not simulate a renderer network response arriving after a Core process
restart.

## P1 — manual Touch/Latch/Write is only partially integrated

Entry points: `timeline/automation/hooks/useAutomationTouchRecorder.ts`,
`logic/automationTouchController.ts`, `logic/automationTouchSession.ts`,
`timeline/tracks/components/TimelineSidebar.tsx`, shared fader/knob wrappers,
and `MainComponentBuilderAutomation`/native automation playback.

The hook is instantiated only in TimelineSidebar and buffers points until
release/Stop; adding callbacks to shared controls does not wire every
mixer/inspector/plugin surface. A Core-owned live lane override now exists for
the Timeline track gain and pan gestures: the message thread publishes a
bounded immutable set of active lane IDs with `MixGraph`, and the callback
skips only a matching strip-automation binding. The ordinary gain/pan command
continues to publish the manually moved value. This is an arbitration
implementation, not yet evidence that an operator hears the control on a
physical device.

The 2026-10-02 continuation closes several UI session hazards: capture now
requires the confirmed `(stateSessionId, projectEpoch)` pair, cancels on song or
project identity transition, maps playhead seconds through the song TempoMap,
observes playhead changes for loop-wrap splitting, resumes a held Latch pass on
retouch, retains the last valid value when release data is absent, and caps a
gesture at 65,536 points with endpoint-preserving compaction. The Core parser
validates the optional compaction marker; reliable record-mutation rejection
already reaches the shared editor failure notification and is not retried.
Compaction is explicitly reported by Core status.

Core ownership is runtime-only, is not serialized/history state, and is cleared
on Stop, song change, and project replacement. Activation is admitted only for
an enabled, unmuted, non-Read track-scope strip gain/pan lane on the active song;
the active set is bounded to 64 lanes. If allocation fails while releasing an
owner, Core clears all transient owners and publishes that safe fallback.

Remaining session risks: cycle detection now consumes a monotonic Core-owned
pass sequence (with sampled-playhead fallback only for older Core versions).
Catch-up is deliberately bounded to four passes per UI update; after a larger
gap the recorder commits only sampled points and re-arms at the current phase,
without fabricating unobserved automation. A user seek similarly commits the
last sampled segment and re-arms at the destination without claiming a cycle.
Ownership is not bound to mixer/inspector/plugin or other parameter surfaces.
Rejected and unknown recording commands now retain a bounded local recovery
draft; exact retry rules and remaining acceptance are recorded below. Timeline
gain/pan now use an explicit cancellation policy: Escape, pointercancel and lost
capture restore the starting control value and discard the unfinished recording pass;
unmount discards the pass and releases ownership without sending a possibly
stale index-based value rollback. Normal pointerup still commits. The native
regression proves only that the named gain lane is suppressed while an
unrelated pan lane continues. UI unit tests cover the cancel callback and
capture discard separately, not a full pointer-to-Core acoustic gesture. They
do not prove all Touch/Latch/Write transitions or audible output.

Verification for the 2026-10-02 capture-session block: UI Vitest passed 752
tests across 108 files; TypeScript and the production UI build passed; lint had
zero errors and 12 existing warnings. Core and `resostage_engine_tests` built,
the complete native CTest target passed, and the real Core
`scripts/verification/editor-state.mjs` harness passed its automation,
active-playback history, epoch, rejection, and save/reopen checks. One CTest
attempt concurrent with the UI production build missed a real VST3 64-sample
output deadline at block 2; the isolated MSED integration case and a later
serialized full CTest both passed. Record this as scheduler-sensitive evidence,
not as a code-path fix or proof of stable physical-device deadlines. The HTTP
harness once also observed `playing=false` at the exact ACK for a live MIDI note
edit; three later serial runs passed. The assertion now includes playhead,
song-end, result and Core status diagnostics if that intermittent failure
recurs; it remains an unresolved transport-continuity signal rather than a
verified fix.

Remaining implementation and acceptance:

- Extend the Core-owned arbitration deliberately to each supported surface and
  parameter. Preserve the current invariant that the callback reads only the
  immutable `MixGraph` owner snapshot and performs no locking/allocation.
  Acceptance must prove Touch sounds the live value while held and returns to
  the underlying curve, Latch holds until punch-out/Stop, and Write has a
  documented destructive interval and reliable safety revert.
- Bind all supported surfaces intentionally, or disable/label unsupported
  write modes rather than claiming full integration. Do not install a second
  application hotkey dispatcher or infer touch from telemetry echoes.
- Complete UI-level validation that the transport-owned cycle/pass sequence
  distinguishes wrap from seek and preserves short-loop recording under
  telemetry loss. The UI tests cover single and multi-pass catch-up, bounded
  recovery and seek segmentation; the real-Core harness exercises a short loop
  and a seek. Still perform playback/device acceptance. Keep TempoMap conversion
  and identity fences.
- Preserve the existing 65,536-point client cap and Core lane budget; specify a
  bounded request cadence and retain one coherent history transaction per pass,
  not one undo per sample.
- Keep exact reliable rejection visible, and retain a bounded recoverable draft
  when outcome is rejected/unknown. Never blindly resend an unknown request.
  Old completion must not write into a new Core session/project epoch.
- Keep the Timeline control policy explicit: Escape/pointercancel/lost capture
  revert and discard; unmount discards without an index-based rollback; ordinary
  pointerup commits. Add integration coverage before changing that contract.

Acceptance: actual UI fader/knob gestures while playing, audible manual override,
release ramps, sustained Latch, Stop/seek/cycle, multiple controls, rejection,
same-ID reopen, Undo/Redo branch and save/reopen. Include failed/removed vendor
parameters and do not call packet collection alone live recording acceptance.

2026-10-02 implementation verification: optimized `ResoStage` and
`resostage_engine_tests` targets built; the focused native ownership test passed
1 test/4 assertions and full native CTest passed 1/1 target. Focused UI recorder
and command-identity suites passed 15 tests; full UI Vitest passed 774 tests in
114 files; TypeScript, production build and lint passed (0 errors, 12 existing
warnings). This validates the renderer skip rule and project-identity request
fencing only. It does not satisfy the UI gesture, cancel/seek, acoustic or
physical-device acceptance listed above.

2026-10-02 cancellation follow-up: UI TypeScript passed; focused knob, generic
revert, automation-controller and recorder tests passed 25/25. Full UI Vitest
passed 781 tests in 117 files; production build passed; lint had zero errors
and 12 existing warnings. Escape/pointercancel/lost-capture discard behavior is
unit-tested at the gesture and recorder layers. The tests do not drive a real
Timeline control through the Core or validate audio output. Seek-vs-wrap,
rejection draft recovery and non-Timeline surfaces remain open.

## Closed this audit — preserve automation outside recorded punches

`AutomationRecorder::punchPointsIntoLane()` now seeds a boundary point from the
original envelope, retains the exact pre-punch segment, and adaptively samples a
curved post-punch segment so the unchanged envelope remains within `1e-4`
target units. Resampling is capped at 4,096 generated boundary points and the
complete lane at 65,536 points. A request exceeding those limits is rejected
before history opens; the lane remains unchanged. Native tests compare 2,001
positions across both sides of linear/curved punch windows and verify that an
over-budget operation is atomic. The source lane's curve representation cannot
encode an exact arbitrary subsegment after a curved cut, so the documented
bounded approximation is deliberate.

## Closed this audit — new stable send automation identity and exact aux edges

Entry points: `timeline/automation/logic/automationTargets.ts`,
`core/engine/automation/StripAutomationPlan.cpp`, send mutation commands,
serialization/migration and lane matching tests.

At the audited starting revision new UI targets persisted `send:<array-index>`
and native preparation could confuse a direct route with an aux edge to the
same bus. Commit `697cc2a` adds explicit source send slots to aux edges, excludes
direct routes, and creates new UI targets as `send:<bus-id>`. Missing/disabled
and ambiguous duplicate stable destinations stay unbound; huge numeric IDs
do not throw. Focused native 11 cases/40,106 assertions and UI 38 tests passed.
Commit `1099234` additionally disables targets whose authoritative destination
bus is missing, rather than presenting a drawable inert lane.

Legacy index lanes deliberately retain positional meaning for compatibility;
this does not recover their historical destination after an old positional
edit. A future migration/send-mutation policy must not guess lost identity.
Removed destinations remain recoverable/deletable. Stable bus targets are
ambiguous when multiple enabled sends reach that bus; no edge is guessed.

Acceptance: two sends, remove first, reorder, replace destination, disable/enable,
duplicate bus edges, Undo/Redo and reopen. Assert the *actual modulated edge*
and offline/live parity, not just the selector label or persisted string.
The focused tests cover the new binding contract; heavy-device acceptance and
legacy migration semantics remain separate work rather than an invented guarantee.

## Closed record-gesture and scalar-point validation; MIDI-region parsing remains

Entry point: `core/app/main/builder/MainComponentBuilderAutomation.cpp`,
`builderAutomationRecordGesture`, and its HTTP/body admission/point parsers.

The audit found recording scalar/point validation weaker than whole-lane
replacement. Commit `73e1b8b` validates finite/ordered pass scalars and points,
rejects float-range overflow and invalid ranges before history/mutation,
clamps admitted values to the target range, uses a shared 65,536-point cap and
last-duplicate-wins normalization. Iterative RDP caps work at 4,194,304 distance
comparisons; exhausting that work budget preserves the valid trajectory rather
than losing points. The final integrated native suite above includes this block.

Acceptance: NaN/Inf/overflow, negative/inverted ranges, empty/duplicate/unsorted
points, target-range extremes, missing/removed lane, stale project, unknown mode,
oversized body and queue rejection. Assert explicit failure and unchanged
authoritative state/history. Verify application rejection after HTTP admission;
the status string is not a request-specific applied/rejected acknowledgement.

Commit `0a13280` applies finite/range checks before float narrowing to legacy
`builderAutomationPointAdd` and lane `initialValue` creation. Malformed supplied
values reject before history begins. A lane is capped at 65,536 distinct points,
while replacing a point remains allowed at the cap. The complete native suite
passed 574 cases / 424,340 assertions after this block. This closes only those
scalar paths; do not call one fixed endpoint a complete admission contract.

## Closed this audit — embedded MIDI-region automation validation

`BuilderMIDIRegionAdd` and `BuilderMIDIRegionUpdate` now share
`builder_json::parseAutomationLanes` from `AutomationJson.h`. HTTP admission
rejects malformed lane arrays with 400 before enqueue; the message-thread
handlers parse the same complete payload again before opening a history edit.
This prevents a malformed nested lane from being silently dropped or narrowed
to `float` after other region fields have already mutated. The shared parser
validates lane/object and field types, supported scope/write modes/target
domains/value types, finite float-representable target ranges, ordered target
bounds, finite nonnegative point times, finite values, curves in `[-1, 1]`,
unique lane IDs, at most 256 lanes and 65,536 total points. Valid points are
normalized with the same sorting and duplicate-position rejection as ordinary
automation edits. Region-scoped targets bind to the destination region ID on
both add and update.

Real-Core HTTP acceptance submits an out-of-range curve and asserts 400 plus
unchanged project revision and region data, then submits a valid MIDI CC lane
and verifies the exact mutation result and playback snapshot contain its point.
The full `editor-state.mjs` acceptance and native `ctest` passed after the
change. This closes the MIDI-region builder route boundary, not project-file
migration or every unrelated automation ingestion path.

## Closed this audit — cached plug-in automation descriptors

`useAutomationParameters` now retains a bounded 128-slot descriptor cache keyed
by Core/project epoch and generation plus slot ID, plug-in ID and load state.
The Timeline passes the Core plug-in epoch/generation into that identity, and
each asynchronous response remains fenced by its captured project/slot key.
Immutable names, stable IDs, ranges and parameter capabilities are fetched once
for each loaded slot generation instead of retransmitting every descriptor
table once per second. A compact
`GET /api/v1/plugins/slot/parameter-values?slotId=...` endpoint reads the
already-published hosted-helper atomics and returns only parameter indices,
latest normalized values and slot load status; it does not call vendor code or
run on the audio callback. The UI polls these small value rows only while the
automation surface is visible and a loaded slot has parameters. Request
concurrency is bounded to four, the descriptor cache to 128, and loading retries
to 250 ms.

Verification on 2026-10-02: Core and native test target built; real-Core
`editor-state.mjs` passed including endpoint shape and existing edit/history/save/reopen
acceptance; the actual hosted
Apple AUDelay parameter test passed 66 assertions, including compact-value
indices and a live parameter change. After adding a no-op snapshot identity
regression, the full UI suite passed 757 tests across 109 files and
`tsc -b --pretty false` passed. Full native CTest passed 584 cases / 428,677
assertions; real-Core `editor-state.mjs` passed. This proves the specific
cache/value handoff and hosted AU read path, not dense-project idle-cost
targets, every AU/VST3 vendor, or acoustic/device performance. Orphaned
automation recovery is implemented below; visual and end-to-end rebind
acceptance remain open.

## Closed this audit — detached plug-in automation recovery

Track controls could only receive lanes whose target slot and parameter still
belonged to the current project. A lane targeting a deleted plug-in slot or a
removed parameter therefore fell out of every track-filtered list even though
Core had preserved its points. The timeline now keeps a project-level recovery
strip visible for detached plug-in lanes across song, audio-region and
MIDI-region automation. It reports
the owning context when known (otherwise “Song automation”), preserves the
point count, and offers a destination picker containing only loaded,
automatable plug-in parameters plus an explicit remove action. Missing
parameters are conclusive only after complete loaded metadata; failed slots are
surfaced, while loading or truncated descriptor tables do not create false
warnings. Expanding the recovery strip reveals automation mode so normal
descriptor discovery supplies the real parameter options.

Rebinding uses the existing exact/history-aware automation-lane update route.
Core validates a complete finite normalized target, requires the destination
slot to exist in the current project, and verifies the loaded bank resolves
that parameter as automatable before beginning a history edit. A rejected or
stale destination changes neither the lane nor project revision; the original
points remain available. UI tests verify complete target formation, removal,
missing slots, unbound parameters, failed slots, and truncated-metadata safety.
The real-Core HTTP fixture verifies absent-slot rejection leaves its existing
orphan lane and points unchanged. Successful rebind against an actual vendor
plug-in is still covered by the UI target formation and hosted parameter
enumeration separately, not by this fixture.

Verification on 2026-10-02: full UI suite 763 tests across 111 files, UI
TypeScript and production build passed, lint passed with zero errors and the
same 12 existing warnings, Core and native test targets built, CTest passed 584
cases / 428,677 assertions, and real-Core `editor-state.mjs` passed the
detached-target rejection scenario. No successful rebind against a live vendor
parameter or manual visual/device acceptance is claimed.

## Closed this audit — offline Write-mode parity

`AutomationWriteMode::Write` is a live manual-override/recording mode. Both
live playback and offline rendering now suppress its stored curve; offline has
no manual gesture to supply replacement values and therefore retains the
stored/static parameter state. Recording completion returns Write to Touch
safety. `OfflineRenderer suppresses Write-mode lanes like live playback`
regresses plugin-lane suppression while confirming a Touch lane still reaches
the private offline session. The native target built and the focused test passed
(4 assertions). The same shared offline lane gate covers plugin and MIDI CC
lanes at song, audio-region and MIDI-region scopes. This is policy and dispatch
parity, not loaded-vendor acoustic parity; retain AU/VST3 render acceptance as
a separate task.

## Closed this audit — exact-value editor and gesture cancellation

Entry points: `timeline/automation/components/AutomationLaneOverlay.tsx`,
`hooks/useAutomationKeyboard.ts`, `hooks/useAutomationDrag.ts`, and shared
`HotkeyManager` editable-input Escape handling.

Commits `96281da` and `72bd512` scope inline editing to project/lane/selection/
history identity. Escape cancels without an onBlur save; deliberate blur/Enter
commit once. The shared `Input.ownsEditingKeys` policy lets the transaction
settle before HotkeyManager's generic input blur. Ordinary inputs keep their
auto-blur behavior. Actual HotkeyManager capture-order regressions pass.
Commit `a11a8f0` retains the original full-precision value and avoids an
untouched blur rounding/writing a new point value. The final focused
target/overlay run passed 28 tests and TypeScript.

Acceptance: Escape, Enter, blur, mouse dismissal, changing selection/project,
command rejection and repeated commit. Test with the real shared key dispatcher,
not only calling a component callback directly.

Related completed UI correctness block `2ff5808`: targeted live MIDI preserves
its explicit track index by bypassing the untargeted three-byte WS shortcut;
empty external MIDI tracks can open Piano Roll. Combined keyboard/overlay/
eligibility/routing tests passed 29 tests, plus the 38 overlay/control/target
tests; TypeScript and scoped lint passed. These do not establish vendor/device
acoustics or a completed global command-epoch protocol.

## Piano Roll TempoMap — project axis implementation complete, manual acceptance pending

Entry point: `ui/src/screens/editor/pianoroll/components/PianoRollEditorTab.tsx`
(`PianoRoll` position props and `onSeek`), and shared musical-time helpers.

The UI audit found project/sample positioning calculated as seconds multiplied
by one song BPM even when the song has `tempoPoints`. Commit `8cef0b2` adds a
shared UI song TempoMap helper and converts the Piano Roll live/stored playhead
and inverse seek mapping; the helper is also reused by Standard MIDI import and
export. This block completes the project-beat header: `PianoRollProjectHeader`
maps song duration and seconds-backed cycle locators through
`createPianoRollProjectAxis`, while `Ruler` draws bar labels and meter changes
from normalized `signaturePoints`. `CycleStrip` accepts optional coordinate
maps; its ordinary Timeline path remains uniform seconds, while Piano Roll
movement preserves a beat span and snapping uses the selected beat division.
Core's one project cycle remains authoritative and seconds-backed. Drawing and
stored note positions remain musical beats; no UI clock or duplicate cycle was
introduced.

Verification on 2026-10-02: focused beat geometry/project-axis/cycle tests passed
10/10; full UI Vitest passed 773 tests across 114 files; TypeScript, production UI
build and lint passed (zero errors, the same 12 existing warnings). This closes
the implementation gap, not visual/device acceptance.

Still required: manual geometry inspection with several tempo and signature
changes, horizontal scroll/zoom and nonzero song offsets; cycle drag/create/
resize/snap across tempo boundaries; selected regions before/after a change;
playback crossing a change; and save/reopen. Confirm note draw/record event
times and seek positions against beat/sample roundtrips rather than the label
alone. Do not alter Core's clock or claim acoustic proof from UI tests.

## Closed this audit — transport-owned automation cycle identity

`TransportTelemetry::cyclePassSequence` is advanced by Core only when a
project-cycle wrap is actually taken: the sample-split callback path counts
crossings without blocking, and the non-resident fallback increments only
after its cycle seek is successfully applied. Locator edits and user seeks do
not increment it. JSON state and binary telemetry v10 expose the counter; v10
preserves the v9 fixed header and row offsets and appends the value after the
variable-size LED rows. The UI uses high-rate binary telemetry in embedded mode
and leaves the field optional for older Core versions.

`useAutomationTouchRecorder` uses the Core pass identity instead of inferring
wraps from sampled playhead positions. It catches up at most four passes in one
UI update; if more are missed, it commits only sampled points and re-arms at the
current phase rather than inventing data or flooding Core. A backwards seek
commits the last sampled segment and re-arms at the destination without
pretending it was a loop. Project/session identity fences remain in place.

Verification on 2026-10-03: optimized Core production target built; the actual
Core HTTP harness passed a short-cycle increment and stopped-transport seek
non-increment check; native `ctest` passed 1/1 target; UI TypeScript passed;
full UI Vitest passed 790 tests across 118 files; and the UI production build
passed. Focused v10 telemetry and automation recorder/controller suites passed
40 tests. This does not substitute for manual continuous-playback/device
acceptance or prove acoustic Touch/Latch/Write behavior.

## Closed this audit — preserve failed automation recording gestures

Reliable editor mutations now expose a typed outcome: not sent, exact rejected,
unknown, or stored without confirmed live publication. The Timeline recorder
persists a provisional unknown-outcome draft before sending the gesture, then
removes it only after an exact successful confirmation. This protects captured
points if the renderer reloads while awaiting Core. It retains up to four drafts
in session storage within a 2 MiB serialized budget; if storage is unavailable
or a draft exceeds that budget, the bounded in-memory copy remains visible with
a required JSON download warning. The user can download or explicitly dismiss
each draft.

Only a definitely unsent or exactly rejected draft can be retried, and only
while its captured Core session/project epoch, song, and lane still match. A
retry is marked unknown in storage before its POST begins. Timeout, Core
restart, malformed/incomplete acknowledgement, unknown network result, and a
project edit stored without a confirmed playback snapshot never expose Retry.
The bounded capture queue accounts for active lanes as well as retained drafts;
when a cycle reaches the final slot, it stops that lane at the boundary and
keeps the completed pass locally instead of submitting an unprotected command.
The generic editor failure notice remains alongside the actionable Timeline
recovery panel.

Focused verification on 2026-10-03: recorder tests cover provisional
persistence, exact rejection and explicit retry, plus refusal to resend an
unknown outcome; storage tests cover malformed records, byte/count limits and
selective removal. All automation lane/point mutations now use the shared
editor failure notification as well as their typed promise result. Core's
documented HTTP 503 queue-full response is rejected before enqueue and is
therefore classified as a safe explicit rejection; ambiguous 5xx/network
failures remain unknown. The focused plug-in API, recorder and recovery tests
passed 31 tests across three files; full UI Vitest passed 799 tests across 119
files, `tsc -b` passed, lint had zero errors and 12 existing warnings, and the
production UI build passed. `git diff --check` passed. These are renderer/API
contract tests, not live-device recording acceptance. The broader manual
Touch/Latch/Write surface and acoustic acceptance remain open below.

Cross-repository rerun on 2026-10-03: Electron passed 47 Vitest tests, two
alias-resolution tests and typecheck. Optimized Core plus `resostage_engine_tests`
built with `-j2`; CTest passed 1/1 target. The actual-Core
`scripts/verification/editor-state.mjs` harness passed its state/history,
save/reopen, automation, media-import, lighting, epoch/restart, and short-cycle
suite. This is current protocol/persistence evidence, not physical audio,
loaded-vendor, native-dialog or audible Touch/Latch/Write acceptance.

## Execution order for remaining work

1. The real-Core injected snapshot-failure/last-good-graph/exact-result path is
   now covered with a compile-time test hook that defaults off. Keep the
   separate unresolved limits above: no transactional rollback, allocator-fail
   injection, acoustic continuity, or device/deadline proof.
2. Keep the exact-result route inventory aligned with Core: supported
   structural audio/MIDI region, song/track/bus/event/section/cycle,
   automation, lighting and plug-in-chain mutations already have exact
   outcomes. Remaining Save/Open completion, plug-in lifecycle and scalar
   mixer controls are separate protocols; add a request-specific acknowledgement
   only when its owner needs it. Do not make high-rate controls await one
   acknowledgement per sample/value.
3. Complete acceptance and failure UX for immutable, bounded project playback
   snapshots: sanitizer/concurrency coverage, callback allocation/deadline
   measurement and actual AU/VST3 audio-continuity proof. Keep transport running
   and do not hide races by locking editor commands or restarting healthy helpers.
4. Extend Core-owned live manual-value arbitration beyond Timeline gain/pan
   only after real UI, playback and device acceptance. Keep it aligned with
   TempoMap, cycle wrap, Stop, seek, project epoch, the bounded rejected/unknown
   draft recovery, and one coherent history action; recorded points and
   renderer tests alone do not prove audible Touch/Latch/Write behavior.
5. Embedded MIDI-region automation input is now bounded and validated before
   history/mutation. Immutable parameter-descriptor caching is also implemented
   above; live/offline Write behavior and punch-window preservation are tracked
   in the automation lifecycle items.
6. Visually verify detached/unbound automation recovery and exercise a successful
   rebind against a loaded vendor plug-in; measure metadata/value request rate and
   Core/UI idle cost on dense projects.
7. Manually accept the TempoMap-based Piano Roll ruler/cycle/project axis above,
   then run heavy vendor/device, theme, platform and save/reopen acceptance in
   `media.md` and `performance.md`.

## Quality contract for every remaining change

- Keep the canonical source license header, English comments, typed public
  boundaries and `@/` UI imports. Components, hooks, pure logic and tests have
  separate ownership folders; prefer small focused changes over a rewrite.
- Use shared HeroUI wrappers and semantic theme tokens for chrome. Musical
  SVG/canvas rendering is appropriate; raw controls and hardcoded feature
  palettes are not. Preserve header/body geometry and reduced-motion behavior.
- State ownership must distinguish admission from application, authoritative
  snapshots from drafts, and project identity from entity IDs. Do not mark an
  HTTP 200 as an applied project acknowledgement. Bound queues/retries/caches.
- No waiting, allocation, filesystem/network/vendor calls or last-owner graph
  destruction on the callback. Do not replace established lifetime management
  with raw pointers or add a blocking mutex to hide a race.
- Preserve comments and behavior mechanically during refactors. No unrelated
  naming/schema/transport cleanup inside a correctness fix. Keep public wire
  fields and persisted data compatible unless an explicit migration is tested.
- Tests must fail for the original bug and cover failure/late-echo/epoch cases.
  A green synthetic test is not hardware, acoustic, remote or platform proof.

## Remaining acceptance outside the immediate fixes

Keep `performance.md` and `media.md` until their actual acceptance is complete:
heavy saved-state AU/VST3 live/render runs, whole-callback allocation/deadline
measurements, render stems/cancellation/collisions, remaining physical platforms
and corresponding dependency-source/build-recipe retention. Do not overwrite
the user's recent projects/settings; use private copies and temporary settings.

Automation additionally needs actual light/dark UI inspection at compact/large
track heights, loading/missing/failed/unbound parameters and reduced motion.
The detached-lane recovery strip is implemented above; visually inspect it in
light/dark themes, narrow window sizes, read-only mode, no-loaded-destination
mode, and for song/audio/MIDI-region lanes. The descriptor cache and compact
value endpoint are implemented above; dense-project request-rate and idle-cost
profiling is still required before claiming global plug-in/automation
optimization.

`naming.md` remains a separate low-priority mechanical inventory. Adding aliases
does not finish canonical filename/caller migration. Keep vendor/JUCE/wire
spellings and avoid case-only duplicate files on macOS/Windows.

Commands: `pnpm --dir ui test`, UI/Electron typecheck and lint, focused native
tests followed by the appropriate native matrix, and the actual Core HTTP
harness. Bound Vitest workers in the configuration it actually loads
(`ui/vitest.config.ts` has precedence over `ui/vite.config.ts`); serialize
heavy builds on this 8 GiB host. Update this audit with exact evidence and
remaining failures before deleting any task file.

Run from the repository root; stop other Core instances before the private
HTTP harness (JUCE single-instance ownership). Do not change operator settings:

```sh
pnpm --dir ui test
pnpm --dir ui exec tsc -b --pretty false
pnpm --dir ui lint
pnpm --dir electron test
pnpm --dir electron typecheck
cmake --build core/build --target ResoStage resostage_engine_tests -j2
core/build/tests/resostage_engine_tests --no-colors=true
node scripts/verification/editor-state.mjs "/Users/resonaura/resostage/core/build/app/ResoStage_artefacts/RelWithDebInfo/ResoStage.app/Contents/MacOS/ResoStage"
```

The final line is the verified raw optimized Core path on this Mac, not the
shipping Electron app. Other platforms must resolve their actual matching
Core/helper artifacts; do not point the fixture at a stale packaged binary.

## Other verified fixes and pending integration

Commit `bfefae9` closes a helper completion race: the helper must clear a command
before release-publishing completion, so Core may immediately reuse the request
slot without a late old-helper write clobbering the new command. This is an
ordering fix, not an ABI change. Two focused completion/power cases passed
20,006 assertions; the final integrated 572-case suite passed too. The
quiet-helper timing test now has deterministic pass-count
assertions instead of an unstable fixed wall-clock ratio requirement; the
measured 35.6x idle ratio is diagnostic evidence for that run only.

Commit `932f2a3` moves the bounded Vitest worker setting into the active config.
Send binding and exact-edit blocks are closed above. Commit `695df99` strengthens the
synthetic changed-PDC refill test to check the first 128 zero samples and every
subsequent phase sample, and corrects misleading acoustic/device test names.
The expanded synthetic coverage passed in the final integrated native run.
Native record-gesture validation is committed in `73e1b8b`; a global status
string is not a request-specific applied/rejected acknowledgement.

Prior playback-snapshot block verification (2026-10-02):
optimized Core and native test targets built with `cmake --build core/build
--target ResoStage resostage_engine_tests -j2`; focused SongActivity passed 8
cases/2,192 assertions; the complete native suite passed 578 cases/424,387
assertions. `scripts/verification/editor-state.mjs` passed against that freshly
built Core, including live-edit/Undo/Redo/rejection/save-reopen checks. UI and
Electron suites were not rerun for this Core-only block. No acoustic/device,
loaded-vendor, sanitizer, or callback-deadline claim is made.

Command-identity block verification (2026-10-02):
`cmake --build core/build --target ResoStage -j2` passed; `pnpm --dir ui test`
passed 740 tests in 108 files; `pnpm --dir ui exec tsc -b --pretty false`
passed; four focused state/import/plugin suites passed 27/27; the actual-Core
`scripts/verification/editor-state.mjs` passed, covering active-playback
Undo/Redo, save/reopen, stale media ticket after project replacement, stale
MIDI edit rejection without revision/entity mutation, and bounded HTTP 413.
This block has not rerun the complete native/Electron suites and establishes no
acoustic, vendor, sanitizer, hardware, or callback-deadline guarantee.

## Added audit scope — 2026-10-03

The request below is a new open work block. Keep this audit and
[handoff.md](handoff.md) current after every separate commit. Detailed
acceptance is split into [automation.md](automation.md),
[performance.md](performance.md), and [audio-flow.md](audio-flow.md).

### Confirmed implementation gaps from the initial source audit

- At the initial audit revision, Timeline automation showed only one selected
  lane overlay and lacked both foldable pseudo-track rows and target curve
  caching. Both implementation gaps are now closed by the v11 target cache and
  commit `08a06a39 Add foldable automation pseudo-tracks`; see the latest
  continuation addendum above. Browser/Core history, save/reopen and real plug-in
  metadata acceptance remain open.
- Shared Knob supports double-click reset. A common rotary RMB menu and a
  typed safe-continuous MIDI Learn catalogue have now been implemented for
  track/bus/master/click pan and track/click send level. Remaining: expose the
  policy to any future rotary widget through its shared owner, and define
  project/song scope for currently rig-wide MIDI mappings.
- useChannelClipHold now reads the bounded shared store in
  `ui/src/lib/audio/channelClipHold.ts`; decoded meter telemetry publishes
  once under Core origin/session/project epoch plus stable strip ID. Timeline
  `TrackGainControl`, Mixer `ChannelStrip`, and Inspector `TrackStrip` /
  `BusStrip` all read that same latch and clear action. No separate Inspector
  meter state was found. Existing store tests prove multiple subscribers and
  global reset; still reproduce the reported stale peak across actual mounted
  Timeline/Inspector/Mixer surfaces and telemetry updates before claiming the
  original symptom is closed.
- Audio Flow already exists under Settings > Audio and reads Core's MixGraph,
  with MIDI configuration shown as separate dotted routes. Mixer aux/main bus
  strips now open it focused on their stable ID and can toggle the full graph;
  regression coverage is documented in `audio-flow.md`. Current MixGraph
  edges do not encode plugin sidechain/aux-input edges; true sidechain audio is
  not present in the inspected project/schema path.
- Active-song BPM and signature are shown in the global transport header
  through SongTempoControl's popover; the popover trigger now uses explicit
  HeroUI Popover.Trigger composition and opens in the interaction regression.
  Tap Tempo also writes the active song. patchClickFields reaches the reliable
  song-update route. Do not duplicate this UI. Verify on an actual packaged UI
  that edits are active-song scoped and do not corrupt explicit tempo/signature
  point-map semantics.
- MIDI controller visualization is partially implemented: MidiRegionBlock
  derives CC64–69 switch-pedal intervals from persisted region events, Piano
  Roll has separate CC64–69 bottom lanes and dynamically exposes raw CC found
  in the selected region, plus pitch-bend previews with trim/loop-aware value
  projection. Live MIDI capture stores all CC numbers, bounded to 4,096 events
  per session; live preview publishes the latest 64/session and 512 globally,
  merges latest-wins telemetry while mounted, and warns separately about
  capture overflow versus telemetry-only preview gaps. Raw MIDI-event editing
  and visual/device acceptance remain open; do not duplicate these paths. Apple sources
  distinguish CC64 state, Piano Roll controller data and Score Editor notation;
  see automation.md.
- Plug-in live helpers are per strip chain and offline processors are private.
  The user-reported writetest multi-load/reopen coupling is not yet reproduced
  against a private fixture. Offline render now checks every enabled private
  slot's prepared load state and aborts before output creation on failure; a
  renderer-level factory-failure test passes. This does not cover vendor hangs,
  first-block acoustic readiness, or real AU/VST3 fixtures. Existing
  architectural prose is not evidence that live chain transitions are sound.

### Required implementation sequence

1. Add/fix regression fixtures for independent plugin-slot retry/editor open,
   bounded offline initialization/cancellation and real-vendor first-block
   readiness, shared strip clip-hold identity/reset, and stale active-song/
   target state. The renderer-level fail-closed test is present, but it only
   injects a failing processor factory. Use a private copy or synthetic
   project; never save into Recent project originals or operator settings.
2. Make Core automation evaluation observable by stable target in compact
   structural/telemetry data, then make all controls read the same live value
   without treating UI easing as audio authority. Avoid a full-state JSON
   rebuild at telemetry frequency and keep remote/local epoch handling.
3. Foldable automation pseudo-tracks and the bounded v11 target-change cache
   are implemented with native migration/history and UI geometry coverage.
   Finish real Core/browser Undo/Redo and save/reopen, plug-in metadata churn,
   and per-song target identity acceptance; do not recreate the completed rows.
4. Introduce shared rotary context-menu/reset/MIDI-learn policy with an
   explicit eligibility type/catalogue; retain each control's true default.
5. MIDI CC/pedal overlays, bounded all-CC live capture, shared peak/clip state,
   and the active-song BPM/signature editor have implementation coverage.
   Remaining acceptance is physical MIDI-device capture, mounted surfaces,
   and packaged/remote active-song behavior.
6. Extend mixer entry to Audio Flow and design true plugin sidechain support
   only after measuring graph and helper ABI constraints. Sidechain is not
   complete when only its edge is visualized.
7. For each block run focused tests, diff-check, relevant full suite, and
   commit in English. Do not push. Update task docs with actual results.

Plugin bypass control readiness, per-slot presets, AU/VST3 sidechain, and
render/plugin state restore acceptance are documented in performance.md. The
per-bus graph button, focused/full-tree view, route-layout strategy and
visual/audio parity are detailed in audio-flow.md.

### Evidence required before closure

- Native project serialization/migration/history tests for target cache; undo
  and redo must restore both active binding and dormant target curves exactly.
- UI tests for two or more lanes, collapsed virtualization/remount, target
  changes, current automated knob/fader values, MIDI Learn exclusions, global
  clip-hold/reset, meter easing, CC overlay and BPM/meter editing.
- Real Core active-playback and save/reopen tests; no extra graph rebuild or
  healthy plugin restart for a parameter-only edit.
- Real saved-state AU and VST3 live and offline runs recording ready timing,
  per-chain restart counts, first audible block, deadline/underrun telemetry,
  bypass correctness, preset restoration and sidechain-input signal. Synthetic
  renderer output alone cannot establish these.
- Graph focused/full-tree visual tests at dense route counts and live/offline
  sidechain audio parity. No visual-only sidechain claim.
- Full acceptance on hardware/platforms is still distinct from local compile
  and unit tests. Clearly report skipped vendors/devices.

### Implementation progress — shared peak/clip latch

`useChannelClipHold` now reads `ui/src/lib/audio/channelClipHold.ts`, a bounded
store keyed by Core origin/session/project epoch plus stable strip ID. The live
telemetry decoder feeds it once per track/meter row; `ChannelStrip` and Timeline
`MeterFader` share the same clip state, and the mixer clear action publishes a
shared reset. Retention is bounded at 8,192 strip identities across unmounts;
Core telemetry reset clears retained latch values. This is UI metering only and
does not send commands to or mutate the audio engine.

Focused verification: `pnpm --dir ui exec vitest run
src/lib/audio/tests/channelClipHold.test.ts src/lib/audio/tests/liveLevels.test.ts`
passed 21/21; `pnpm --dir ui exec tsc -b --pretty false` passed; `pnpm --dir ui
test` passed all 808 tests. `pnpm --dir ui lint` exited successfully with
existing warnings in unrelated files and none in the changed files.
Multi-surface visual/remote tests and consistent held-peak readout in Timeline
remain open.

### Follow-up — shared stereo peak hold across Timeline, Inspector and Mixer (2026-10-03)

The shared strip store now retains per-channel maxima from every valid Core
track/bus meter sample, not only over-zero clip events. Timeline's combined
meter/fader and compact meter, plus the Inspector/Mixer `LevelMeterBar` and
peak readout, sample those same stable strip values. Clear from a shared strip
readout/meter resets the common left/right hold and clip latch. Ordinary peak
increases update the small paint-loop snapshot in place and do not notify
React; clip transitions/reset remain the only store notifications. The meter
canvases quantize retained markers to their own pixel grid before repainting.

Focused verification and full UI/build results are recorded in
`performance.md` and `handoff.md`. Inspector/bus identity integration under
track switching, remote Core replacement and real-device visual acceptance
remain open.

The initial audit also confirmed that active-song BPM/time-signature editing
and Tap Tempo were already present in SongTempoControl; do not duplicate this
surface. Only regression coverage and point-map preservation verification
remain.

### Implementation progress — show Core-evaluated gain, pan and sends (2026-10-03)

`StripAutomationPlan::visitControlValues()` evaluates only the prepared
winning gain/pan bindings needed by strip controls. It shares the exact curve
evaluator and manual-lane-override policy used by live/offline DSP. Core maps
results through the graph strip index and attaches them only to matching
stable track/bus/click rows when project epoch and history revision match.
Winning send bindings are indexed by graph edge and projected into the
matching track/click output send after verifying source, slot and destination.
The graph snapshot is acquired once and shared with signal-flow projection.
No audio-callback work or binary protocol layout changed.

Timeline and Mixer controls display these optional values separately from
persisted manual values. Local optimistic edits win, and manual values remain
the edit/Esc-cancel baseline. Short CSS transitions honor reduced motion.
Mixer send arcs also display the graph-evaluated send amount with a separate
manual edit/cancel baseline. Native and UI regressions were added.
Inspector/plugin controls, physical-device/remote playback, and the broader
pseudo-track/cache work remain open.

Verification on 2026-10-03: `ResoStage` and `resostage_engine_tests` built;
the focused native case passed 1/1 with 29 assertions; full CTest passed 1/1;
direct full native suite passed 590/590 cases and 428,745 assertions. Focused
UI automation control tests passed 8/8; full UI passed 823 tests/124 files;
UI TypeScript passed; lint exited 0 with 12 existing warnings, none in changed
files; `git diff --check` passed. No device or remote playback was exercised.

### Implementation progress — bounded persisted MIDI CC region preview (2026-10-03)

`MidiRegionBlock` now shares a typed projection for persisted MIDI CC events.
It caps source scanning at 65,536 events, expanded loop events at 10,000, and
horizontal marker bins at 1,200. Switch-pedal spans cover CC64–69; their state
uses off=0/on=nonzero, keeps channel identity, and accounts for a pedal already
down before the visible clip start. Arbitrary CC events remain numbered and
are not mislabeled as sustain. Markers are track-colored, read-only, and do not
intercept region pointer selection. The source-beat mapping uses the existing
shared trim/loop helpers.

Focused controller/component/timing tests passed 11/11; the full UI suite passed
836 tests across 127 files; TypeScript passed; lint exited 0 with 12 existing
warnings and none in changed files. No manual visual or device acceptance was
performed. This does not cover broader Piano Roll CC lanes.

### Implementation progress — bounded live MIDI controller capture/preview (2026-10-03)

The audio callback captures all MIDI CC numbers (0–127) into the existing
fixed 4,096-event-per-recording MIDI buffer; CC64–69 alone maintain held onset
state. The buffer count never exceeds capacity, and exhaustion sets a sticky
per-session flag. `publishLiveMidiPreview()` publishes per-session event counts
and capture status for up to 1,024 sessions, plus at most 64 recent events per
session and 512 controller events globally. The message thread maps the bounded
frame to recording IDs and serializes absolute song beats, channel, controller
and value. The UI merges event IDs across latest-wins telemetry and renders
arbitrary CC markers. A warning distinguishes events lost at capture from
events missing only in bounded telemetry; the latter may still exist in the
committed MIDI take. Callbacks remain allocation- and lock-free. Preview
generation remains part of each recording ID so a later take cannot inherit
stale UI history.

Focused live-preview tests passed 16/16; full UI Vitest passed 903 tests across
138 files; TypeScript, production build, lint and diff check passed. Lint has
12 pre-existing warnings in unrelated files. `ResoStage` and
`resostage_engine_tests` built; full CTest passed 1/1. No physical MIDI device
recording test was run. Capture remains intentionally limited to 4,096 CC
events per session, preview to 64 recent/session and 512 globally; do not
describe it as lossless. Raw CC event editing remains open.

### Implementation progress — Piano Roll switch-pedal lanes (2026-10-03)

Piano Roll's bottom-lane selector and renderer now expose individual switch
pedal lanes CC64–69. A bounded projection handles clipped regions and MIDI
loops, preserves a held pedal whose onset predates the visible trimmed start,
aggregates overlapping channels until all active channels release, and displays
transitions/spans without modifying event data. Rendering stops after 16,384
source events, 12,000 mapped events, or 1,200 loop passes, and labels the view
as limited rather than presenting an incomplete scan as full.

Focused tests passed 10/10; the full UI suite passed 845 tests across 128 files;
TypeScript, changed-file lint, production build and `git diff --check` passed.
No device or manual visual test. Arbitrary CC lanes and direct pedal-event
editing remain open.

### Implementation progress — all persisted MIDI CC and pitch-bend lane previews (2026-10-03)

Piano Roll now derives nonstandard CC choices from the selected region rather
than crowding every project's picker with 128 choices. Common modulation,
expression and switch-pedal lanes remain available. The selected lane previews
raw MIDI CC value events; pitch bend is decoded as 14-bit bipolar data. Events
are mapped through the shared MIDI region trim/loop timing rules, source scans
are capped at 16,384 events, projected output at 12,000 events, and loop
expansion at 1,200 passes. Truncated views are labeled. Existing CC64–69 held
spans remain the specialized pedal presentation. Raw event data is read-only;
automation-point editing remains an independent region automation target.

Focused projection/canvas/pedal tests passed 14/14; full UI passed 901 tests
across 138 files; TypeScript and production build passed. Lint exited 0 with 12
warnings in unrelated existing files and none in changed files; diff check
passed. No manual visual, hardware playback, or live recording acceptance was
performed. Direct raw CC editing and physical-device live-recording acceptance
remain open; arbitrary-CC live capture/preview is implemented in the block
above.

### Latest continuation — exact plug-in parameter lane identity (2026-10-03)

Plugin Automation now uses the host-provided stable `parameterId` for selection
and new lane creation, and sends the exact owning `stripId` together with the
slot and parameter. Existing-lane lookup is exact to the current chain; legacy
`param:N` lanes retain their explicit index fallback. Complete descriptor
catalogs surface persisted exact-chain lanes whose parameter is no longer
exposed without deleting their data. Truncated catalogs do not claim that a
parameter is absent, and legacy lanes without an owner are reported as
unscoped instead of attached to whichever modal happens to be open.

Focused Plugin Automation panel tests passed 11/11; full UI passed 910/910
across 138 files; TypeScript, production build, changed-file lint and diff
check passed. Real AU/VST3 metadata churn and Core save/reopen/Undo/Redo remain
unverified; see `automation.md` for exact limits.

### Latest continuation — invalidate raw meter cache on project replacement (2026-10-03)

`observeProjectCommandIdentity` now publishes only complete origin/session/
epoch changes. The raw `liveLevels` store subscribes to that identity owner and
clears cached track, bus, click, clip-hold and active-MIDI readings immediately.
This prevents the same stable track ID in a replacement project from showing
the previous project's peak before the next UDP/WS meter frame. Partial
view-filtered snapshots are ignored, and the existing backend-change reset
remains intact.

Focused peak/identity tests passed 22/22; full UI passed 911/911 across 138
files; TypeScript, production build, changed-file lint and diff check passed.
Remote Core reconnect and mounted multi-surface acceptance remain open; see
`performance.md`.

### Latest continuation — ambiguous plug-in parameter identity (2026-10-03)

Core automation binding now rejects duplicate vendor parameter IDs rather than
silently selecting the first sorted descriptor. The Plugin Automation panel
excludes missing/duplicate IDs from new lane targets, warns with counts, and
keeps previously saved ambiguous lanes intact but unbound after complete
metadata. Truncated metadata does not prove absence. Focused panel tests passed
13/13; full UI passed 913/913 across 138 files; TypeScript, production build,
full UI lint and `git diff --check` passed (lint has 12 existing warnings in
unrelated files); native engine build and CTest passed 1/1. No physical vendor
plug-in fixture was run. Continue with `automation.md` and `performance.md`;
do not claim real AU/VST3 metadata-churn acceptance.

### Latest continuation — dense Audio Flow layout budget (2026-10-03)

Signal Flow row ordering now retains exact crossing minimization only when the
estimated pairwise work is at most 50,000 comparisons per score pass. Denser
graphs use a deterministic forward/backward barycentre pass with a linear edge
span score, while the topology cache still bypasses layout for meter/fader
updates. A 160×160/25,600-edge test confirms the bounded path is selected and
layout rows remain deterministic/non-overlapping. Focused tests passed 21/21;
UI typecheck and changed-file lint passed. Full UI and production-build
results are recorded in the handoff entry. This does not cap React Flow's
linear edge rendering or establish visual legibility in a mounted dense graph;
sidechain endpoints/routing remain open.

### Latest continuation — bounded plug-in sidechain path and Signal Flow view (2026-10-03)

Commits `4e124bb7` and `491335ca` add project-format-v12 sidechain slot
bindings, DAG validation/topological order, and a bounded live/offline audio
feed to JUCE auxiliary input buses. The live-host ABI is v11 and transports at
most eight block-sized stereo feeds without callback allocation. Source mute,
solo and automation mute are respected. Per-plugin preset storage/state was
also added in `48817310`; do not repeat that work.

The follow-up Signal Flow change projects separate sidechain edges through
`/api/v1/audio/mixgraph` with exact strip/slot IDs, plug-in label, bus index,
mapping mode and resolved audibility. The diagram renders a dashed,
track-coloured path with a distinct curve when ordinary audio and sidechain
edges share endpoints; focused bus paths include sidechain but exclude MIDI.
This is read-only graph visibility, not route authoring or aux-bus validation.

Verification for the current follow-up: Signal Flow layout/model tests 32/32;
full UI 917 tests / 138 files; TypeScript, production UI build, changed-file
lint, optimized Core/helper build, native CTest 1/1, and diff check passed.
The plugin-presets, sidechain-model/audio and UI-visualization blocks have
separate commits (`48817310`, `4e124bb7`, `491335ca`, and `3ed580f2`).

At this point route authoring and real vendor acceptance were still open. The
route-authoring portion is implemented in the later follow-up below. Remaining
items are slot-aware PDC (ordinary send PDC does not align a plug-in sidechain),
real AU/VST3 sidechain fixtures, active-playback edits, bypass/fault behavior,
and acoustic live/offline parity. No hardware or real sidechain-capable plugin
was exercised. Preserve the last-good graph and unchanged healthy helpers on
route edits; never restart transport as a workaround.

### Follow-up — hosted auxiliary-bus discovery (2026-10-03)

The previous status is superseded for capability discovery only. Live helpers
now publish fixed-capacity per-slot auxiliary input-bus metadata before Ready;
the Core parameter metadata endpoint returns bus index, name, channel count,
enabled state and a truncation flag. Offline/in-process discovery uses the
same metadata model without toggling a bus. The shared-memory ABI is v11.
Focused API tests passed 16/16; full UI passed 917/917 across 138 files;
TypeScript and production UI build passed; optimized Core/helper build and
native CTest passed; changed-file lint and diff check passed. The existing
macOS AU-host fixture exercises the empty-or-populated metadata contract, but
no known sidechain-capable vendor fixture has been tested.

A loading, failed, stale-generation or truncated catalog is inconclusive about
bus support. Exact route authoring, graph-publication results and basic UI
capability validation are now implemented in the follow-up below; preserve
unchanged healthy helpers and transport during route changes.

### Follow-up — undoable hosted sidechain route authoring (2026-10-03)

`POST /api/v1/plugins/slot/sidechain` is a project-epoch-fenced editor
transaction. It publishes the saved route on every plugin slot, validates that
the exact effect instance is loaded and exposes the requested auxiliary bus,
then asks the existing `MixGraph` builder to validate the combined ordinary
and sidechain DAG before beginning project history. Missing sources, unsupported
buses, self-feedback/cycles and feed-limit failures leave history untouched.
Only an explicit JSON `sidechain: null` disconnects; an omitted field is
rejected. Successful set/disconnect participates in Undo/Redo and reports the
matching playback graph revision through the exact result ring.

The plugin-chain modal now exposes sidechain controls for each effect, sourcing
rendered audio/instrument tracks and project buses while excluding MIDI-only,
direct-output, self and duplicate sources. It loads bus capability metadata
for the exact `(stripId, slotId)` and host generation, blocks unconfirmed or
unsupported selections, preserves/displays an unavailable saved route, and
still allows disconnect when a plugin is failed or missing. Route edits are
not optimistically marked as saved.

Focused route/source/API tests pass; the full UI suite has 920 tests passing,
native CTest passes 1/1, optimized Core/helper build, TypeScript, changed-file
lint and production UI build pass. Still open:
slot-aware PDC, real sidechain-capable AU/VST3 fixtures, active-playback
acceptance, bypass/helper-failure behavior, and acoustic live/offline parity.
Do not claim real plug-in sound-path acceptance without a known capable plugin
and captured audio-level evidence.

### Superseding status — slot-aware sidechain PDC (2026-10-03)

The live-host ABI advanced to v12 to publish per-slot latency separately from
the helper pipeline. Core now prepares ordinary-edge, direct-stream, and
sidechain PDC using the destination effect's cumulative upstream slot latency.
Offline rendering shares the same prepared renderer path. Delay allocation is
bounded and stable rings are reused by endpoint/sample-rate/delay identity.

This is not complete for every topology: if a MIDI instrument's generated
audio must be delayed between its generator and a later effect, current PDC
cannot do that. It leaves a late sidechain source uncompensated and reports a
preparation warning. Per-slot main-path delay and real AU/VST3 acoustic
acceptance remain open. See `audio-flow.md` for implementation details and
verification.

### Latest audit update — Piano Roll raw MIDI controller-event edits (2026-10-04)

The previous audit's statement that direct raw CC editing was open is now
superseded. Piano Roll Events mode creates, moves/changes and deletes persisted
MIDI 1.0 CC/pitch-bend channel events, separately from automation points. Its
commit path uses the reliable MIDI-region update, preserves event channel and
other event data, carries pending placeholder-region note/event content, and
waits for authoritative region echo. Loop/trim projection edits source event
identity, and the right edge is treated as exclusive. Focused regression tests
cover pointer gestures, retries/rejections, cancellation, history boundary and
pending region creation. At the time of this audit entry, multi-event editing
was still open; the latest 2026-10-04 handoff continuation supersedes that
item. Remaining gaps are UMP/MIDI 2.0 event authoring, freehand controller
painting (closed by the later 2026-10-04 continuation below), raw-event curve
tools, physical-device acceptance, and manual visual acceptance. See
`automation.md` for implementation detail and remaining edges.

### Latest performance follow-up — bounded controller scan allocation (2026-10-04)

`buildPianoRollControllerProjection()` no longer clones up to 16,384 raw MIDI
events before scanning its fixed cap. A focused regression fails if the source
array is sliced. The bounded selected-event/projected-event allocations remain;
no canvas-frame benchmark or device profiler was run. Focused controller-lane
tests passed 10/10. See the newest `handoff.md` block for full UI verification.

The lane-picker follow-up also removed its own 16,384-event prefix copy:
`collectPianoRollControllerNumbers()` preserves bounded lane discovery while
scanning by index. This is a source-level allocation reduction, not a
frame-time measurement.

### Latest continuation — freehand raw MIDI controller painting (2026-10-04)

Draw-tool drags that begin in empty space in a Piano Roll Events lane now paint
an interpolated MIDI 1.0 CC or pitch-bend line. Sample positions follow the
current snap; snap-off painting uses a deterministic 1/32-beat spacing. Each
segment is capped at 256 samples and one gesture can touch at most 1,024 events.
The active-lane/channel beat index is built once at pointer-down, not rescanned
for every pointer move. Source events are upserted at source beats, so crossing
a MIDI loop updates/reuses loop-source points rather than creating duplicate
events. Channels and trailing event bytes are preserved. Pointer-up uses the
existing single reliable MIDI-region update/history path; cancel discards the
draft. Selection follows the points affected by the gesture.

Focused controller/gesture tests passed 26/26; full UI Vitest passed 954 tests
across 143 files; `tsc -b`, production UI build and repository lint passed.
Lint reported 12 warnings in existing files; none were in files changed by
this block. `git diff --check` passed. No manual Electron/device acceptance or
frame-time profiling was performed. Remaining raw-event gaps are curve tools,
MIDI 2.0 UMP authoring, and visual/physical-device acceptance.

### Latest continuation — multi-event raw MIDI editing (2026-10-04)

Piano Roll Events lanes now support Shift/platform-primary toggle selection,
active-lane Select All, rigid group movement and Delete for raw MIDI 1.0 CC and
pitch-bend events. Group movement preserves beat offsets, channels and extra
event bytes and clamps the selection as a whole to the region or loop source
window. Delete is sent through the reliable MIDI-region event transaction.
The new `usePianoRollControllerEventSelection` hook owns selection invalidation
and lane-aware Delete/Select All behavior separately from component composition.
Selection uses bounded source-array indexes, not stable event IDs; it clears at
history/identity/lane/mode boundaries and when authoritative data changes at a
selected index. Lists above 16,384 events fail closed for these edit actions.

Verification: full UI Vitest passed 947 tests across 143 files; production
build, TypeScript, full lint (exit 0; 12 pre-existing warnings) and
`git diff --check` passed. The focused controller/gesture/lifecycle set passed
27/27 after the malformed-lane, invalid-loop and read-only selection guards.
No physical MIDI device or manual visual acceptance was performed. Remaining
raw-event gaps are freehand painting, curve tools and MIDI 2.0 UMP authoring.

### Latest continuation — MIDI controller curve and smoothing tools (2026-10-04)

Selected MIDI 1.0 CC and pitch-bend Events-lane points can now be shaped to a
linear, curve-up or curve-down value trajectory, or smoothed with two bounded,
time-weighted passes. The shared curve evaluator is also used by Timeline
automation interpolation, keeping the curve law consistent. Event beat,
channel, trailing bytes and unselected events are preserved. Pedal switch CC64–69
are deliberately excluded from curve/smoothing transforms so binary pedal
states are not turned into invalid intermediate values. Changes use the
existing reliable MIDI-region event transaction and therefore one history edit.

Focused controller, hook and Timeline-curve tests passed 51/51; full UI Vitest
passed 959 tests across 143 files; `tsc -b` and production UI build passed.
Repository lint exited 0 with 12 existing warnings outside changed files;
`git diff --check` passed. No manual visual, hardware or performance-profile
acceptance was performed. Remaining Piano Roll MIDI 2.0 UMP authoring and
manual/device acceptance are open; continue with the next item in `handoff.md`.

### Latest continuation — MIDI 2.0 UMP controller preview (2026-10-04)

The Piano Roll lane picker now discovers well-formed MIDI 2.0 Channel Voice
Control Change and channel Pitch Bend packets stored in `umpEvents`. Separate
MIDI 2.0 lanes render them through the current trim/loop projection and display
their 32-bit values using the existing 7-bit/14-bit visual range. This display
scaling is not written back: the source packet words remain unchanged. Reserved
compound CCs, MIDI 1.0 UMP packets and unknown UMP types are not mislabelled as
ordinary MIDI 2.0 CCs; the lane is deliberately read-only until exact-UMP edit
transactions exist.

Focused controller/UMP preview tests passed; full UI Vitest passed 961 tests
across 143 files; TypeScript and production build passed. Repository lint exited
0 with 12 existing unrelated warnings; `git diff --check` passed. This does not
verify preview appearance on a physical display or UMP output to native MIDI
2.0 endpoints, which remain unsupported.

### Latest continuation — MIDI 2.0 controller editing (2026-10-04)

The Piano Roll's MIDI 2.0 toolbar action now opens a demand-loaded semantic
editor for recognized Channel Voice CC and channel Pitch Bend UMP packets. It
adds, edits, and removes packets using source beat, group, channel, CC index,
and the exact unsigned 32-bit value. It only changes those selected semantic
fields. Unknown, malformed, and reserved compound CC packets remain untouched.
If the source region changes while the dialog is open, Save is disabled until
the editor reloads the authoritative snapshot.

`usePianoRollUmpEventDraft` uses the shared typed
`usePianoRollReliableCollectionDraft` lifecycle also used for MIDI 1.0 event
drafts. HTTP admission stays separate from authoritative Core echo; rejected
drafts support explicit retry/discard and stale sessions retire at history/
project boundaries. Region mutations carry `umpEvents`
through existing updates and provisional-region creation/follow-up, without
merging MIDI 1.0 `events` and UMP.

Focused packet/editor/draft/mutation tests passed 49/49; full UI Vitest passed
976 tests across 146 files. TypeScript, production build, lint and `git diff
--check` passed. Lint still has 12 unrelated existing warnings. No native UMP
device or manual Electron visual acceptance was done. Group/channel-specific
canvas lanes, direct value gestures, broader codec fixtures and native UMP
transport remain open.

### Latest continuation — UMP preview group/channel filters (2026-10-04)

The recognized MIDI 2.0 CC/Pitch Bend preview lanes now have independent
Group and Channel selectors. Both default to All; available choices are
discovered by a bounded scan of only valid packets for the selected lane.
Changing Group clears Channel, and deleting/replacing the source data clears a
filter whose group/channel no longer exists. Filtering is applied before the
existing region trim/loop projection and does not edit or reconstruct packets.
Reserved compound CCs, malformed packets and unsupported UMP remain excluded.

Verification: focused controller-lane tests passed 24/24; full UI Vitest passed
977 tests across 146 files; TypeScript, staged production build and
`git diff --check` passed. Repository lint exited successfully with 12 existing
warnings, none in changed files. No manual Electron visual or physical UMP
device acceptance was performed. Direct 32-bit lane gestures, multi-event
selection/curve tools, codec conformance fixtures and native UMP transport
remain open.

### Latest continuation — direct Piano Roll UMP point gestures (2026-10-04)

Recognized MIDI 2.0 CC/Pitch Bend lanes now support Draw-to-create, direct
point movement/value edits, Shift/platform-primary multi-selection, group
movement, Erase, double-click removal, Select All and Delete. Gesture previews
stay in the UMP collection and commit through the exact UMP region draft; they
never convert into MIDI 1.0 channel events. Trim/loop display occurrences map
back to their source beat. Horizontal movement preserves the original data
word exactly; vertical edits map pointer position across the full 32-bit UMP
range. Newly drawn packets can be dragged before the first commit. The existing
group/channel filters constrain selection and creation; unsupported/reserved
packets remain unchanged. Oversized source collections reject before copying.

Pointer-frequency change detection compares only selected stable source
indices rather than sorting the whole UMP collection on every move. The
collection and projected events remain bounded by the existing 16,384 source,
12,000 projected-event and 1,200 loop-pass caps. This is a bounded source-level
design; no frame-time benchmark was performed.

Focused controller/gesture/UMP draft checks passed 29/29; full UI Vitest passed
992 tests across 146 files; `tsc -b`, staged production UI build, lint and
`git diff --check` passed. Lint still reports 12 existing warnings outside
changed files. No manual Electron visual or native UMP-device acceptance was
performed. Remaining: UMP curve/smoothing transforms, range marquee and raw
event cut/copy, codec conformance fixtures, native UMP endpoint transport and
physical/manual acceptance. This does not establish end-to-end MIDI 2.0 support.

### Latest continuation — Piano Roll UMP curves and smoothing (2026-10-04)

The recognized MIDI 2.0 CC/Pitch Bend lanes now expose the same bounded curve
and smoothing actions as raw MIDI 1.0 controller events. Selection is validated
against the active lane and Group/Channel filters, then grouped independently
by UMP Group and MIDI Channel. Curve shaping evaluates each interior point
against its group's fixed endpoint values using the shared Timeline curve law;
smoothing uses two time-weighted passes and preserves endpoints. Both operate
on the complete unsigned 32-bit data word, retain beat/header/trailing words,
and leave unselected and opaque packets untouched. CC64–69 are excluded as
binary pedal controls. Successful changes use the reliable UMP collection
draft and existing exact MIDI-region history mutation, not the MIDI 1.0 event
path. Invalid, stale-filter, duplicate, oversized and no-op inputs fail closed.

Focused UMP-transform and packet-edit tests passed 18/18; full UI Vitest passed
999 tests across 147 files; `tsc -b`, production UI build, lint and
`git diff --check` passed. Lint still reports 12 existing warnings outside the
changed files. No manual visual, physical-device or frame-time acceptance was
performed. Remaining UMP editor work includes range marquee and raw event
cut/copy; codec conformance, native UMP transport and end-to-end MIDI 2.0
compatibility remain open.

### Latest continuation — UMP controller marquee selection (2026-10-04)

Select-tool drags over a MIDI 2.0 CC/Pitch Bend controller lane now draw a
canvas-space marquee and select enclosed source packet indexes. Candidate
coordinates are captured once from the bounded visible Piano Roll projection;
pointer movement scans at most the existing 12,000 projected-point cap and
publishes selection only when its source-index set changes. The active
Group/Channel filters and loop projection are respected; repeated loop views
deduplicate to their original UMP event index. Shift or the platform primary
modifier makes the drag additive. Selection does not copy, mutate or submit UMP
data; pointer-up remains a selection-only interaction. The selection box is
drawn over the controller lane using the editor accent color.

Focused marquee/gesture tests passed 25/25; full UI Vitest passed 1,006 tests
across 148 files; TypeScript, production UI build, lint and `git diff --check`
passed. Lint reports 12 existing warnings outside this change. No manual
visual, physical-device or frame-time acceptance was done. UMP range marquee
and internal cut/copy/paste now exist; codec conformance, native UMP transport
and full MIDI 2.0 compatibility remain open.

### Latest continuation — UMP controller cut/copy/paste (2026-10-04)

Piano Roll now supports internal cut/copy/paste for selected recognized MIDI
2.0 CC/Pitch Bend points. The clipboard stores exact packet words, lane,
relative source-beat offsets and span; Group/Channel filters are checked both
when copying and pasting. It is a bounded module clipboard that survives editor
unmounts, not an OS clipboard. Paste uses the current playhead translated by
`midiRegionSourceBeat`; when the target MIDI region loops, offsets wrap into
its `[loopStartBeats, loopStartBeats + loopLengthBeats)` source window. Invalid,
oversized or filter-incompatible operations fail closed. Cut and paste submit
one full UMP collection through the reliable event draft and exact region
history path; successful paste selects the appended source indexes. MIDI 1.0
event and UMP collections stay separate.

Focused clipboard/hook/transform tests passed 19/19; the full UI suite passed
1,018 tests across 150 files. UI TypeScript and production build passed; lint
passed with 12 pre-existing warnings outside this change, and `git diff
--check` passed. No Electron/device visual acceptance has been run. Continue
with MIDI Clip File conformance fixtures, then evaluate remaining UMP editor
and native transport gaps; do not claim end-to-end MIDI 2.0 compatibility.

### Latest continuation — MIDI Clip File framing and bounded export (2026-10-04)

The `.midi2` parser now rejects duplicate/missing DCTPQ, requires its preceding
zero-delta DCS and requires DCTPQ before Start of Clip. Start and End markers
must have a preceding DCS, are single/ordered, and End must be the final UMP
packet. Retained UMP events are capped at 200,000 independently of the total
packet-work cap. Export uses the same 200,000-event bound while collecting
events, including loop expansion; valid source items are filtered once before
loop expansion, preventing repeated scans of muted/out-of-window data. Existing
long-gap DCS/NOOP writer logic now has a round-trip regression.

Focused MIDI Clip/SMF tests passed 27/27; full UI Vitest passed 1,024 tests
across 151 files. TypeScript and production build passed; lint passed with 12
pre-existing warnings outside the changed files; `git diff --check` passed.
The framing assertions follow MIDI Clip File Specification v1.0, sections 3,
6 and 7: <https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf>.
Still open: an independently sourced fixture corpus covering profile/config
messages, SysEx, Flex Data and wider UMP packet edge cases; cross-DAW round-trip
acceptance; note-ID/note-off-attribute model limitations; and native UMP I/O.

### Latest continuation — MIDI Clip sequence timing origin (2026-10-04)

MIDI Clip File packet timestamps before Start of Clip are configuration-header
timing, not musical sequence offsets. The parser now records the tick at Start
and normalizes all sequence events and End duration against it. Configuration
packets are retained at beat zero; recognized tempo/meter Flex Data before
Start is interpreted at beat zero, and pre-Start note-shaped packets are not
paired into Piano Roll notes. The project model still has no distinct
configuration-header timeline, so exact setup-message timing/order is not
round-tripped as a separate section.

The regression uses nonzero configuration pre-roll, a setup Program Change,
tempo Flex Data, and a MIDI 2.0 note pair. It verifies beat-zero configuration,
the note's sequence-relative start/duration, and sequence-relative clip end.
Focused MIDI Clip tests passed 7/7; full UI passed 1,025 tests across 151
files; TypeScript/production build passed; lint exited 0 with 12 existing
warnings outside changed files; `git diff --check` passed. Source rule follows
MIDI Clip File Specification v1.0 sections 6–7; broader independent
configuration/profile, SysEx and Flex Data interoperability fixtures remain
open. Do not claim complete MIDI Clip or end-to-end MIDI 2.0 conformance.

### Latest continuation — MIDI Clip configuration tempo/meter conformance (2026-10-04)

The parser now validates configuration-header Set Tempo/Set Time Signature
separately from sequence events. It rejects duplicate configuration tempo or
meter messages, a configuration tempo that is not the first event after DCTPQ,
a time signature not immediately following that tempo, and these messages
before DCTPQ. Profile-prefix packets before DCTPQ are not counted as ordinary
configuration-header events. Sequence tempo changes remain unrestricted by
the configuration-header cardinality rules. This follows the mandatory
configuration rules in MIDI Clip File Specification v1.0 sections 6.1.1–6.1.2:
<https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf>.

Tests cover valid configuration tempo/meter, duplicate and out-of-order
configuration messages, and multiple sequence tempo changes. Focused parser
tests passed 9/9; full UI passed 1,027 tests across 151 files. Run the
production build, lint and diff check before committing; do not infer broad
MIDI-CI profile or SysEx interoperability from these structural checks.

Verification completed: UI TypeScript/production build passed; repository lint
exited 0 with 12 existing warnings outside changed files; `git diff --check`
passed. No third-party profile/configuration or SysEx fixtures were available.

### Latest continuation — MIDI Clip configuration-section round-trip (2026-10-04)

Project format v13 now persists whether opaque UMP events are receiver
configuration or ordinary sequence data, plus whether an unclockstamped
SysEx7 packet belongs to the profile prefix. Import/export restores the profile
prefix before DCTPQ and receiver setup after DCTPQ/before Start. Configuration
events retain source order and are not trim-shifted or loop-expanded. Piano
Roll CC/Pitch Bend discovery/editing excludes these packets; optional false and
absent flags compare equal in draft reconciliation.

The parser preserves shared DCS semantics: one DCS may time multiple following
UMP packets. Configuration tempo/meter may inherit DCTPQ's preceding zero DCS
or use another zero DCS; nonzero timing is rejected. This block does not decode
or negotiate MIDI-CI Profile payloads and still flattens elapsed config timing
to beat zero. Focused codec/editor tests passed 50/50, full UI passed 1,033/1,033
across 151 files, TypeScript and production UI build passed, lint passed with
12 existing unrelated warnings, and `git diff --check` passed. Native schema
v13/Core tests were completed with the prior stage-A commit `4f99049e`. Keep
independent profile/SysEx references open and do not push.

### Latest continuation — simultaneous MIDI Clip event order (2026-10-04)

Project format v15 retains the source packet index on MIDI 2.0 note attacks,
note releases and opaque UMP sequence events. The index survives Core JSON
save/load and telemetry; Piano Roll draft reconciliation includes it so an
authoritative acknowledgement cannot silently erase provenance. MIDI Clip
export compares events at the rounded final TPQ tick, then preserves imported
source order for ties. New events and loop-expanded occurrences use the
deterministic Off-before-On fallback; stale imported indices are not reused at
cycle boundaries. Missing and out-of-range values normalize to `-1`, including
direct Core loads and the v14-to-v15 migration.

Tests cover mixed raw UMP/note-edge ordering, overlapping same-pitch attributes,
loop-boundary retrigger ordering, project JSON round-trip/default/invalid
values, and migration. MIDI Clip codec tests passed 18/18; migration tests
9/9; the full UI passed 1,039/1,039 across 151 files; TypeScript, production
build, changed-file lint, Core RelWithDebInfo build, CTest (1/1 target), and
`git diff --check` passed.

Explicit limits: ordering of Set Tempo/Set Time Signature Flex Data is still
normalized into project maps rather than retaining original interleaving.
Independent profile/configuration reference files, broader SysEx and malformed
packet corpus, MIDI-CI, physical UMP I/O, SMF2 Container, and full UMP plug-in
playback remain open. Do not call this full MIDI 2.0 compatibility.

### Latest continuation — MIDI 2.0 note-edge fidelity (2026-10-04)

Project format v14 now stores separate MIDI 2.0 Note-On and Note-Off Attribute
Type/Data fields. The MIDI Clip parser preserves both edges and treats type-4
MIDI 2.0 Note On with zero velocity as Note On; type-2 MIDI 1.0 UMP retains its
zero-velocity Note-Off convention. Pairing uses Group/Channel/Note Number and
FIFO for repeated overlapping identical keys; attribute payload is not used as
a note ID. MIDI Clip export writes independent release fields. MIDI 1.0 loss
report now warns for release-only note attributes.

Project migration v13 -> v14 copies the prior Note-On pair into the new release
pair. Direct Core loading of old v13 JSON has the same fallback, and older UI
clients omitting the fields get the compatibility default. Future unknown
formats are refused before backup or modification. Coverage includes codec
round-trip, protocol zero-velocity distinction, overlap pairing, Piano Roll
acknowledgement equality, C++ project JSON round-trip/legacy fallback, and CLI
migration/no-touch future-version behavior.

Validation: focused UI 54/54; full UI 1,037/1,037 across 151 files; TypeScript
and production UI build passed; changed-file lint passed; migration tests 7/7;
Core RelWithDebInfo build and CTest passed (1/1 test target). `git diff --check`
passed. This is file/project fidelity only: live UMP devices, MIDI-CI, SMF2
Container, full UMP playback, and MIDI 1.0 plug-in adaptation gaps remain open.
Do not claim full MIDI 2.0 compatibility and do not push.

### Latest continuation — MIDI 1.0 export of configuration setup (2026-10-04)

Standard MIDI File export now converts representable MIDI Clip receiver setup
Channel Voice packets into track-start events, outside region trim and loop
expansion. Unsupported profile-prefix SysEx7 stays excluded and is counted by
the existing loss report. Regression covers setup and sequence Program Changes
in a trimmed loop region. Focused Standard MIDI/MIDI Clip tests passed 35/35,
full UI passed 1,034/1,034 across 151 files, TypeScript and production build
passed, lint passed with 12 unrelated existing warnings, and diff check passed.
This is not a general UMP-to-MIDI 1.0 translator.

### Latest continuation — MIDI Clip configuration-section round-trip (2026-10-04)

Project format v13 now persists whether opaque UMP events are receiver
configuration or ordinary sequence data, plus whether an unclockstamped
SysEx7 packet belongs to the profile prefix. Import/export restores the profile
prefix before DCTPQ and receiver setup after DCTPQ/before Start. Configuration
events retain source order and are not trim-shifted or loop-expanded. Piano
Roll CC/Pitch Bend discovery/editing excludes these packets; optional false and
absent flags compare equal in draft reconciliation.

The parser preserves shared DCS semantics: one DCS may time multiple following
UMP packets. Configuration tempo/meter may inherit DCTPQ's preceding zero DCS
or use another zero DCS; nonzero timing is rejected. This block does not decode
or negotiate MIDI-CI Profile payloads and still flattens elapsed config timing
to beat zero. Focused codec/editor tests passed 49/49, full UI passed 1,032/1,032
across 151 files, TypeScript and production UI build passed, lint passed with
12 existing unrelated warnings, and `git diff --check` passed. Native schema
v13/Core tests were completed with the prior stage-A commit `4f99049e`. Keep
independent profile/SysEx references open and do not push.

Latest verified continuation — MIDI-CI profile-prefix validation (2026-10-04):
the MIDI Clip parser now accepts pre-DCTPQ SysEx7 only when its complete UMP
fragment stream identifies a MIDI-CI Set Profile On message. The writer applies
the same bounded validation to profile-flagged packets. Payload bytes remain
opaque and preserved; there is no profile negotiation or semantic decoding.
Focused codec tests passed 22/22, including valid fragmented round-trip,
configuration-only region preservation, rejecting Set Profile Off, incomplete
streams, timestamped profile data, and Property Exchange exclusion. The full
UI passed 1,043/1,043 across 151 files; TypeScript and production build passed;
migration tests 9/9; Core test target build and CTest passed (1/1);
changed-file lint and `git diff --check` passed. Rules follow MIDI Clip File
v1.0 sections 6–7, MIDI-CI v1.2
section 7.8, and UMP SysEx7 v1.1.1. Live MIDI-CI and broad reference
interoperability remain open. Do not claim full MIDI 2.0 compatibility.

Latest continuation — MIDI-CI Property Exchange sequence exclusion
(2026-10-04): per MIDI Clip File v1.0 §7.2, import and export reject MIDI-CI
Property Exchange SysEx7 packets in sequence data while ordinary SysEx7 stays
allowed. The detector carries the 4-byte discriminator across same-Group
Start/Continue/End packets; SysEx7 count, data bytes, padding and message
framing are checked on both paths. Tests cover a discriminator split across
packets, ordinary SysEx passthrough, and broken sequence framing. Focused codec
tests 22/22, full UI 1,043/1,043 (151 files), TypeScript, build and changed-file
lint passed. Sources: [MIDI Clip File v1.0 §7.2](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf),
[MIDI-CI Property Exchange v1.1 §§1.7, 3.1](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-103-UM_v1-1_Common_Rules_for_MIDI-CI_Property_Exchange.pdf),
and UMP SysEx7 v1.1.1. No live MIDI-CI negotiation is implemented.

### Latest continuation — preserve MIDI Clip JR Utility packets (2026-10-04)

The MIDI Clip parser previously discarded all Message Type 0 Utility packets
after DCS/DCTPQ, including JR Clock and JR Timestamp. It now retains JR timing
packets as ordered opaque UMP events in configuration and sequence data. The
project timeline remains DCS-based; JR sender-clock time is not interpreted or
used for live scheduling. NOOP is validated and consumed as the DCS long-gap
reset aid. The parser rejects nonzero Utility Group reserved bits and invalid
reserved fields for DCTPQ, NOOP, JR Clock, and JR Timestamp. Writer round-trip
coverage verifies JR words/order, and malformed fixtures cover each defined
reserved field. Focused MIDI Clip tests passed 24/24; full UI passed 1,045/1,045
across 151 files; TypeScript/production build and changed-file lint passed;
`git diff --check` passed. Rules follow [UMP & MIDI 2.0 Protocol v1.1.1
§§2.1.3 and 7.2–7.2.3](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).
This preserves data only, not JR-clock playback semantics. Do not claim full
MIDI 2.0 compatibility or push.

### Latest continuation — MIDI Clip timing Flex Data validation (2026-10-04)

Audited Set Tempo/Set Time Signature Flex Data against UMP & MIDI 2.0 Protocol
v1.1.1 §§7.5.3–7.5.4. Parsing now validates format 0, address 1 (Group),
reserved channel zero, nonzero tempo units, and zero reserved data. Time
signature exponent 1–7 is normalized to denominator 2–128. Exponent 0 (the
protocol's non-standard denominator marker) and unsupported larger exponents
are kept as opaque UMP. An opaque non-standard meter originally in the receiver
configuration header is moved to sequence beat zero so exporting the normalized
tempo plus that meter cannot produce a configuration header missing its paired
tempo. Export rejects invalid/unrepresentable project meters rather than
silently dropping them or wrapping a numerator.

The specification states numerator 1–256 in an 8-bit field; interpreting raw
zero as 256 is explicitly an implementation inference pending a reference-file
fixture. Supported time-signature packets still lose their Number of 1/32 Notes
metadata, which the exporter defaults to 8. Import does not yet validate that
Set Tempo occurs at a 1/24-quarter boundary or that Set Time Signature occurs
at a bar boundary. Focused codec tests passed 27/27, full UI passed 1,048/1,048
across 151 files, UI TypeScript/production build and changed-file lint passed,
and `git diff --check` passed. Do not claim complete MIDI Clip/Flex Data
conformance.

### Latest continuation — MIDI Clip boundary-marker validation (2026-10-04)

Start/End of Clip messages are now checked as complete UMPs (`Form=0`) with
zero reserved low bits and zero remaining data words. Previously, parser
accepted any form/payload if status was `0x20`/`0x21`. Added malformed fixtures
for multipart form and nonzero reserved data on both boundaries. Focused
MIDI Clip tests passed 28/28; full UI passed 1,049/1,049 across 151 files;
TypeScript/production build, changed-file lint and `git diff --check` passed.
Basis: [UMP & MIDI 2.0 Protocol v1.1.1 §7.1.10–7.1.11 and Appendix F]
(https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).
Timing placement and cross-application fixtures remain unverified; do not claim
complete MIDI Clip interoperability.

### Latest continuation — Set Time Signature output precision (2026-10-04)

Confirmed the format distinguishes the recommended timing grids: Set Tempo
sequence messages should land on MIDI Clock positions (1/24 quarter); Set Time
Signature changes should land at bar boundaries. The writer had incorrectly
rounded both to 1/24, shifting a valid 1/128 bar boundary at 1/32 beat to 1/24.
Set Time Signature now rounds to the output DCTPQ tick grid; a round-trip test
checks 1/32 beat exactly. The writer remains fixed at 960 TPQ, so finer input
positions are still rounded; dynamic TPQ and bar-boundary validation remain
open. This placement is a `should` recommendation, not a reason to reject
otherwise preservable imports. Focused codec tests passed 29/29; full UI passed
1,050/1,050 across 151 files; TypeScript/production build, changed-file lint
and `git diff --check` passed. Sources: [MIDI Clip File v1.0 §7.1.2]
(https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf),
[UMP & MIDI 2.0 Protocol v1.1.1 §§7.5.3–7.5.4]
(https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

### Latest continuation — MIDI Clip DCTPQ and gap resource bound (2026-10-04)

DCTPQ increased from 960 to 65,280 (the highest multiple of 960 not exceeding
the protocol's 65,535 maximum). This retains the quarter-note/MIDI-Clock grid
and common 960-PPQ positions at finer resolution. With the shorter per-DCS
span, a valid sparse file may contain multiple DCS/NOOP resets per retained
event. Parser and writer now share an 800,016 UMP packet ceiling; the exporter
preflights reset expansion and safe integer tick conversion, avoiding
pathological time gaps that previously could loop for an unbounded period.
Tests verify the DCTPQ word, a 20-beat DCS/NOOP round-trip, and fast rejection
of a gap exceeding budget. Focused MIDI Clip tests passed 30/30; full UI passed
1,051/1,051 across 151 files; TypeScript/production build, changed-file lint
and `git diff --check` passed. Standard: [UMP & MIDI 2.0 Protocol v1.1.1
§7.2.3.1](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

### Latest continuation — preserve MIDI time-signature notation field (2026-10-04)

The MIDI 2.0 Set Time Signature Number of 1/32 Notes byte was being discarded
when recognized meter Flex Data was normalized into project signature points.
It now survives MIDI Clip and Standard MIDI File import/export, import-time
song meter updates, Core project JSON, builder updates and telemetry as
`SignaturePoint::thirtySecondsPerQuarter` (default 8, byte range 0–255). It is
metadata only and does not change `SignatureMap` bar arithmetic. Core round-trip,
MIDI Clip and SMF tests cover non-default values. Focused MIDI codec tests
53/53; full UI 1,052/1,052 across 151 files; Core engine tests and full
`ResoStage` target build passed. The loss item is resolved; off-grid timing
recommendations and independent DAW fixtures remain open.

### Latest continuation — require immediate DCS before MIDI Clip NOOP (2026-10-04)

The parser accepted NOOP after a JR Utility packet because it checked for any
earlier DCS, even though the file specification describes the DCS/Null reset
as an adjacent pair. It now rejects a NOOP unless the immediately preceding
packet is DCS; a malformed sequence fixture covers the stale-DCS case. Focused
MIDI Clip tests 31/31; full UI 1,052/1,052 across 151 files; TypeScript/build,
changed-file lint and `git diff --check` passed. Basis: [MIDI Clip File v1.0
§3.2.2](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf).

### Latest continuation — reject lossy MIDI Clip Set Tempo clamping (2026-10-04)

The writer previously clamped out-of-range BPM to the nearest representable
32-bit 10-nanosecond time-per-quarter-note value, silently changing tempo. It
now rejects invalid tempo events and rejects conversion when rounded units are
outside `1..0xFFFFFFFF`. Tests cover the slowest/fastest representable endpoint,
out-of-range BPM on both sides, and malformed supplied event data. Tempo
placement remains quantized to 1/24 quarter note as required by the protocol.
Focused tests 31/31; full UI 1,052/1,052 across 151 files; TypeScript/build,
changed-file lint and `git diff --check` passed. Reference: [UMP & MIDI 2.0
Protocol v1.1.1 §7.5.3](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

### Latest continuation addendum — preserve same-tick MIDI note edges (2026-10-04)

MIDI Clip and Standard MIDI File codecs previously replaced matched zero-tick
Note On/Off pairs with a positive minimum duration. The importers, tempo
adapters, Core Builder, live scheduler, offline renderer, and Piano Roll now
preserve and handle zero-duration notes without widening them. Same-sample
attack/release ordering is explicit; ordinary retriggers still release the
older note first. Focused UI tests passed 73/73; full UI passed 1,055/1,055
across 151 files; Core CTest passed 1/1; the main `ResoStage` target compiled;
TypeScript/production build, changed-file lint, and `git diff --check` passed.
A receiver may not make an audible sound from a zero-length gate. Independent
external DAW fixtures are still needed.

### Latest continuation — preserve open-note duration to Clip end (2026-10-04)

MIDI Clip import now gives a Note On without a matching Note Off the duration
from its start timestamp to End of Clip, not a fabricated 1/64 beat. This is
consistent with the existing Standard MIDI File import behavior. An attack at
the clip boundary stays zero-duration. Focused MIDI Clip tests passed 33/33;
full UI passed 1,056/1,056 across 151 files; TypeScript/production build,
changed-file lint and `git diff --check` passed. The editable note schema
represents attack/release pairs, so exporting this normalized note adds a
matching Note Off; it is not byte-identical preservation of the unmatched
source event. Keep testing file-codec and native scheduling edge cases, and do
not claim complete cross-DAW MIDI 2.0 interoperability.

### Latest continuation — isolate mixed-protocol note edges (2026-10-04)

MIDI Clip note pairing is scoped by UMP message type as well as Group, Channel
and note number. Message Types 0x2 and 0x4 are distinct Channel Voice
protocols; the official spec forbids a device from mixing them within one
Group. A malformed/legacy file containing a cross-type release is now kept as
an opaque UMP event rather than incorrectly closing the other protocol's note.
Both mismatch directions have a regression fixture. Focused MIDI Clip tests
passed 34/34; full UI passed 1,057/1,057 across 151 files; TypeScript/production
build, changed-file lint and `git diff --check` passed. Reference: [UMP
and MIDI 2.0 Protocol v1.1.1 §§3.2.1, 3.3.1 and 7.4]
(https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

### Latest continuation — cover the complete UMP packet-width table (2026-10-04)

A table-driven codec fixture now exercises all 16 UMP Message Types with their
specified one-, two-, three-, or four-word packet sizes, including reserved
types whose widths are preallocated. It checks raw packet words and widths
through MIDI Clip import/export; it does not claim semantic support for
reserved types. Focused MIDI Clip tests passed 35/35. Source: UMP and MIDI 2.0
Protocol v1.1.1 Table 4. Continue validating semantic field bounds and file
round-trip edge cases, not merely framing.

### Audit — SMF 0x58 metronome-click interval loss (2026-10-04)

Confirmed a silent metadata-loss path: parsing SMF time signatures kept the
`bb` 1/32-notes-per-quarter field but discarded `cc` MIDI Clocks per
Metronome Click. The project could not preserve the value and MIDI 2.0 Clip
export has no equivalent field. Added an optional persisted project property,
defaults and byte-range validation, wired it through project JSON, the Core
Builder, Web state and telemetry, and preserved it through SMF import/export
and imported tempo-map adoption. Legacy JSON defaults to 24. The MIDI Clip
export dialog now reports selected non-default click intervals and requires
confirmation before loss. Malformed/short SMF timing meta events are retained
as raw channel-track data. Regression coverage includes an older project
without the field, non-default round-trip, and selection-aware loss reporting.
Verification passed: SMF tests 28/28, UI 1,063/1,063 across 151 files, Core
CTest 1/1, native `ResoStage` build, TypeScript and UI production build.

### Audit — zero-velocity MIDI 2.0 Note On export warning (2026-10-04)

UMP MIDI 2.0 allows velocity zero on Note On without treating it as Note Off;
the MIDI 1.0 default translator must replace a converted zero velocity with 1.
The `.mid` writer already did that, but the loss report equated source zero
with translated zero and omitted the conversion from consent. Added a separate
`zeroVelocityNoteOns` count and explicit dialog copy; ordinary 7-bit velocity
quantization stays separately counted. The export acceptance fingerprint now
tracks the selected loss summary and exact selected meter fields so changed
loss data clears stale consent while unrelated telemetry changes do not.
Regression test verifies both warning and output note attack. Focused SMF
29/29; full UI 1,064/1,064 across 151 files; TypeScript/production build and
changed-file lint passed. Basis: [UMP & MIDI 2.0 Protocol v1.1.1 §7.4.2]
(https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

### Latest continuation — MIDI 1.0 event and Program Change translation (2026-10-04)

Standard MIDI export now converts valid MIDI 2.0 Program Change UMPs to one
MIDI 1.0 Program Change when Bank Valid is clear, or the required ordered
CC 0 / CC 32 / Program Change sequence when it is set. Reserved option and
bank/program bits are validated; invalid packets are reported as unsupported
instead of being silently masked. MIDI 1.0 event import into MIDI Clip also
converts channel voice, supported System Common/Real-Time messages, and
complete/fragmented SysEx7 in both directions. Ambiguous orphan F7 escapes,
incomplete SysEx, unsupported raw events, and nonzero Group data are reported
before lossy export. MIDI Clip has no MIDI 1.0 group field. Focused MIDI codec
tests passed 72/72; full UI passed 1,072/1,072 across 151 files; TypeScript,
production build, changed-file lint, and `git diff --check` passed. References:
[UMP & MIDI 2.0 Protocol v1.1.1 §§7.4.9, 7.6–7.7, D.2.4, D.3.4]
(https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).
No MIDI-CI negotiation, SysEx8/Mixed Data Set conversion, arbitrary UMP
translation, or cross-DAW certification is implied.

### Latest continuation — fold MIDI 1.0 Bank Select into MIDI 2.0 Program Change (2026-10-04)

MIDI 1.0 CC 0/32 are now tracked per channel within each source region and
folded into the next valid Program Change as one MIDI 2.0 Program Change with
Bank Valid set. A later Program Change without a new bank select emits
Bank Valid clear. Standalone/unmatched bank selects and special compound CCs
(RPN/NRPN and High Resolution Velocity Prefix) are counted as unrepresentable
instead of being mislabeled as ordinary MIDI 2.0 CCs. Bank state is not shared
between separate DAW regions yet. Focused MIDI codec tests passed 74/74; full
UI passed 1,074/1,074 across 151 files; TypeScript, production build,
changed-file lint, and `git diff --check` passed. Basis: [UMP & MIDI 2.0
Protocol v1.1.1 §§D.3.3–D.3.4](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).
