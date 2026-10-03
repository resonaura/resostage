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
  narrowed to `float`; repeated points could grow a lane without a cap. The
  MIDI-region embedded automation parser remains a separate boundary.
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
the stored project edit is not undone if snapshot preparation fails. Add a
fault-injected Core test for this path, sanitizer/concurrent stress coverage,
callback deadline/allocation measurements, and audible/sample continuity tests
with loaded AU/VST3 chains. Resolved vendor parameter indices are not yet fully
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

Still open; do not call this full editor transactionality:

- A failed playback snapshot is now observable and surfaced, but the editor
  mutation remains committed in project history; no safe per-command rollback
  exists because repeated gesture IDs intentionally coalesce several commands
  into one history entry. Do not undo a whole gesture to compensate for a
  single graph failure. Recovery currently refreshes state and tells the user
  audio remains on the last-good graph. Native tests prove the existing
  bounded validator rejects an oversized snapshot and `RoutingEngine` refuses
  an incomplete candidate while retaining the last-good graph; still add an
  actual Core-level failure-injection test that observes transport/callback
  continuity and the matching exact command result. Transactional rollback or
  retry needs an isolated edit transaction model.
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

1. Fault-inject playback-snapshot preparation failure from an accepted editor
   command; prove Core retains the previous graph, reports `applied=true` but
   `playbackApplied=false`, UI refreshes once, and transport does not stop.
2. Exercise HTTP command-queue and deferred-message-queue exhaustion. Show
   accepted-result expiry as unknown and never infer application from another
   request's later state.
3. Complete same-Core reopen/reused-ID, Core restart during pending edits, and
   late-response cases. Add exact completion only to remaining structural
   mutations that truly participate in history. Do not make high-rate fader or
   knob streams await one ACK per value; keep continuous latest-wins controls
   separate. HTTP/TCP remains the reliable-command channel; UDP remains sampled
   telemetry and a WebSocket/Socket.IO swap does not supply these semantics.

## P1 — manual Touch/Latch/Write is not yet a complete live lifecycle

Entry points: `timeline/automation/hooks/useAutomationTouchRecorder.ts`,
`logic/automationTouchController.ts`, `logic/automationTouchSession.ts`,
`timeline/tracks/components/TimelineSidebar.tsx`, shared fader/knob wrappers,
and `MainComponentBuilderAutomation`/native automation playback.

The hook is instantiated only in TimelineSidebar and buffers points until
release/Stop; adding callbacks to shared controls does not wire every
mixer/inspector/plugin surface. It still has no Core-owned manual-value override,
so collection/persistence is not proof that Touch/Latch takes precedence over
automation playback or that the operator hears the moved control.

The 2026-10-02 continuation closes several UI session hazards: capture now
requires the confirmed `(stateSessionId, projectEpoch)` pair, cancels on song or
project identity transition, maps playhead seconds through the song TempoMap,
observes playhead changes for loop-wrap splitting, resumes a held Latch pass on
retouch, retains the last valid value when release data is absent, and caps a
gesture at 65,536 points with endpoint-preserving compaction. The Core parser
validates the optional compaction marker; reliable record-mutation rejection
already reaches the shared editor failure notification and is not retried.
Compaction is explicitly reported by Core status.

Remaining session risks: cycle detection still infers wraps from sampled UI
playhead telemetry and can miss a sparse wrap or confuse a seek; the capture is
not bound to every supported surface; a rejected/unknown command has no retained
retryable draft; and browser pointer cancellation/lost capture needs an explicit
per-control policy. Endpoint tests do not prove manual-control ownership while
Touch/Latch is active or audible output.

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

Required implementation:

- Establish one explicit owner for manual override versus automation playback.
  Touch must sound the live value while held, then return to the underlying
  curve. Latch must continue the last touched value until punch-out/Stop. Write
  must have a documented destructive interval and reliable safety revert.
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
- Escape/pointercancel/lost capture/unmount must cancel or finish according to a
  documented policy. Do not silently commit a cancelled gesture.

Acceptance: actual UI fader/knob gestures while playing, audible manual override,
release ramps, sustained Latch, Stop/seek/cycle, multiple controls, rejection,
same-ID reopen, Undo/Redo branch and save/reopen. Include failed/removed vendor
parameters and do not call packet collection alone live recording acceptance.

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
scalar paths. MIDI-region embedded `automationLanes` still use
`MainComponentBuilderTracks.cpp::parseAutomationLanes`, another ingestion path.
Inventory every mutation path and validate before history/mutation; do not call
one fixed endpoint a complete admission contract.

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

## Piano Roll TempoMap — partially closed, ruler/cycle still pending

Entry point: `ui/src/screens/editor/pianoroll/components/PianoRollEditorTab.tsx`
(`PianoRoll` position props and `onSeek`), and shared musical-time helpers.

The UI audit found project/sample positioning calculated as seconds multiplied
by one song BPM even when the song has `tempoPoints`. Commit `8cef0b2` adds a
shared UI song TempoMap helper and converts the Piano Roll live/stored playhead
and inverse seek mapping. The helper is also reused by Standard MIDI import and
export. The 729-test UI suite and UI TypeScript build pass after this change.

This is not complete project-axis support: `PianoRollProjectHeader`, `Ruler`
and `CycleStrip` still calculate project width, ruler ticks, locator positions
and cycle snapping from one BPM. Drawing/recording and every locator boundary
must be traced before claiming full TempoMap support. Respect song offsets and
actual project bars/time signatures without changing Core's clock.

Remaining acceptance: multiple tempo changes across header width, ruler ticks,
cycle locator movement/snapping and displayed project bars; selected regions
before/after a change; crossing a change during playback; nonzero song offsets
and save/reopen. Assert roundtrip beat/sample positions and emitted note time,
not only the label. Reuse existing timing ownership rather than introduce a UI
clock.

## Execution order for remaining work

1. Connect immutable playback-snapshot preparation/publication success or
   failure to the originating request result without blocking audio or lying
   about project-history application. Keep the prior graph active on failure.
2. Extend exact request outcomes to remaining region/project mutations with
   deliberate idempotent/no-op semantics. Do not make high-rate controls await
   one acknowledgement per sample/value.
3. Complete acceptance and failure UX for immutable, bounded project playback
   snapshots: sanitizer/concurrency coverage, callback allocation/deadline
   measurement and actual AU/VST3 audio-continuity proof. Keep transport running
   and do not hide races by locking editor commands or restarting healthy helpers.
4. Complete Core-owned live manual-value arbitration for Touch/Latch/Write, then
   wire each supported control surface and handle TempoMap, cycle wrap, Stop,
   seek, project epoch, rejection recovery and one coherent history action.
5. Validate MIDI-region embedded automation lanes before history/mutation;
   define live/offline Write rendering and preserve the old envelope outside a
   recorded punch window.
6. Recover automation whose plug-in slot was removed; cache immutable parameter
   descriptors by epoch/slot/generation rather than refetching all visible slot
   tables on a timer.
7. Finish TempoMap-based Piano Roll ruler/cycle/project-axis positioning, then
   run heavy vendor/device, theme, platform and save/reopen acceptance in
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
Existing slot-removed orphan lanes must remain discoverable rather than vanish
when their former owner cannot be inferred.

`useAutomationParameters` currently polls every visible track's complete
parameter descriptor table once per second (faster while loading). Four
parallel requests limit concurrency, not total work/traffic. Cache immutable
metadata by project epoch/slot/vendor generation, fetch only changed tables,
and update current values narrowly for displayed/selected targets. Define a
bounded invalidation/stale-response strategy and measure bytes/sec, Core
serialization/renderer CPU and idle cost on dense projects before claiming
global plug-in/automation optimization.

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
