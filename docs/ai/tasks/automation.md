# Arrangement automation editing

Status: planned, not a shipped arrangement workflow. Begin after the current
plug-in stability/performance fixes. Read `AGENTS.md` and
[the domain reference](../../architecture/AUTOMATION_MODEL.md) first.

## Existing foundations — reuse rather than replace

- `core/engine/project/ProjectSchema.h`: song/audio-region/MIDI-region lanes,
  `AutomationTarget`, scope, points in musical beats, and write-mode enums.
- `core/engine/automation/`: curve/evaluator/recorder/thinning primitives.
- `core/app/main/builder/MainComponentBuilderAutomation.cpp`: message-thread
  builder commands and shared project-history ownership.
- `core/app/engine/AudioEngineAutomation.cpp`: current block-rate live dispatch;
  offline automation must remain equivalent to the private render session.
- `ui/src/screens/mixer/plugins/components/{PluginAutomationPanel,AutomationMiniGraph}.tsx`:
  existing parameter discovery and plug-in lane editing, not arrangement lanes.
- `ui/src/screens/editor/timeline/`: shared project ruler, coordinates, cycle,
  snapping, playhead, track heights, virtualization, tools, selection, history.
- `ui/src/lib/interaction/HotkeyManager.ts`: one dispatcher; fixed gestures
  must not bypass Musical Typing/input/modal focus protection.

The attached 662-line research was read in full on 2026-10-01. Treat its UI
descriptions as reference, not copied assets/code or proof of legal clearance.
Use product-neutral component names, comments, icons, and theme tokens. Do not
claim sample-accurate vendor automation where the existing bridge is block-rate.

## Implementation order

1. Add a shared-toolbar automation visibility toggle and a scoped command.
   Preserve normal region tools when off; when on, dim region content using
   existing theme material, not a new hardcoded palette. Keep audio playback
   independent of display state. Organize `timeline/automation/` into
   `components/`, `hooks/`, `logic/`, and `tests/`.
2. Extend track headers with scope, parameter, write mode, and expandable
   sublanes. One primary lane plus explicit additional lanes avoids rendering
   every vendor parameter. Provide searchable grouped targets: strip gain,
   pan, mute; sends; each stable plug-in instance; available MIDI CC/bend.
   Unsupported targets are disabled with a reason, not empty working controls.
3. Add a pure viewport/coordinate and hit-test model. Time must use the same
   song/project mapping and snap service as regions. Draw only the viewport;
   density/LOD decimation must retain extrema and original editable points.
   Add/select/drag nodes, segment displacement, curvature, rubber-band/range
   selection, freehand draw, erase, copy/paste/duplicate and numerical editing.
   Multi-node movement preserves relative offsets and ordering. Esc, pointer
   cancel, focus loss, project replacement and disconnect revert the gesture.
4. One pointer/write gesture is one shared history transaction. Use a local
   draft for responsive previews and commit a validated bounded patch; do not
   send a history step for every pointermove. Late snapshots cannot overwrite
   a new draft, and accepted commands are not assumed applied until confirmed.
   Validate finite time/value/curve, target existence, point limits, duplicate
   times and invalid/no-op transactions. Reuse Core history request/revision
   correlation rather than creating a second editor history.
5. Define scope semantics before editing operations: track lanes are song-time
   anchored; region lanes move/copy with their region and use the *trimmed source
   loop window*. Split/trim/copy evaluates boundary values without deforming
   adjacent segments. Specify overlap priority and optional track-automation
   follows-region edits (`always`, `never`, `ask`) deliberately. Musical beats
   already exist; absolute-time locking needs an explicit schema/migration,
   not silently interpreting `timeBeats` as seconds. Multi-song changes must
   preserve each song's BPM/meter and export tempo-map behavior.
6. Integrate strip controls and live write lifecycle: engine-read, user-touch,
   return-ramp ownership. Read must not write; Touch returns smoothly; Latch
   holds until stop; Write is destructive, scoped to armed targets, and reverts
   to a safe mode after stop. Group a pass in history, thin off the callback,
   handle loop/punch/seek/stop/project change and controller disconnect. UI
   displays authoritative effective values without fighting a held fader.
   Do not call allocating recorder/vector APIs from the audio thread.
7. Compile target mappings/indexes off audio. Reordering a plug-in must retain
   slot UUID ownership. Current `param:<index>` is not a stable vendor ParamID:
   discover/persist actual vendor IDs (and migrate legacy indexes safely) before
   promising parameter identity across vendor updates. Removed/missing/failed
   plug-ins leave recoverable orphan lanes, never redirect to another plug-in.
   Keep MIDI takeover/feedback suppression and native sample-offset vendor
   automation as explicit integrations with their own protocol/version tests.

## Real-time requirements

No callback waits, vendor-state capture, disk/network work, vector growth, or
per-point string lookup. Publish immutable prepared automation snapshots with
project epoch/layout compatibility. Smoothing must preserve gain/pan laws and
PDC timing; derive sample/host timestamps from the actual sample clock, not UI
timers or unverified timing formulas from the research. Discrete controls need
defined step/crossfade semantics; bypass must not casually destroy latency or
tails. Offline and live rendering share curve/target semantics.

## Acceptance

- Pure coordinate, snap, curve, boundary, LOD and multi-selection tests.
- Pointer tests for all tools, empty lanes, overlapping tracks, narrow/large
  zoom, autoscroll, cancellation, stale revision and shared Undo/Redo branching.
- Native persistence/migration, reordering/removal/orphan target, chase, tempo,
  cycle/punch, bounded queue overflow and live/offline equivalence tests.
- Real AU/VST3 saved-state tests at multiple block sizes; separately report
  block-rate versus sample-accurate capabilities, vendor skips and hardware.
- Visual checks in both themes and several track densities; reuse shared
  toolbar/design wrappers, project/track colors, ruler and topmost playhead.
- Test manual control ownership, touch release, sustain/MIDI focus and hotkeys
  with Musical Typing open. Do not claim motorized feedback without hardware.

Trim/relative layers, VCA groups, MIDI-focused hardware mapping, and full
lighting integration follow only after the base workflow passes. This plan
does not itself implement those features or establish patent/legal safety.
