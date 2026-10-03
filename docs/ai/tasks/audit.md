# Post-completion audit and continuation contract

Updated 2026-10-03. Start here, then read the complete `AGENTS.md` and inspect
`git status`/recent commits. This audit supersedes completion claims in older
task snapshots. Do not repeat finished implementation or overwrite concurrent
work. Commit each verified block in English; do not push.

UI entry paths abbreviated as `timeline/...` below are relative to
`ui/src/screens/editor/`. Core paths are repository-relative.

## Evidence and limits

### Latest continuation addendum — 2026-10-03

Core project format v11 now persists a bounded per-song cache for curves
detached by track-lane target swaps. Rebind validation, staging and cache
capacity reservation precede the single ProjectHistory transaction; serialization
and the v10→v11 migrator preserve existing lanes and initialize absent caches.
The backend target set currently accepts loaded automatable plug-in parameters,
track gain/pan/mute, unique enabled sends, and MIDI CC/pitch bend for MIDI tracks.
The Timeline UI has not yet become a set of independent foldable automation
pseudo-tracks; its selector still chooses/activates a single lane. This is a
backend subset only.

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

Plug-in retry source audit confirms that a retry starts a project-wide loading
generation and full bank walk, but the bank builder reuses healthy strip chains
whose stable strip/ordered slot identities and runtime compatibility match. A
failed helper is one strip-chain boundary, so sibling slots in that same helper
rebuild; other failed chains are also retried. This is source evidence, not a
reproduction of the user's writetest report. The next audit should add explicit
scoped retry semantics and tests for unrelated failed chains, same-chain peers,
stale generations and rapid retries; see performance.md.

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

- Timeline automation currently has one selected lane overlay per track row.
  AutomationTrackControls selects an existing lane/target in one selector; it
  does not render one independent foldable pseudo-track row per lane or retain
  a project-owned curve cache when rebinding a lane target.
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
- Active-song BPM and signature are already shown and edited in the global
  transport header through SongTempoControl's popover; Tap Tempo also writes
  the active song. `patchClickFields` reaches the reliable song-update route.
  Do not duplicate this UI. Add interaction/regression coverage and verify
  edits are active-song scoped and do not corrupt explicit tempo/signature
  point-map semantics.
- MIDI pedal visualization is partially implemented already: MidiRegionBlock
  derives CC64–69 switch-pedal intervals from persisted region events, Piano
  Roll now has separate CC64–69 bottom lanes, and live recording
  preview now carries bounded CC64–69 edges in WLiveRecordingRegion. The live
  overlay merges latest-wins telemetry for the recording lifetime. The Piano
  Roll still needs a deliberate all-controller lane model and live/persisted
  parity; do not duplicate or regress existing paths. Apple sources
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
3. Implement independent foldable automation pseudo-tracks and target-change
   cache only after defining a bounded portable schema/history transaction and
   migration. A cache restore is a real project mutation, not a UI illusion.
4. Introduce shared rotary context-menu/reset/MIDI-learn policy with an
   explicit eligibility type/catalogue; retain each control's true default.
5. Integrate MIDI CC/pedal overlays and shared peak/clip state in independent
   tested blocks; add regression coverage for the existing BPM/signature
   header editor and its active-song routing.
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

### Implementation progress — bounded live MIDI pedal capture/preview (2026-10-03)

The audio callback now captures MIDI switch-pedal CC64–69 into the existing
fixed 4,096-event-per-recording MIDI event buffer and tracks held onset edges
per channel/controller in fixed storage. `publishLiveMidiPreview()` adds a
maximum of 64 recent captured pedal edges per recording plus the true onset
for any still-held pedal, into a fixed 512-controller `SeqLock` frame. The
message thread maps the bounded frame to recording IDs and serializes absolute
song beats, channel, controller and value. The UI merges event IDs across
latest-wins telemetry and draws track-colored, clipped pedal spans/markers.
Callbacks remain allocation- and lock-free. A unique preview generation is
part of each live recording ID so a later recording cannot inherit stale UI
event history. This is bounded visual telemetry, not the source of truth; the
recorded MIDI region remains sourced from captured MIDI events.

Focused live-preview/controller UI tests passed 20/20; full UI Vitest passed
838 tests across 127 files; UI TypeScript and changed-file lint passed. Core
targets `ResoStage` and `resostage_engine_tests` built successfully; the full
native suite passed 592 cases / 428,766 assertions. There has been no device
recording test. Current limits are 4,096 recorded MIDI events per active
session, 64 recent controller edges per session, and 512 controller entries
across the live snapshot; saturation is not yet
surfaced as a visible truncation warning. Do not claim unbounded or lossless
live-preview history. Piano Roll arbitrary-CC visualization remains open.

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
