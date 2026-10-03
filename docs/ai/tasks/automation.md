# Arrangement automation: verified state and remaining work

Updated 2026-10-02. Read [audit.md](audit.md), [handoff.md](handoff.md), complete `AGENTS.md` and
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
  is TimelineSidebar; live manual ownership, all supported surfaces and actual
  cycle/TempoMap/epoch wiring remain incomplete. See the audit before extending it.
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
- Real Core HTTP verification in `scripts/verification/editor-state.mjs` checks
  transport advancement while applying MIDI/lane edits, submitted Touch/Write
  gesture persistence/safety revert, active-playback and stopped-state Undo/Redo,
  rejected out-of-pass gesture atomicity, 413 and reopen.
  It does not drive React gestures or measure emitted audio/MIDI/vendor DSP.
- Final audit regression suites: 105 UI files/724 tests, Electron 39 tests,
  native 572 cases/424,285 assertions. Typechecks pass; lint has zero errors and
  12 existing warnings. These do not complete the open ownership/epoch contract.

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
   Session helpers calculate returns and collect points, but actual manual
   override while Touch/Latch is active must beat playback and remain correct
   across cycle, seek, song/epoch replacement and rejection. Wire supported
   mixer/inspector/plugin surfaces explicitly or keep unsupported modes disabled.
6. Compile binding tables off audio instead of repeated string/region lookups.
   Native sample-offset vendor automation, Trim/relative layers, VCA and advanced
   hardware/lighting integrations remain separate explicit tasks.

Offline Write-mode policy is now explicit and tested: saved Write lanes are
suppressed in both live and offline playback; the offline renderer has no
manual gesture to replace them, so it uses the stored/static parameter state.
Do not reopen this as a mismatch unless live policy itself changes.

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
