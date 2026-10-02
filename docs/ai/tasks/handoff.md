# ResoStage: current continuation handoff

Updated 2026-10-01. This file is intended to be given directly to the next coding
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
- Native Core/test/helper build passed for that block. Focused19 native cases /
  3794 assertions include actual Apple AUDelay metadata/current-value control.
  Plugin API10 UI tests passed. These are not heavy-vendor acoustic acceptance.

## Work in progress: inspect before continuing

The current working tree contains UI integration and Piano Roll parent changes:
- `ui/src/screens/editor/timeline/automation/`: shared Button/Select/Tooltip
  chrome, + lane creation without initial points, real target binding/current
  baseline, keyboard/context point edits, animated header/overlay transitions.
- `tracks/components/{TimelineSidebar,AudioTrackLanes}.tsx` and
  `timeline/components/Timeline.tsx`: shared discovery data, slot-owned lanes,
  fixed-height headers and removal of fabricated fallback points.
- `pianoroll/hooks/usePianoRollNoteDraft.ts`: draft retained until matching full
  Core snapshot, visible rejection/confirmation timeout, no stale async overwrite,
  safe retry only after known rejection, history/region cancellation.
- `PianoRollEditorTab.tsx` / `useMidiRegionEditorState.ts`: reliable admission
  and provisional-region completion/follow-up tracking.
- `usePianoRollNoteActions.ts` and `PianoRoll.tsx`: explicit new snap division,
  selected-only automatic quantization, no-op edit filtering.
- `AGENTS.md`: stricter shared-component, gesture-owner and draft-authority rules.
- A native gain/pan automation implementation is being prepared. Confirm its
  final commit/tests before claiming playback support.

Concurrent agent work must be merged and checked rather than overwritten.
Every source keeps the standard license header. English comments/commits,
`@/` frontend imports, separate components/hooks/logic/tests, lowercase one-word
folders. Commit each finished block; do not push.

## Immediate next actions

1. Finish UI TypeScript/lint and focused tests. Update old automation tests that
   expected raw HTML selects, invented Param1 or implicit first control points.
   Test real metadata, missing/failed/loading/truncated/unbound values, empty
   baseline, fixed row height, exclusive pointer capture, keyboard point deletion.
2. Run an isolated actual HTTP test with >4 KiB note/point bodies, explicit413
   and queue rejection, then verify Core state, Undo/Redo and save/reopen. Unit
   payload-policy tests alone are not end-to-end persistence evidence.
   Use `RESOSTAGE_SETTINGS_FILE` with a temporary absolute path and a separate
   Core port/project/output; never overwrite recent projects or saved rig settings.
3. Inspect provisional MIDI creation and late snapshots across history/project
   change. Ensure every returned rejection is handled and no detached follow-up
   recreates notes after Undo. Distinguish HTTP admission from execution.
4. Complete and verify actual strip gain/pan automation live/offline with the same
   prepared bounded bindings/evaluation and existing smoothing. Audit found the
   previous code advertised strip gain/pan/mute/send but dispatched only plugin
   and MIDI CC! Until a target really plays, disable it with an explicit reason.
   Safe mute needs edge-audibility/smoothing semantics; sends need bound edge
   slots. Live Touch/Latch/Write recording is not integrated just because a
   primitive TouchSession or write-mode enum exists.
5. Audit pending draft timeout/error recovery, project epochs and stale snapshots.
   A whole-project migration is not finished by fixing one merge helper.
   Record remaining revision/request-ID/application acknowledgement work explicitly.
6. Validate visuals in both themes and several track heights. Shared controls,
   project/track colors, restrained fills, reduced-motion transitions, topmost
   playhead. Curve/node hit areas must not conflict with arrangement marquee.
7. Run complete UI suite/typecheck/lint and relevant native suites/build after
   integrating changes; commit by finished block. Report actual totals, vendor
   skips and hardware limits. Update this file and detailed tasks with evidence.

## Remaining task files and transport decision

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
