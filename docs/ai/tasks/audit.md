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

Confirmed audit concern: callback-side MIDI/automation dispatch reads
`project().tracks`; plugin/region dispatch also traverses the supplied song.
The message thread owns mutable project content. Trace the lifetime and all
callers: a routing `try_lock` is not proof that every project mutation holds
the same lock. Do not leave a callback reading a vector that editor/history
commands can replace beside it.

The Core audit traced `AudioEngine.cpp` capturing `loader.project()` and
passing the mutable song into automation dispatch; `AudioEngineAutomation.cpp`
walks song/region lane vectors and performs track/graph lookups. Normal builder
point/MIDI replacements in `core/app/main/builder/MainComponentBuilderAutomation.cpp`
and `MainComponentBuilderTracks.cpp` do not establish a shared reader gate.

Required implementation:

- Prepare complete immutable, epoch/layout-compatible note/automation target
  publications off audio, including track routing/channel and resolved vendor
  parameter indices. Reuse proven lifetime/retirement ownership.
- Publish atomically at a block boundary without stopping/seeking transport,
  resetting the sample clock, or restarting unchanged healthy helper chains.
- Bound preparation, memory and per-block work. Over-budget/unbound preparation
  must have an explicit observable policy; never fall back to a mutable project
  scan, vendor lookup or unbounded allocation on the callback.
- Define already-sounding note ownership when deleting, moving, quantizing or
  undoing an event. Live held input must not be released by a sequence edit.

Acceptance: concurrent edit/Undo/Redo under an active cycle, same-ID project
replacement, stale publications, empty/large songs and channel changes. Assert
actual note/control dispatch and audible/sample continuity, not just `playing`
and a growing UI playhead. Run the relevant concurrency tests and sanitizer
coverage where available. Record callback deadlines and allocation coverage.

## P1 — command epoch, applied acknowledgements and bounded retained payloads

Entry points: `ui/src/lib/state/api.ts` (`serializeCommand`, `postReliable`,
`postContinuousImpl`), `historyNavigation.ts`, MIDI/automation draft hooks,
`core/app/server/WebServer` command admission, and message-thread application.

Confirmed gaps:

- The client serializer checks only `backendOrigin()`. Replacing a project on
  the same Core, even with reused track/region IDs, does not invalidate queued
  document edits. UI draft guards alone cannot unsend an admitted stale command.
- History has an applied-action protocol, but ordinary builder writes do not
  have a matching request/revision acknowledgement. Matching field values can
  coincide with an unrelated edit/Undo and are not proof this request applied.
- The client queue is bounded to 256 commands, not retained payload bytes.
  Large note collections can retain far more memory than a weak laptop can
  tolerate despite Core's separate bounded queue admission.
- Continuous coalescing currently keys by route and `index`/`trackIndex` only.
  Different send buses on the same track can replace each other's pending
  values. Every independent control needs its full stable target identity.

Required implementation:

- Bind document-derived edits to Core identity and project epoch, validate both
  before send and before message-thread application, and reject stale work
  explicitly. Reopen with the same names/IDs must still be a new document epoch.
  Safety Stop/cancel must remain serviceable under the appropriate scope.
- Use bounded request IDs and applied/rejected results plus project revision
  for transactional editor/history operations. Reuse one mutation/history queue
  and existing acknowledgement foundations; no parallel state authority.
- Bound client payload bytes as well as command count. Account for the exact
  admitted serialized payload, release accounting on every failure/finish,
  and expose exhaustion to the gesture owner. Avoid multiple full-size copies.
- Coalesce only latest values for the same epoch, entity, parameter and send
  destination. Do not coalesce transactions, mix independent controls, or let
  an old positional track index target a reordered track without validation.
- Unknown completion/timeouts must not invite a blind duplicate retry. Keep
  drafts separate until the exact applied acknowledgement or an explicit
  rejection/resolution path is observed.

Acceptance: stalled command queue then same-Core project replacement/reopen,
reused IDs, reorder, two parallel send controls, payload/count exhaustion,
admission versus delayed/rejected application, lost/late replies, Undo/Redo
branches and continuous playback. Record retained RAM and confirmation latency.
Keeping HTTP/TCP commands plus latest-wins UDP telemetry is appropriate; a
WebSocket/Socket.IO migration does not supply these application semantics.

## P1 — manual Touch/Latch/Write is not yet a complete live lifecycle

Entry points: `timeline/automation/hooks/useAutomationTouchRecorder.ts`,
`logic/automationTouchController.ts`, `logic/automationTouchSession.ts`,
`timeline/tracks/components/TimelineSidebar.tsx`, shared fader/knob wrappers,
and `MainComponentBuilderAutomation`/native automation playback.

The audited hook is instantiated only in TimelineSidebar. It buffers points
until release/Stop; adding callbacks to shared controls does not wire every
mixer/inspector/plugin surface. `cycleRange` is not supplied at that call site.
The current beat calculation uses one BPM rather than the song TempoMap.
Tests of the final record-gesture HTTP endpoint do not prove manual-control
ownership while Touch/Latch is active.

Additional confirmed session hazards: points grow without a cap; retouch can
replace a held Latch session rather than continue its pass; default release
can substitute zero; cycle detection is not subscribed to advancing playhead;
reset is keyed only by song index. A same-song project replacement followed by
Stop can therefore submit an old lane to the new document. The default commit
uses best-effort API behavior rather than surfacing a recording rejection.

Required implementation:

- Establish one explicit owner for manual override versus automation playback.
  Touch must sound the live value while held, then return to the underlying
  curve. Latch must continue the last touched value until punch-out/Stop. Write
  must have a documented destructive interval and reliable safety revert.
- Bind all supported surfaces intentionally, or disable/label unsupported
  write modes rather than claiming full integration. Do not install a second
  application hotkey dispatcher or infer touch from telemetry echoes.
- Use authoritative song-local beats/TempoMap and cycle boundaries. Split
  cross-cycle gestures without extending a pass across the loop discontinuity;
  handle seek, song change, same-ID reopen and transport loss explicitly.
- Bound point/session storage and request rate; thin outside audio. One user
  pass must produce one coherent history transaction, not one undo per sample.
- Reliable rejection must be visible. Preserve a recoverable draft or explicitly
  roll it back. Old async completion must not write into a new project epoch.
- Escape/pointercancel/lost capture/unmount must cancel or finish according to a
  documented policy. Do not silently commit a cancelled gesture.

Acceptance: actual UI fader/knob gestures while playing, audible manual override,
release ramps, sustained Latch, Stop/seek/cycle, multiple controls, rejection,
same-ID reopen, Undo/Redo branch and save/reopen. Include failed/removed vendor
parameters and do not call packet collection alone live recording acceptance.

Preserve unrelated automation outside the punch window. The audit found
`core/engine/automation/AutomationRecorder.cpp` replaces in-window points and
adds endpoints without preserving the interpolated shape of a segment that
spans a boundary. Add before/after envelope-evaluation tests for linear and
curved segments on both sides. If the stored curve representation cannot
exactly split a segment, document a bounded error-tolerance/resampling policy;
do not silently change neighboring playback outside the user's recorded pass.

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

## P1 — define consistent offline Write-mode policy

The current policies disagree: `StripAutomationPlan.cpp` skips Write lanes in
both live and offline strip evaluation; live `AudioEngineAutomation.cpp` skips
Write for plugin/MIDI lanes too. However, `OfflineRenderer.cpp::applyAutomationLane`
checks enabled/muted/points, not Write, so offline plugin/MIDI curves still play.
Offline rendering has no live manual gesture to replace omitted strip values.
Specify whether a saved Write lane renders its stored curve or the captured
manual/static value; implement one deliberate policy across strip/plugin/MIDI
scopes and expose any warning.
Do not silently export a different mix merely because a recording mode was
left armed. Add snapshot/roundtrip/live-versus-offline output tests. This policy
remains open until documented and verified; disabling controls alone does not
resolve already-saved projects.

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

1. Publish immutable, bounded project playback data for audio-callback readers.
   Inventory all callback reads and write/publish sites first. Keep the transport
   and sample clock running; do not hide races by locking editor commands or
   restarting healthy plug-in helpers. A missing/over-budget publication must
   have an explicit health/status path and must never fall back to mutable
   `Project` vectors.
2. Complete Core-owned live manual-value arbitration for Touch/Latch/Write, then
   wire each supported control surface and handle TempoMap, cycle wrap, Stop,
   seek, project epoch, rejection recovery and one coherent history action.
3. Bind edits to project epochs and applied request/revision acknowledgements;
   bound client retained bytes and coalesce continuous values by full stable
   target identity.
4. Validate MIDI-region embedded automation lanes before history/mutation;
   define live/offline Write rendering and preserve the old envelope outside a
   recorded punch window.
5. Recover automation whose plug-in slot was removed; cache immutable parameter
   descriptors by epoch/slot/generation rather than refetching all visible slot
   tables on a timer.
6. Finish TempoMap-based Piano Roll ruler/cycle/project-axis positioning, then
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
