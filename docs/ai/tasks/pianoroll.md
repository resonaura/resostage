# Piano Roll toolbar and mechanics

## Goal

After FFmpeg, make the Piano Roll toolbar as coherent and usable as the Editor
timeline toolbar, and research official DAW documentation for practical editing
mechanics. Preserve existing gestures, hotkeys, global history, and project-based
time/cycle semantics.

## Components and ownership

- `ui/src/screens/editor/pianoroll/components/PianoRollToolbar.tsx`,
  `PianoRollHeader.tsx`, `PianoRollProjectHeader.tsx`, follow/zoom controls.
- Existing timeline toolbar, shared DAW controls under `ui/src/components/daw`,
  and design-system wrappers under `ui/src/components/ui` are the source of
  visual rules. Reuse actual components when semantics match.
- Pointer/command/note/viewport hooks and pure logic stay in their feature
  `hooks/` and `logic/` folders; tests remain in `tests/`.
- `HotkeyManager` is the single shortcut dispatcher; Core/global project
  history and cycle are authoritative.

## Plan

1. Inspect the current timeline/Piano Roll toolbar and all callers. Read the
   HeroUI skill and use current wrapper APIs; avoid ad hoc duplicated controls.
2. Research primary documentation (Logic Pro/Ableton/other DAW official manuals)
   for draw/select, note-length memory, velocity, snapping, multi-selection,
   keyboard nudging, audition, and cycle/follow. Cite sources and distinguish
   observed ResoStage behaviour from proposed changes.
3. Rebuild the toolbar composition with the same `Toolbar`, `ButtonGroup`,
   `ToggleButtonGroup`, `Separator`, and themed `Select` wrappers as the main
   timeline. Keep history/selection editing, tools, snap, follow, and zoom in
   the primary strip. Put transformations and harmonic/region options in
   compact menus/popovers so the panel does not become several rows of text
   buttons. Preserve track/region linkage and R/I/M/S in `PianoRollHeader`.
4. Fix concrete discovered mechanics regressions in small, tested changes;
   do not change familiar shortcuts or musical timing based on guesswork.
5. Run focused pointer/logic/command tests, UI typecheck/build, and inspect
   narrow/wide layouts and dark/light themes. Record what was visually checked.

## Status

Read-only audit and primary-source research completed on 2026-09-30. UI
implementation is queued behind FFmpeg verification. Current worktree contains
copyright header changes that must be preserved. `AGENTS.md` and the HeroUI v3
skill were read in full before the audit.

## Audited components and exact reuse points

The visual reference is
`ui/src/screens/editor/timeline/toolbar/components/TimelineToolbar.tsx`. It uses
`bg-background-secondary`, small grouped icon buttons, separators, a selected
tool group, a snap toggle, a three-mode follow control, and two compact zoom
sliders. The current Piano Roll toolbar instead places all operations directly
in a wrapping flex row, mixes text buttons and native `<select>` elements, and
uses a different background/sizing policy.

Implement with these existing parts:

- `@heroui/react`: `Toolbar` and `Separator`, following the timeline call site;
  `Dropdown`/`Popover` may be used for compact controls (the app has no wrappers
  for those two yet, so fetch their v3 APIs and theme them with current tokens).
- `@/components/ui`: `Button`, `ButtonGroup`, `ToggleButton`,
  `ToggleButtonGroup`, `Select`, and `Slider`. Read the
  current wrapper exports before using them; the app is HeroUI v3, not v2.
- `PianoRollFollowControl.tsx`: preserve the existing off/standard/smooth
  semantics and right-click catch-on-play/catch-on-seek menu. Remove its extra
  border/padding when the toolbar owns the separators. This is currently the
  same policy as the timeline; a later extraction to a shared DAW control is
  appropriate if both callers are changed together.
- `PianoRollZoomControl.tsx`: align footprint, icon opacity, and slider wrappers
  with the timeline. Add `useEscRevert` to both sliders, as the timeline already
  does. Do not reset the musical focus merely to change toolbar styling.
- `PianoRollHeader.tsx`: retains track/region selection, current-track color,
  and shared `TrackStateButtons`; do not duplicate those controls in the
  toolbar.
- `PianoRollProjectHeader.tsx`: already reuses the arrangement ruler/cycle
  implementation. Preserve project bars and the global project cycle. The
  pattern-repeat option belongs to MIDI-region content and must remain clearly
  distinguished from the global playback cycle.

Suggested primary layout: title/selection count, history group, note editing
group (copy/delete/cut/split), tool group, snap toggle+division, transform menu,
region/options menu, bottom-lane selector, follow, zoom. Use icon-only editing
controls with accessible labels and shortcut metadata. Keep groups indivisible
when wrapping; narrower layouts should wrap between groups, not individual
buttons. Root/scale/scale-snap and ghost-note controls belong in the options
popover; quantize/humanize/legato/trim-overlap/transposition belong in the
transform menu. No existing operation is removed.

## Concrete mechanics findings

These are code-level findings, not claims of a manually reproduced UI bug.
The first implementation pass should fix the narrow, deterministic cases and
record the actual test evidence below.

1. `usePianoRollPointerDownHandler` currently accepts every pointer button and
   captures it before lane/tool handling. Right/middle clicks can therefore
   create/edit notes. Gate edit gestures to the primary button before capture.
2. Shift-marquee does not preserve the prior selection:
   `usePianoRollPointerMoveHandler` replaces it with the notes inside the box on
   every move. Snapshot the initial additive selection and union it with the
   marquee hits, while plain marquee remains replacement selection.
3. `PianoRollCanvas` clears controller drafts on `region.id` change, but does
   not clear `localNotes`, `pendingCommitRef`, or a note drag. A region switch
   while an edit is awaiting Core acknowledgement can show the previous
   region's working notes. Reset the complete speculative gesture state and
   stop auto-scroll when region identity changes.
4. `PianoRollZoomControl` lacks the shared Escape-revert lifecycle. This is a
   concrete parity gap with the arrangement toolbar.
5. The brush handles only the currently sampled pointer position. Fast
   horizontal moves can skip intervening snap cells. Velocity painting already
   sweeps the entire interval; use a bounded grid sweep for brush too, with a
   documented maximum per event and no duplicate notes.
6. The snap picker labels a fixed four-quarter-note value as `1 Bar`, even in
   3/4, 6/8, or another meter. Prefer musical whole/half note labels for fixed
   beat values, or compute a separate actual-bar option from numerator and
   denominator. Do not label four beats as a universal bar.
7. Pointer move/resize clamps each selected note independently at pitch/time
   bounds. This can alter intervals/rhythm within a group. A future parity
   pass should clamp one shared delta against the entire selection. This is
   deliberately separate from the toolbar change.

Existing correct behaviour to protect: clicking an existing note with Pencil
uses the Select path; a Pencil click inherits the last singly-selected note
length; draw dragging uses the pointer span; the velocity double-click resets
to `DEFAULT_NOTE_VELOCITY`; velocity strokes are independent of pitch
virtualization and sweep skipped pointer positions; the optimistic note image
remains visible until Core acknowledges it; commands go through
`HotkeyManager`, and region edits use global Core history.

## Official research and design decisions

- [Apple: Add notes](https://support.apple.com/guide/logicpro/lgcpa904cb3a/mac):
  Pencil adds at the clicked position and dragging changes length; existing
  edits can define defaults; Brush repeats using the quantize division and
  supports a pitch constraint. Keep the user-requested existing-note selection
  and last-single-note-length behaviour. Do not import Ableton's erase-on-click
  Draw semantics, because it conflicts with this product's explicit request.
- [Apple: Snap to grid](https://support.apple.com/guide/logicpro/lgcpa9051d7a/mac):
  the Piano Roll has its own note grid, with both relative and absolute
  positioning and temporary fine editing. Current move-delta snapping already
  preserves a note's offset. Preserve that; a future absolute-snap option needs
  explicit state and tests.
- [Apple: Modifier keys](https://support.apple.com/guide/logicpro/lgcp9a4b36c6/mac):
  fine timing, exact note insertion, same-length/same-velocity edits, and
  pitch-constrained Brush are distinct gestures. Use these as feature ideas,
  not a reason to override the app's established cross-platform dispatcher.
- [Ableton Live 12: Editing MIDI](https://www.ableton.com/en/live-manual/12/editing-midi/):
  note editing is selection-based; Shift adds to marquee selection; pitch keys
  can select notes at that pitch; snap preserves loose offsets; preview has an
  explicit toggle; follow pauses for manual edits. This supports fixing
  additive marquee and a later explicit audition toggle. Keep MIDI illumination
  authoritative through the existing active-note telemetry rather than local
  note-event accumulation.
- [HeroUI v3: Toolbar](https://heroui.com/docs/react/components/toolbar):
  group controls with the accessible toolbar navigation pattern. Component
  docs for Toolbar, Button, ButtonGroup, ToggleButton, ToggleButtonGroup,
  Select, Dropdown, and Popover were fetched during the audit. The skill lives
  at `/Users/resonaura/.agents/skills/heroui-react/SKILL.md`.

## Verification and remaining work

- Baseline on 2026-09-30: `pnpm --dir ui test --
  src/screens/editor/pianoroll/tests/pianoRollModel.test.ts
  src/screens/editor/pianoroll/tests/canvasUtils.test.ts` completed successfully.
  The package script passed all 65 files / 436 tests because its Vitest argument
  forwarding ran the full UI suite; this is baseline evidence, not UI
  implementation verification.
- No UI implementation or visual acceptance has happened in this task yet.
- After implementation, add focused tests for button gating, additive marquee,
  region-switch speculative-state clearing, and any brush sweep helper. Avoid
  tests that only duplicate markup.
- Run UI typecheck, focused/full tests as appropriate, and lint on edited files.
- Inspect the toolbar in light/dark themes at wide and narrow widths, with no
  selection/multi-selection, loop on/off, snap on/off, all bottom lanes, and a
  long region name. Verify keyboard focus/arrow navigation remains in the
  toolbar while note shortcuts are handled only when the editor owns focus.
- Manual music checks: Pencil click/drag before and beyond a loop, selected-note
  drag/resize under auto-scroll, Shift-click and Shift-marquee, Escape mid-drag,
  rapid region switch before HTTP acknowledgement, double-click velocity,
  global undo/redo, current-track keyboard illumination, and project cycle.
