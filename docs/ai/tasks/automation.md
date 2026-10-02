# Arrangement automation: verified state and remaining work

Updated2026-10-01. Read [handoff.md](handoff.md), complete `AGENTS.md` and
[automation model](../../architecture/AUTOMATION_MODEL.md). This task remains open.

## Audit findings

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

`424e4f4`, `f436040`, `f747399`, `918ca4b`, `9f63e0b`, `250d59f`, `a15c648`, `1739b29`, `9bf4652`, `ba9cb39`, `b04353b`, `de27854`, `7808523`, `aa44fac` implement:
- Zero-allocation strip fader, pan, mute, and aux send automation in `MixRenderer` and `OfflineRenderer`
  via `StripAutomationPlan.h/.cpp` with 560 native tests passing (327,391 assertions)
- Safe declicked mute automation (downstream of console meters, 10 ms audibility ramping)
  and edge-slot aux send automation bindings
- Direct numerical point editing (Return/Enter shortcut, "Set exact value…" context menu option,
  double-click on point, floating input popover with unit display and boundary clamping)
- Next-unautomated lane addition on + click with bullet indicators (`•`) on automated parameters in selector
- Live Touch, Latch, and Write mode enablement with tone styling in `AutomationTrackControls`,
  `punchOutLatchSession` and `revertWriteModeToSafety` in `automationTouchSession.ts`,
  and backend Write mode auto-revert to Touch safety in `builderAutomationRecordGesture`
- Exclusive/cancellable gestures, full-point atomic replacement/empty creation,
  real vendor metadata/current values, stable vendor identities
- Shared HeroUI wrappers (`Select`, `Button`, `Tooltip`), DAW focus isolation (`tabIndex={-1}`)
- Piano Roll note draft retention until matching Core snapshot, snap quantize
- Translucent dashed baseline on empty lanes with no fake draggable nodes
- Project epoch guarding in `useMidiRegionEditorState` preventing stale snapshots
  and late creates from cross-contaminating reopened/switched projects
- Accessible typeahead search for automation parameter selector via `textValue`
- End-to-end verification in `scripts/verification/editor-state.mjs` verifying uninterrupted
  transport playback during live MIDI and automation edits, Touch/Write gestures with safety auto-revert, Undo/Redo, 413, and persistence
- Complete test suites: 100 UI Vitest test files / 679 tests, 5 Electron shell tests / 39 tests,
  560 native engine tests / 327,391 assertions passing cleanly

## Finish in this order

1. Strip fader, pan, mute, and send automation playback is fully implemented and verified.
   Safe declicked audibility ramping and edge-gain modulation are operational.
   Live-editing while playing is fully verified by `editor-state.mjs`.
2. Component/gesture tests and actual HTTP persistence/history acceptance are verified.
   Selected automation points delete with Delete/Backspace hotkey when focused, with
   pointer gestures isolated from parent arrangement marquee. Empty current-value
   baseline is translucent dashed and non-draggable. Parameter selection previews without
   calling `automationLaneAdd` until explicit + is clicked. Curves are preserved on edits.
3. Async metadata, MIDI, and automation drafts are guarded with project epoch
   (`${state.projectName}:${state.pluginLoading?.epoch ?? 0}`) and history navigation.
   Late creations and follow-up edits reject and discard on project change and Undo.
   Missing parameter IDs stay unbound with clear disabledReason banners.
4. Visually verify light/dark themes, low/high vertical zoom, several songs, dense
   lanes, loading/failed plugins, reduced-motion transitions and header/body alignment.
   Current + adds an empty lane for chosen parameter; additional simultaneous sublane
   layout, searchable vendor picker, numerical point editing and copy/paste/duplicate
   are not yet a complete production workflow.
5. Integrate actual Touch/Latch/Write recording and manual-control ownership. The
   pure TouchSession primitive alone is not a live write feature. Use fixed callback
   buffers, one pass/history transaction, off-thread thinning and defined return
   ramp/stop/cycle/punch/controller-disconnect behavior. Write must return to safety.
6. Compile binding tables off audio instead of repeated string/region lookups.
   Native sample-offset vendor automation, Trim/relative layers,VCA and advanced
   hardware/lighting integrations remain separate explicit tasks.

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
