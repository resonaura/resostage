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

`424e4f4`, `f436040`, `f747399` implement exclusive/cancellable gestures,
full-point atomic replacement/empty creation, real vendor metadata/current values,
stable vendor identities with legacy-index compatibility, bounded admission and
visible draft confirmation errors. Group movement, additive marquee, point
deletion, weighted smoothing with fixed selection endpoints, curve handles and
context operations are implemented. Paths have bounded viewportLOD and constant
tail anchors. This is not proof all UI acceptance or strip DSP is finished.

UI integration uses shared HeroUI wrappers and semantic tokens, visible + for
selected parameters, no empty fake nodes, actual parameter ranges/current baseline,
slot-owned lane discovery and fixed-height animated headers. Existing orphan data
remains preserved. Inspect working tree and run tests before considering complete.

## Finish in this order

1. Complete gain/pan strip playback through immutable prepared bindings and shared
   renderer evaluation/smoothing, same live/offline semantics. Current implementation
   is in progress; verify compile, cycle/seek/song selection, bypass and no-point
   behavior before enabling targets. Mute/send remain explicitly unavailable until
   safe audibility/edge-gain behavior exists. Do not toggle immutable edge.active
   from audio or casually bypass existing mute/solo/pan-law/PDC.
2. Complete component/gesture tests and actual HTTP persistence/history acceptance.
   Selected automation points must delete instead of selected regions; all gestures
   claim pointer ownership. Empty current-value baseline is not selectable. Changing
   parameter without drawing/+ must not dirty the project. Preserve curves on edit.
3. Guard async metadata, MIDI and automation drafts with project epoch as well as
   song/region/lane IDs. Late results from another project must never mutate this one.
   Distinguish HTTP admitted from applied. Missing parameter IDs stay unbound, not
   redirected. A truncated2048-entry table cannot prove a later parameter is removed.
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
