# ResoStage: current continuation handoff

Updated 2026-10-02. Read [audit.md](audit.md) first: it supersedes completion
claims below with confirmed remaining gaps and strict acceptance instructions.
This file is intended to be given directly to the next coding
agent. Read the complete repository `AGENTS.md` first. Check `git status` and
recent commits before acting: code changes after this snapshot take precedence.
Do not redo completed implementation from obsolete chat history.

## User's current request

Audit and repair arrangement automation: shared HeroUI/theme chrome, animated
mode changes, exclusive draw/marquee gestures, translucent effective-value
baseline for empty lanes (no fake points), explicit + to add a lane, real vendor
parameter discovery with loading/failed/missing/unbound handling, multi-point
selection/delete/context smoothing, bendable segment curves.

Additional critical issues:
1. Piano Roll edits/quantize must actually reach Core, survive save/reopen and
   affect playback. Changing snap division with selected notes automatically
   quantizes only that selection; changing grid with no selection must not edit.
2. Non-soloed tracks must not flicker when dimmed.
3. Project loading must identify both the track and actual current plug-in.
4. State updates must distinguish command admission, authoritative application,
   optimistic drafts and latest-wins telemetry. Do not migrate transport merely
   to hide consistency bugs.
5. **Live editing is mandatory:** notes, regions, automation and supported controls
   must be updatable while transport is playing. No Stop/Play requirement, clock
   reset, message-thread seek or restart of healthy plug-in chains. Prepare edits
   outside audio and atomically publish complete compatible snapshots at a block
   boundary. Define what happens to notes already sounding and let the playhead
   continue. Test real playback, not only stopped-state visuals/save persistence.

## Verified root causes and committed fixes

- `341342a`: partial HTTP track/bus rows stripped UDP-owned mute/solo flags,
  then replaced full rows. Merge now preserves only omitted mixer flags by stable
  ID (not row index), without resurrecting removed sends. Four focused tests pass.
- `424e4f4`: exclusive automation gestures, signed left movement, group bounds,
  additive marquee, point selection/deletion/smoothing/curves, atomic draft commit
  and bounded viewport paths. 49 focused UI tests and TypeScript passed at commit.
- `f436040`: HTTP silently disconnected JSON bodies beyond 4096 bytes while the
  client swallowed the failure. MIDI add/update now allow16 MiB, whole automation
  collections4 MiB, scalar commands64 KiB; queue byte admission is bounded32 MiB
  with explicit rejection. HTTP session C++ body storage now follows lws bind/drop
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
- `54f083e`: Normalized UDP telemetry acronym identifiers across server headers and implementations (`kUDPTelemetryPort`, `RemoteUDPSubscriber`, `WSubscribeUDPPayload`, `lastUDPSendTimeSec_`).
- `2683dc2`: Added manual-gesture/session helpers and fader/knob callback support,
  with TimelineSidebar wiring, final gesture requests, return-ramp helpers and
  Write safety revert. The audit found actual Touch/Latch ownership, other
  surfaces, cycle/TempoMap/epoch wiring and rejection handling incomplete.
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
- Current history fix: Core now reports exact applied/rejected outcomes and
  project revisions for the 256 latest Undo/Redo requests and advances the
  legacy applied-request high-water mark only after a real history change. The
  UI checks the exact request result before that legacy marker. Focused history
  tests pass 10/10. Core publishes the history mutation and its result in the
  same frame; expired outcomes stay unknown instead of falling back to another
  request's high-water mark. Full UI and native suites pass, as does the real
  Core HTTP harness including no-op rejection and live Undo/Redo. This does not
  add Core session/project-epoch binding or exact outcomes for ordinary edits.

Concurrent agent work must be merged and checked rather than overwritten.
Every source keeps the standard license header. English comments/commits,
`@/` frontend imports, separate components/hooks/logic/tests, lowercase one-word
folders. Commit each finished block; do not push.

## Immediate next actions

1. Bind commands to Core session and project epoch, then add request-specific
   applied/rejected outcomes and revisions for edits. Renderer queue byte/count
   bounds and immutable callback snapshots are now implemented. The remaining
   protocol must also report when a new playback snapshot is rejected, without
   confusing HTTP admission with application. Keep the shared queue/history
   owner; do not introduce another state authority.
2. Finish publication acceptance: sanitizer/concurrency coverage, callback
   allocation/deadline measurement, and loaded AU/VST3 continuity proof. Do not
   conceal failures by stopping transport or restarting healthy helpers.
3. Finish actual Touch/Latch/Write manual ownership, supported surface bindings,
   tempo/cycle/epoch handling and bounded recording/rejection recovery. Recorded
   point collections and endpoint tests alone do not establish this lifecycle.
4. Changed-latency PDC refill continuity under heavy AU/VST3 device tests (64..512 buffer sizes).
5. Validate light/dark visual geometry, compact heights, reduced motion and
   exclusive/cancellable gestures. Run complete UI suite/typecheck/lint and relevant native suites/build after
   integrating changes; commit by finished block. Report actual totals, vendor
   skips and hardware limits. Update this file and detailed tasks with evidence.

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
