# Post-completion audit and continuation contract

Updated 2026-10-02. Start here, then read the complete `AGENTS.md` and inspect
`git status`/recent commits. This audit supersedes completion claims in older
task snapshots. Do not repeat finished implementation or overwrite concurrent
work. Commit each verified block in English; do not push.

UI entry paths abbreviated as `timeline/...` below are relative to
`ui/src/screens/editor/`. Core paths are repository-relative.

## Evidence and limits

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
  edits.
- Media import begin tickets preserve session/epoch through streamed upload and
  final message-thread conversion. A project switch between begin and upload
  now settles the import as a failure, removes temporary bytes and cannot
  mutate a reused track index in the new project.
- Undo/Redo and editor transactions publish exact request-ID outcomes in
  bounded 256-entry rings. These now cover song/track/bus/event/section/cycle
  structural edits, audio/MIDI region add/update/remove, automation lane and
  point edits, and one submitted automation-record gesture. Import jobs,
  plug-in lifecycle, lighting, active-document dialogs and high-rate scalar
  controls remain distinct protocols. Results carry project epoch/history
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
  stale destructive New Project rejection, and 413 admission. Four focused UI
  suites passed 27/27 and the identity suite passed 3/3. This does not
  establish acoustic/device behavior, vendor plug-in continuity, sanitizer
  cleanliness or physical-platform coverage.

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
- Exact outcomes now cover the structural/audio/MIDI/automation route families
  listed above, but not plug-in lifecycle, lighting, import-job completion,
  active-document save/open completion, or most scalar/mixer controls. The
  session/epoch fence covers their admission/application boundary, but this is
  not per-request applied acknowledgement for every app mutation.
- Reordered concurrent audio/MIDI edits and matching graph revisions pass the
  real-Core harness. A 257-edit run proves the exact result ring retains only
  the latest 256 request IDs. A UI test proves an expired result remains
  unknown, triggers one state refetch, and never resends the accepted command.
  Still verify Core message-queue saturation/HTTP 503, deferred queue
  exhaustion, same-Core reopen/reused IDs, Core restart during a pending edit,
  and late responses. A process restart now proves old-session requests get
  HTTP 409 while a new session may safely reuse the same numeric request ID.
  Queue admission failure remains explicit but has no
  editor-result ring entry because the command was never accepted.
- Admission result rings remain bounded and process-local. A client that misses
  an exact result does not infer success from field coincidence or a later
  revision; after its bounded wait it refreshes state and reports the outcome
  as unknown. The operator must not retry blindly.
- Verify stale/reordered behavior for the remaining project-scoped command
  families, same-Core project replacement, late replies, ring eviction, bounded
  queue exhaustion, plugin/project loading overlap, and upload-ticket expiry.
  Refine route classification if a new project mutation endpoint is added.

Next implementation:

1. Exercise HTTP command-queue and deferred-message-queue exhaustion. Show
   accepted-result expiry as unknown and never infer application from another
   request's later state.
2. Complete same-Core reopen/reused-ID, Core restart during pending edits, and
   late-response cases. Add exact completion only to remaining structural
   mutations that truly participate in history. Do not make high-rate fader or
   knob streams await one ACK per value; keep continuous latest-wins controls
   separate. HTTP/TCP remains the reliable-command channel; UDP remains sampled
   telemetry and a WebSocket/Socket.IO swap does not supply these semantics.
3. The API-to-footer recovery path is now unit-tested with a simulated exact
   graph-publication failure result. If extending this, preserve separate
   evidence labels: current real-Core injection proves backend state/transport;
   the UI test proves refetch/rejection/no-resend/footer behavior. A single
   real-Core-to-renderer injected run remains future integration work.

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

Remaining session risks: cycle detection still infers wraps from sampled UI
playhead telemetry and can miss a sparse wrap or confuse a seek; ownership is
not bound to mixer/inspector/plugin or other parameter surfaces; a rejected or
unknown recording command has no retained retryable draft. Timeline gain/pan
now use an explicit cancellation policy: Escape, pointercancel and lost capture
restore the starting control value and discard the unfinished recording pass;
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
- Replace sampled-playhead cycle inference with a transport-owned cycle/pass
  sequence or another source that distinguishes wrap from seek and cannot miss
  short loops under telemetry loss. Keep TempoMap conversion and identity fences.
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

## Execution order for remaining work

1. The real-Core injected snapshot-failure/last-good-graph/exact-result path is
   now covered with a compile-time test hook that defaults off. Keep the
   separate unresolved limits above: no transactional rollback, allocator-fail
   injection, acoustic continuity, or device/deadline proof.
2. Extend exact request outcomes to remaining region/project mutations with
   deliberate idempotent/no-op semantics. Do not make high-rate controls await
   one acknowledgement per sample/value.
3. Complete acceptance and failure UX for immutable, bounded project playback
   snapshots: sanitizer/concurrency coverage, callback allocation/deadline
   measurement and actual AU/VST3 audio-continuity proof. Keep transport running
   and do not hide races by locking editor commands or restarting healthy helpers.
4. Extend Core-owned live manual-value arbitration beyond Timeline gain/pan
   only after real UI, playback and device acceptance. Keep it aligned with
   TempoMap, cycle wrap, Stop, seek, project epoch, rejection recovery and one
   coherent history action; recorded points and renderer tests alone do not
   prove audible Touch/Latch/Write behavior.
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
