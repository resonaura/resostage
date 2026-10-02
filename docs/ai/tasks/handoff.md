# ResoStage continuation handoff

Updated: 2026-10-01. Read `AGENTS.md` before changing code; it is the
architectural contract. Then read the relevant detailed plans below. This file
is a status handoff, not proof that unfinished acceptance criteria passed.

## Current state

- Recent work is on `main`; do not push unless the user asks.
- Completed commits in this work sequence:
  - `5e26397` — Add touch session lifecycle and return ramp model for live automation recording
  - `84642ad` — Preserve automation continuity and boundary points across region splits
  - `83900dc` — Add arrangement timeline automation lane editing and scoped visibility controls
  - `a30a2da` — Add comprehensive HTTP media import acceptance to media acceptance harness
  - `148de9a` — Add allocator probe and latency percentiles evidence across block sizes
  - `fde3445` — Surface plug-in deadline misses and queue diagnostics in health telemetry
  - `722c6fd` — Add unit test for multi-track recording count-in calculation and sample-accurate capture gating
  - `2e7b495` — Make plugin host control timer adaptive with event-driven wakeups
  - `13bf9f7c` — Preserve instrument MIDI during state snapshots
  - `2242eee2` — Sync track power guards with isolated plugins
  - `714f802a` — Record packaged media export acceptance
  - `c4af206` — Update native and UI validation evidence
- A focused acronym cleanup in this snapshot canonicalizes WAV/UDP/HTTP/DMX
  names and WAV/UDP source filenames, retaining legacy aliases for source
  compatibility. It passed the Core build and native suite; the broader acronym
  inventory and cross-language/platform audit are still open.
- The latest recorded regression runs: Core target build; 546 native test cases
  / 287,194 assertions; UI 602 tests across 94 files; Electron 37 tests.
  Plugin host control timer is now event-driven (immediate callAsync dispatch
  on wake) with adaptive 8 ms/50 ms interval. Bounded deadline misses and queue
  rejection diagnostics are now surfaced to the Health UI. An allocator probe
  and latency percentiles (p50/p95/p99/max) across 64/128/256/512 frames prove
  zero heap allocations during block render with PDC active. These do not establish
  real-device audio stability or heavy third-party plug-in performance.
- Packaged macOS ARM64 media acceptance passed for nine export formats
  (WAV/AIFF/FLAC/ALAC/MP3/M4A/Opus/OGG/WMA), non-silent decode, custom Unicode
  destination persistence across restart, invalid destination handling, and
  legacy request behavior. Production HTTP media import acceptance also passed
  (successful audio/video, retained original video in package, no-audio video
  rejection, corrupt source rejection, duplicate filename handling, aborted
  upload cleanup, 409 rejection, song boundary extension, and restart persistence).
  Do not generalize this to other platforms or heavy plug-in renders.

## Protect these local changes

The following working-tree edits were already present and belong to the user;
do not stage, rewrite, or discard them as part of unrelated work:

- `core/tests/test_plugin_power_manager.cpp` — synthetic benchmark threshold
  relaxed from 15x to 5x.
- `ui/src/screens/editor/timeline/regions/components/LiveRecordingRegion.tsx`
- `ui/src/screens/editor/timeline/regions/tests/LiveRecordingRegion.test.tsx`
  — live recording preview styling and concurrent audio/MIDI preview test.

Check `git status` before staging. Stage only files belonging to the change being
committed. Existing history and these local edits are user work.

## Remaining work, in priority order

1. **Plugin engine performance and stability** — continue from
   [`performance.md`](performance.md). Obtain realistic saved-state AU/VST3
   measurements at 64/128/256/512 frames, callback p50/p95/p99/max, underruns,
   helper misses/CPU, PDC alignment and loop/seek recovery. Add allocator-probe
   evidence for the whole callback. Test MIDI sustain/panic during deliberately
   slow vendor state capture and verify acoustic continuity. Investigate the
   helper's idle 8 ms control timer only if an event-driven replacement preserves
   editor/parameter/state/latency responsiveness. Surface useful deadline and
   queue diagnostics. Changed-latency PDC refill continuity remains open.
   Synthetic tests are not acoustic acceptance; state vendor/hardware fixture
   availability honestly.

2. **Bundled FFmpeg/media acceptance** — continue from [`media.md`](media.md)
   and `docs/FFMPEG.md`. Exercise the production HTTP import-begin/upload/finalize
   path for audio/video, no-audio video, corrupt input, duplicate names,
   cancellation/disconnect, queue rejection, song extension, and save/reopen.
   Confirm failure leaves no partial project/history/temp artifact. Exercise
   heavy AU/VST3 render, multiple stems/ranges, cancellation, output collisions,
   effects-before-conversion and atomic publication. Revalidate release packages,
   bundled helper metadata/signatures and dependency source/build-recipe
   compliance. Physical Intel macOS, Windows ARM64, and Linux ARM64 are not
   covered by the existing macOS ARM64 pass; do not claim they are.

3. **Arrangement automation editing** — not implemented as a complete
   arrangement workflow. Start with [`automation.md`](automation.md) and
   `docs/architecture/AUTOMATION_MODEL.md`. The existing plug-in automation
   panel/mini-graph is only a foundation. Implement scoped timeline automation
   lanes, target selection, editing tools, gesture cancellation and one shared
   history transaction; preserve Core as authority and keep allocation/vendor
   work out of the audio callback. Follow the plan's schema, migration, target
   identity, live/offline parity and acceptance requirements. Do not copy product
   names/assets from research into source.

4. **Acronym naming audit** — continue [`naming.md`](naming.md). Recent canonical
   WAV/UDP/HTTP/DMX changes are only a slice. Inventory internal source symbols,
   filenames, build references and docs for WAV, MIDI, UUID, HTTP, UDP, DSP, PDC,
   BPM, VST3, AU and similar terms. Keep external protocols, persisted schema
   keys, JUCE API spelling and compatibility aliases stable. Avoid case-only
   duplicate paths on macOS/Windows; use a two-step `git mv` for case changes.
   Finish Core/native, UI, Electron alias-resolution and script tests, plus
   available platform builds before deleting the task file.

## Working rules

- Keep commits small and isolated by completed work block; commit messages are
  English. Do not push without explicit instruction.
- Preserve source comments and the exact ResoStage copyright/license header
  required by `AGENTS.md` whenever source files are created or edited.
- Keep internal frontend imports on `@/`; keep the UI/Electron resolvers and
  tests aligned.
- Never delete the four task plans above until their acceptance criteria are
  actually complete. Update status/evidence rather than marking aspirational
  work as finished.
- Do not overwrite recent projects or change the user's saved device/rig
  settings during tests. Use isolated temporary settings/project/output paths.
- Current tests and packaged export acceptance passed on the dates stated above;
  rerun the relevant suites after each new code block and report limits plainly.
