# ResoStage: current continuation handoff

Updated 2026-10-02. Read [audit.md](audit.md) first: it supersedes completion
claims below with confirmed remaining gaps and strict acceptance instructions.
This file is intended to be given directly to the next coding
agent. Read the complete repository `AGENTS.md` first. Check `git status` and
recent commits before acting: code changes after this snapshot take precedence.
Do not redo completed implementation from obsolete chat history.

## Current continuation focus

Continue the state-integrity work. The latest block adds Core-session and
project-epoch fences, exact acknowledgements for structural project edits,
audio/MIDI regions and automation, and identity propagation through streamed
media imports. It also binds each exact editor result to the last successfully
published playback-graph history revision. The current lighting continuation
adds an explicit application domain: a confirmed LightEngine project-snapshot
handoff is not an audio-graph publication or proof of a physical DMX frame.
Audit that implementation first; do not replace it with another queue or state
authority. Keep the distinctions explicit:

- HTTP admission is not application.
- Project-history mutation is distinct from proof that the matching immutable
  audio playback snapshot was prepared and published (`playbackApplied`).
  Compare graph history revision only within its AudioEngine project epoch;
  the UI project epoch is a distinct identity namespace.
- A last-good audio graph must remain safe if snapshot preparation fails, while
  the exact originating edit receives a rejection/recovery result. Native tests
  reject oversized/incomplete snapshots, and the real-Core injected acceptance
  now proves exact result, last-good graph retention, transport advancement and
  recovery. This still is not acoustic, loaded-plug-in or deadline evidence.
- Live edits must not stop transport, reset the clock, or restart a healthy
  plug-in chain.

Queue/restart/reopen acceptance is now exercised by the actual-Core harness.
The current block also adds exact graph-result handling for structural
plug-in-chain edits, while deliberately leaving vendor-load readiness in
generation-scoped plug-in telemetry and bypass/Keep Awake in the host-control
protocol. Continue with active-document Save/Open terminal-feedback audit,
then the unresolved automation, Piano Roll, callback-deadline, AU/VST3 and
hardware acceptance items in [audit.md](audit.md).

## Verified root causes and committed fixes

- `341342a`: partial HTTP track/bus rows stripped UDP-owned mute/solo flags,
  then replaced full rows. Merge now preserves only omitted mixer flags by stable
  ID (not row index), without resurrecting removed sends. Four focused tests pass.
- `424e4f4`: exclusive automation gestures, signed left movement, group bounds,
  additive marquee, point selection/deletion/smoothing/curves, atomic draft commit
  and bounded viewport paths. 49 focused UI tests and TypeScript passed at commit.
- `f436040`: HTTP silently disconnected JSON bodies beyond 4096 bytes while the
  client swallowed the failure. MIDI add/update now allow16 MiB, whole automation
  collections4 MiB, scalar commands64 KiB; queue admission is bounded to 1024
  commands and32 MiB of payload with explicit rejection. HTTP session C++ body storage now follows lws bind/drop
  lifetime. `postReliable` exposes failures for MIDI and automation.
- Same backend commit: real plugin metadata/current values/stable vendor IDs,
  atomic whole-lane replacement (one history gesture, curves preserved),
  empty lane creation, helper protocol8 and actual Track · Plug-in startup progress.
  Legacy `param:<index>` lanes remain compatible; new targets use
  `id:<vendor-id>` where the vendor exposes one.
- Native Core/test/helper build passed for that block. Focused 19 native cases /
  3794 assertions include actual Apple AUDelay metadata/current-value control.
  Plugin API 10 UI tests passed. These are not heavy-vendor acoustic acceptance.
- `918ca4b`: native zero-allocation strip fader and pan automation in `MixRenderer`,
  `MixGraph`, and `OfflineRenderer` (`StripAutomationPlan.h/.cpp`). 558 native
  test cases and 327,352 assertions passed in `resostage_engine_tests`.
- `9f63e0b`: Piano Roll note draft persistence (`usePianoRollNoteDraft.ts`),
  selected-note quantization on snap change (`usePianoRollNoteActions.ts`),
  and provisional region admission tracking.
- `250d59f`: Modernized arrangement automation with shared HeroUI controls
  (`Select`, `Button`, `Tooltip`), DAW keyboard focus isolation (`tabIndex={-1}`),
  real parameter discovery, and end-to-end verification script
  (`scripts/verification/editor-state.mjs`). All 654 UI tests (98 test files)
  and 37 Electron shell tests passed.
- `a15c648`: Enabled native strip fader and pan automation in arrangement targets,
  clarified explicit disabledReason for mute (requiring audibility smoothing) and
  sends (requiring edge slot bindings), added live strip fader/pan playback and
  persistence verification in `editor-state.mjs`, and resolved test button element typing
  for 100% clean `tsc -b` compilation. All 654 UI vitest tests and 558 native tests pass.
- `1739b29`: Unit tests for `useAutomationKeyboard` verifying DAW focus isolation
  (gating shortcuts strictly on `document.activeElement === surface.current`), Delete/Backspace
  point deletion, Mod+A select all, Escape clear selection, and readOnly protection.
- `9bf4652`: Unit tests for `AutomationLaneOverlay` (empty baseline dashed line rendering,
  zero circle handles when empty, disabledReason banner display, pointer tool cursor styling,
  and context menu operations) and `AutomationTrackControls` (+ button empty lane creation,
  disabledReason button gating, and lane removal).
- `ba9cb39`: Guarded `useMidiRegionEditorState` with project epoch (`state.projectName` and
  `state.pluginLoading?.epoch`) to cancel and reject stale provisional MIDI region creations
  and clear selection upon project change/open. Added unit test suite in
  `useMidiRegionEditorState.test.tsx` testing reconciliation, follow-ups, Undo, and epoch change.
- `b04353b`: Added accessible typeahead search via `textValue` to automation parameter Select options.
- `65239a3`: Canonicalized `WAVSource` in `OfflineRenderer.cpp` and `finalizeWAVFile()` in `OfflineWAVWriter.{h,cpp}` with backward-compatible aliases.
- `de27854`: Safe declicked mute automation (downstream of console meters, with 10 ms audibility ramping) and aux send automation edge bindings in `StripAutomationPlan` and `MixRenderer`. 560 native test cases / 327,376 assertions pass.
- `7808523`: Direct numerical automation point editing (keyboard Return/Enter, "Set exact value…" context menu option, double-click on point, floating input popover with unit display and boundary clamping) and next-unautomated lane addition with bullet markers (`•`) in `AutomationTrackControls`. 100 UI test files / 676 tests pass.
- `8751069`: Canonicalized BPM, UDP, and MIDI clock acronyms (`setClockBPM`, `setBPM`, `registerUDPSubscriber`, `kUDPTelemetryPort`, `sendFrameOverUDP`, `kArtNetUDPPort`) with backward-compatible aliases across `CoreMidiDispatcher`, `LightEngine`, `WebServer`, `LightHardwareServer`, and `ArtNetPacket`.
- `aa44fac`: Enabled Touch, Latch, and Write automation modes with tone styling in `AutomationTrackControls`, implemented `punchOutLatchSession` and `revertWriteModeToSafety` in `automationTouchSession.ts`, added Write mode auto-revert to Touch safety in `builderAutomationRecordGesture`, added C++ Write mode test in `test_automation_framework.cpp`, and added live Touch and Write gesture recording verification to `editor-state.mjs`.
- `1577c11`: Scaled automation overlay and track controls for compact lane heights (<= 32px), omitted curve handles, scaled breakpoint nodes, and added reduced-motion transitions.
- `c60cc68`: Added native test in `test_plugin_performance.cpp` for dynamic PDC changed-latency refill continuity and zero allocations during active audio rendering.
- `e3a4da2`: Suppressed automation playback during Write mode across Strip, Plugin, and MIDI domains so manual fader gestures write without competing against existing points.
- `d270742`: Aligned offline plugin/MIDI automation with live Write-mode suppression; focused native regression confirms Touch still writes to the offline session.
- `54f083e`: Normalized UDP telemetry acronym identifiers across server headers and implementations (`kUDPTelemetryPort`, `RemoteUDPSubscriber`, `WSubscribeUDPPayload`, `lastUDPSendTimeSec_`).
- `2683dc2`: Added manual-gesture/session helpers and fader/knob callback support,
  with TimelineSidebar wiring, final gesture requests, return-ramp helpers and
  Write safety revert. The audit found actual Touch/Latch ownership, other
  surfaces, cycle/TempoMap/epoch wiring and rejection handling incomplete.
- `11b031e`: Core arbitration for live Timeline gain/pan Touch/Latch/Write;
  per-lane manual owners suppress only matching playback while the physical
  control value is applied, and clear on Stop/song or project replacement.
- `1e54bf3`: UI regression drives an exact playback-snapshot failure result
  through the real editor mutation API and verifies refresh, rejection, no
  resend, and footer error. This is separate from the real-Core injector run.
- `621d4c4`: Escape, pointer cancellation, lost capture, and control unmount
  now discard the in-progress automation gesture; normal pointer release
  commits. Faders, knobs, track pan, and gain share cancel-vs-end semantics.
  Full UI suite: 781 tests / 117 files; TypeScript/build pass; lint has zero
  errors and the same 12 existing warnings.
- `9d847b2`: Test-only loopback HTTP queue controls verify 1024 admitted
  commands, explicit 503 on the next request, drain, and re-admission.
- Current block extends the same real-Core harness to the deferred message
  queue: exact 1024-command and 4 MiB body limits, exact `applied=false` overflow
  outcomes with unchanged project revision, and count/byte recovery after drain.
  In addition, real asynchronous Save and streamed media-import jobs now each
  overlap with an exact MIDI-region edit. Both observe Core busy and prove that
  the edit applies after same-epoch package reopen; the import case also checks
  terminal ticket status, full region duration/song-end extension, and existing
  resource preservation. No test-only hold is used for either I/O operation.
  Large real plug-in-state serialization and acoustic continuity remain open.
- The real-Core harness also queues an edit immediately before reopening the
  same saved package in the same Core process. It verifies stable MIDI entity
  IDs, incremented project epoch, an exact late result labeled with its captured
  old epoch, persisted content winning over the transient edit, and a monotonic
  process-local request-ID sequence. Still open: killing/restarting Core while
  the accepted edit is pending was then added as an optional test-hook scenario:
  dequeue is paused, acceptance is confirmed without a result or state effect,
  Core is killed, the saved document reloads unchanged under a fresh session,
  and an old-session retry gets 409. The standard Core build remains test-hooks
  off. `projectIdentity.test.ts` now also delays the state poll until after a
  same-Core project epoch change, then releases the old exact result and proves
  the UI rejects it, schedules refresh, and never repeats its POST. This is a
  controlled fetch race, not a live Electron/network restart test.
- Current lighting block adds exact outcomes for lighting
  configuration, fixture, light-track and cue mutations. Results identify the
  `lighting` application domain and confirm the synchronous immutable-project
  handoff to LightEngine instead of incorrectly requiring the audio graph to
  cover the lighting history revision. The UI lighting API now waits for that
  exact result and sends the project identity fence. Core HTTP acceptance
  covers successful CRUD/reorder and rejected invalid/no-op removals; one UI
  regression proves a stale audio graph does not reject an applied lighting
  snapshot. The actual-Core harness, focused UI case, full UI suite (782 tests
  / 117 files), UI typecheck/build and Core build pass. Lint had zero errors
  with 12 warnings. Serial CTest passed 585 cases / 428,681 assertions after
  the isolated AU test passed following one failure during a concurrent UI
  run. This is not a physical DMX delivery test; the transient AU timing issue
  remains unexplained.
- The actual-Core harness now also overlaps a reliable MIDI-region update with
  the real asynchronous Save path using a private 64 MiB package resource. It
  observes Core busy, then verifies exact application after the same-project
  package rewrite/reopen and preservation of the resource. This closes Save
  overlap only; equivalent import overlap and large real plug-in-state work
  remain open.
- `fdc32a2`: Unit test for dense sustain and panic traffic during deferred MIDI queue capture in `test_plugin_host_protocol.cpp` (582 assertions verifying pedal CC 64, notes, pitch bend across channels 1..4, overflow degradation to 48-event 16-channel panic, and clean recovery).
- `75c3eb0`: Canonicalized ArtDMX (`buildArtDMXPacket`, `parseArtDMXPacket`), WebCommandKind values (`BuilderTrackImportWAV*`, `BuilderMIDIRegion*`, `SetMIDI*`, `MIDILearn*`), builder/settings methods (`builderMIDIRegion*`, `builderTrackImportWAV*`, `settingsSetMIDI*`, `settingsMIDI*`), and `importWAVForTrackAsync` across Core with backward-compatible aliases.
- `e214318`: Exposed canonical acronym types and method aliases in UI (`MIDINoteRow`, `MIDIClipEventRow`, `MIDIUmpEventRow`, `MIDIRegionRow`, `MIDIBindingRow`, `trackImportWAV`, `setMIDI*`) and Electron (`UDPTelemetryStats`, `UDPTelemetryTracker`).
- `c595b4b`: Implemented Copy, Cut, Paste, and Duplicate workflows for arrangement automation points (`automationClipboard.ts`, `automationEditing.ts`, `useAutomationDrag.ts`, `useAutomationKeyboard.ts` with `Mod+C`/`Mod+X`/`Mod+V`/`Mod+D` shortcuts, and `AutomationLaneOverlay.tsx` context menu with relative beat offset normalization, grid alignment, and click-based paste positioning). 10 unit tests in `automationClipboard.test.ts` and 5 keyboard tests in `useAutomationKeyboard.test.tsx` pass.
- `345c4c1`: Canonicalized MIDI symbol aliases across `AudioEngine` (`ActiveMIDINoteInfo`, `enqueueIncomingMIDI()`, `getActiveMIDINotes()`, `syncMIDITransportToCurrentSong()`), `OfflineMidiEvents` (`OfflineMIDIEvent`, `buildOfflineMIDIEvents()`), `MainComponent` (`handleMIDILearnMessage()`), `MidiTransform` (`MIDITakeoverMode`, `MIDIRelativeEncoding`), and `CoreMidiDispatcher`/`CoreMidiInputListener` (`MIDIClientRef`, `MIDIPortRef`, `MIDIEndpointRef` cross-platform). Added tests in `test_midi_takeover.cpp` and `test_offline_renderer.cpp`.
- `818aa31`: Added synthetic PDC steady-state and varying-render-block tests
  (64/128/256/512 frames), checking finite output and ordinary C++ allocations
  in the probed section. These do not exercise physical device changes or the
  full callback. Added MIDI acronym aliases. A worker limit was placed in Vite
  config, but Vitest loads its separate config; the audit corrects that location.

## Work in progress: inspect before continuing

Native strip automation, manual-control recording foundations, and arrangement
UI have been integrated. The HTTP harness verifies command/state persistence
and transport advancement, not audible manual-control ownership or vendor DSP.
`scripts/verification/editor-state.mjs` confirms:
- >4 KiB note and automation updates over HTTP without socket termination
- Live note quantize during active playback without stopping or resetting clock
- Strip fader, pan, mute, and send lane creation/point replacement while playing
- Submitted Touch gesture persistence and Write mode safety revert while playing
- Continuous sample transport advancement through live project edits
- Undo and Redo roundtrips restoring exact note durations and curves
- Explicit 413 rejection for oversized command bodies
- Persistence across project save and clean reopen
- Historical test evidence: 103 UI files / 706 tests, 39 Electron tests and
  566 native tests passed in the previous completion snapshot. The 2026-10-02
  audit independently passed UI 706 and Electron 39; its initial native run
  passed 563/566. An isolated AU rerun passed 67 assertions. Do not erase the
  integrated failure by quoting an older green run; see [audit.md](audit.md).
- Previous UI/Electron evidence: UI 724 tests/105 files, Electron 39 tests;
  UI/Electron typechecks passed and lint had zero errors/12 existing warnings.
  Commit `83b14c8` publishes bounded immutable playback snapshots, and its Core
  build, native suite (578 cases/424,387 assertions) and real-Core editor-state
  HTTP harness passed. The renderer queue/history blocks now pass UI 736 tests/107
  files and UI TypeScript. UI/Electron were not
  rerun for the Core snapshot block; this is not acoustic, loaded-vendor,
  sanitizer, or callback-deadline proof.
- Current history fix: Core reports exact applied/rejected outcomes and
  project revisions for the 256 latest Undo/Redo requests and advances the
  legacy applied-request high-water mark only after a real history change. The
  UI checks the exact request result before that legacy marker. Focused history
  tests pass 10/10. Core publishes the history mutation and its result in the
  same frame; expired outcomes stay unknown instead of falling back to another
  request's high-water mark.
- Current continuation block adds Core-session/project-epoch headers and
  message-thread revalidation for project-scoped commands; request identity is
  carried through media import tickets. Exact request outcomes cover song,
  track, bus, event, section and cycle structural edits; audio/MIDI region CRUD;
  automation lane/point edits and a recorded automation gesture. Each result
  reports playback graph epoch/revision separately from the mutation revision.
  On a graph-preparation failure the UI refreshes project state and
  refuses blind retry, while Core retains the last-good graph. This is not
  rollback: project history may be ahead of audio until a later successful
  publication. Verification on 2026-10-02: UI TypeScript passed; full UI Vitest
  passed 745 tests/108 files; production UI build passed; lint had zero errors
  and 12 existing warnings;
  optimized Core target and native `ctest` passed; real-Core
  `editor-state.mjs` passed audio/MIDI region CRUD, structural cycle/section/
  event/bus/song edits, concurrent exact ACKs, 257-edit result-ring eviction,
  playback epoch/revision checks, active-playback Undo/Redo, stale upload/edit,
  stale destructive New Project rejection, Core-session rejection after
  restart with request-ID reuse, 413, and save/reopen. Native `ctest` also
  verifies bounded snapshot rejection cannot replace the last-good routing
  publication and 1024-slot/32 MiB command admission recovery. Focused UI tests
  prove an expired result triggers one refetch,
  stays unknown and is not resent, rejects an apparently newer revision from
  the wrong playback epoch, and surfaces fire-and-forget rejection without
  retry. The real-Core injected snapshot-failure acceptance was added in the
  current block; ordinary builds keep the route disabled. No full Electron
  run, acoustic/vendor proof, HTTP/deferred queue-saturation stress, or
  callback-deadline evidence in this block. Exact result coverage remains
  incomplete; see [audit.md](audit.md).

The command-identity and active-document lifecycle blocks, tests and
documentation are committed locally and not pushed. Start by checking
`git status` and preserve any newer work.
Every source keeps the standard license header. English comments/commits,
`@/` frontend imports, separate components/hooks/logic/tests, lowercase one-word
folders. Commit each finished block; do not push.

Latest continuation (2026-10-02): a Core-owned transient manual-automation
override is implemented for arrangement Timeline track gain/pan. The message
thread owns and bounds active lane IDs, publishes them as an immutable
`MixGraph` snapshot, and the callback skips only an owned strip binding. Stop,
song change and project replacement clear the ownership. Native coverage proves
the named gain lane is skipped while unrelated pan automation remains active;
the UI API test verifies project-epoch headers. This is not yet complete
Touch/Latch/Write acceptance or acoustic proof. Before expanding elsewhere,
rebuild and rerun the focused native/UI tests and complete UI suite, typecheck,
build and lint. Then add interaction-level tests for pointer cancel/lost
capture, seek, simultaneous controls and rejection handling; confirm audible
Touch return and held Latch on a device. Remaining surfaces include Mixer,
Inspector and plug-in parameters. Update the audit/task docs with measured
results, commit in English, and do not push.

The graph-publication failure UI path now also has a focused test: a simulated
exact Core result is passed through a real project mutation API, and the test
asserts refetch, rejection, no resend, and visible footer error. The real-Core
failure-injection harness remains separate, so do not report a single
Core-to-renderer end-to-end fault injection.

Timeline drag cancellation is also implemented: normal release commits, while
Escape/pointercancel/lost capture restore the starting control value, discard
the in-progress automation points and release Core lane ownership. Unmount
clears listeners/ownership without writing a stale index-based rollback. The
focused cancellation/controller/recorder UI tests passed 25/25; full UI Vitest
passed 781/781 across 117 files, TypeScript/build passed, and lint had zero
errors with 12 existing warnings. This is not real Core/audio gesture proof.
Seek-vs-cycle identity, bounded rejected-draft recovery, Mixer/Inspector/plugin
surfaces and hardware acceptance remain open.

The committed `06c3819` Touch/Latch/Write capture-session block additionally
requires confirmed Core-session/project-epoch identity, maps playhead time with
the song TempoMap, detects cycle wraps from sampled playhead movement, resumes
held Latch passes on retouch, retains the prior finite value when release data
is missing, bounds capture to 65,536 points with endpoint-preserving compaction,
and reports compaction through Core status. UI tests, typecheck, production
build, Core build, real-Core HTTP acceptance and serialized CTest passed. A
native VST3 64-sample timing case failed once only when competing with a UI
build; its isolated case and subsequent serial suite passed, so keep this as a
scheduler-sensitive risk. The real-Core HTTP harness also once observed
`playing=false` at the exact ACK for a live note edit; three later serial runs
passed, and the assertion now includes transport position, song end, exact ACK
and Core status if it recurs. Do not treat those retries as resolution of the
intermittent signal. This block does not implement Core-side manual-value
ownership, authoritative loop iteration IDs, pointer-loss policy or retained
recovery drafts after unknown/rejected commits.

Follow-up acceptance investigation: `editor-state.mjs` now waits for forward
playhead telemetry after the live strip-automation edit and includes Core
callback/underrun/silent-block/device diagnostics on timeout. One standalone
run and five consecutive serialized acceptance runs passed. An earlier
intermittent stalled-playhead report remains unproven/unresolved; do not
reinterpret green retries as acoustic continuity evidence or remove the
allocator-failure and loaded-device acceptance items.

The latest committed block, `33a758b` (`Cache plugin automation descriptors`),
replaces periodic full plug-in parameter-table downloads with a bounded
128-slot cache keyed by Core/project epoch and generation, slot, plug-in and
load state. A compact Core endpoint reads hosted-helper parameter atomics for
current values; the automation hook refreshes those values only while visible,
limits concurrency to four, retries loading at 250 ms and suppresses React
renders when values are unchanged. Verification: full UI suite 757/757 across
109 files, UI TypeScript and lint (zero errors, 12 existing warnings), Core and
native builds, full native CTest 584 cases / 428,677 assertions, real-Core
`editor-state.mjs`, and 66 assertions in the hosted Apple AUDelay parameter
test. This is not dense-project idle-cost profiling, all-vendor proof or
acoustic/device evidence. Detached automation recovery is implemented; visual
and successful vendor-rebind acceptance remains open.

## Detached automation recovery

The Editor timeline now finds removed plug-in slots and conclusive unbound or
failed plug-in automation targets across song/audio/MIDI-region lanes. Complete
loaded metadata is required before declaring a parameter absent; loading or
truncated metadata is not enough. Rebind uses
`/api/v1/builder/automation-lane/update` with an optional `target`; Core checks
current-project ownership and the loaded bank's automatable descriptor before
history mutation. Rejected destinations must preserve lane points and project
revision. See `audit.md` and `automation.md` for details and verification.
The current block passed 763 UI tests / 111 files, UI TypeScript/build, lint
(zero errors, 12 existing warnings), native CTest (584 cases / 428,677
assertions), and real-Core absent-slot rejection. Successful live-vendor rebind
and visual/device acceptance are still required.

## Piano Roll TempoMap project axis

`PianoRollProjectHeader` now uses `createPianoRollProjectAxis` for song width
and seconds-backed cycle coordinates; its ruler mode consumes normalized
signature points and keeps actual bar numbers across meter changes. `CycleStrip`
keeps the existing seconds-based arrangement behavior by default, while the
Piano Roll supplies seconds↔beats mapping and beat-grid snapping. Cycle range
span is preserved in displayed beat coordinates when moved. The project still
has one authoritative seconds-backed cycle, not separate Piano Roll state.
Verification: full UI suite 773 tests / 114 files, TypeScript, production
build, lint (zero errors, same 12 warnings), and ten focused axis/ruler/cycle
tests passed. Manually inspect tempo/meter changes, scroll/zoom, boundary
gestures, playback crossing and save/reopen; UI tests are not device proof.

## Immediate next actions

1. Core-level playback-snapshot failure is now exercised by the real HTTP
   harness through `RESOSTAGE_ENABLE_TEST_HOOKS` (default OFF). It verifies the
   exact applied-vs-playback result, last-good graph retention, continued
   playhead and recovery on the next edit while transport stays live. This is
   not allocation-failure injection, rollback, acoustic, vendor or deadline
   proof. Do not compensate with unscoped Undo; gesture coalescing makes that
   unsafe.
2. Stress deferred admission during a real save/import, same-Core project replacement, Core
   restart during an in-flight command, and late
   responses. The Core now has a fixed 1024-command/32 MiB admission ceiling;
   unit tests prove command and byte reservations reject and recover. Old-session
   post-restart requests and numeric request-ID reuse are also covered. Expired
   results stay unknown. High-rate controls remain latest-wins and do not await
   per-sample ACKs.
3. Finish publication acceptance: sanitizer/concurrency coverage, callback
   allocation/deadline measurement, and loaded AU/VST3 continuity proof. Do not
   conceal failures by stopping transport or restarting healthy helpers.
4. Extend the current Core-owned Timeline gain/pan manual arbitration only after
   real UI/playback/device acceptance. Add explicit lost-pointer/seek handling,
   authoritative cycle-pass identity, more surface bindings, and bounded draft
   recovery after rejected/unknown results. Recorded point collections and
   renderer tests alone do not establish audible Touch/Latch/Write behavior.
5. Changed-latency PDC refill continuity under heavy AU/VST3 device tests (64..512 buffer sizes).
6. Validate light/dark visual geometry, compact heights, reduced motion and
   exclusive/cancellable gestures. Run complete UI suite/typecheck/lint and relevant native suites/build after
   integrating changes; commit by finished block. Report actual totals, vendor
   skips and hardware limits. Update this file and detailed tasks with evidence.

## Structural plug-in command block (2026-10-02)

Core now publishes exact editor outcomes for chain add/replace/remove/move;
the UI waits for those graph-revision acknowledgements. The actual-Core
acceptance verifies rejected missing-slot removal and old-epoch removal after
same-Core project replacement do not mutate the new document. Focused UI
identity/plugin tests passed 14/14, the complete UI suite passed 784/784,
TypeScript passed, Core built, and the actual-Core editor-state harness passed.
This confirms saved chain state and
matching routing graph only; it does not confirm vendor instantiation/audio.
Bypass/Keep Awake/retry/editor/park/unpark still need a distinct host lifecycle
or control ACK contract before any UI claims they completed in the live host.

## Remaining task files and transport decision

- [audit.md](audit.md): current P1 defects, quality/edge-case contracts and proof limits.
- [automation.md](automation.md): remaining arrangement/DSP and acceptance work.
- [performance.md](performance.md): heavy AU/VST3 device tests, whole-callback
  allocation/deadline evidence and changed-latency PDC continuity.
- [media.md](media.md): heavy-plugin/stem/cancellation/release-platform acceptance.
- [naming.md](naming.md): incomplete repository-wide acronym inventory.
Delete a task only after all its acceptance is actually complete. This handoff
replaces the previous contradictory snapshot (which said implemented automation
was absent and listed already-committed edits as protected dirty files).

Keep HTTP/TCP for ordered reliable commands and UDP for sampled live telemetry;
existing WS is the browser fallback. Socket.IO is a different application
protocol and does not automatically provide applied-command/duplicate protection.
Any future WS command channel must share the same single mutation/history queue,
bounded admission, request identity, revision/epoch and acknowledgements as HTTP.
Do not duplicate authority or introduce network/vendor work into audio.
