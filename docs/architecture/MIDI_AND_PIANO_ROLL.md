# Architecture Specification: MIDI Engine & High-Performance Piano Roll

**Status**: implemented MIDI-region/Piano Roll foundation, with expressive and
interoperability work remaining. Source review: 2026-10-01.

## Current implementation and boundaries

The authoritative types are in `core/engine/project/ProjectSchema.h`; examples
below are abbreviated, not definitions to copy into code. MIDI 1.0 remains the
live hardware/plug-in bridge. MIDI Clip File/project UMP preservation does not
make per-note expression, note IDs, or native live UMP delivery complete; see
[MIDI2_REMAINING_WORK.md](../MIDI2_REMAINING_WORK.md).

The editor lives in `ui/src/screens/editor/pianoroll/`, with components, hooks,
pure logic, and tests separated by ownership. Toolbar composition uses the
same shared HeroUI wrappers as the arrangement. Track/region selection and
R/I/M/S stay in `PianoRollHeader`; the project ruler/cycle remains the shared
arrangement component. Transformations and harmonic options use compact
feature-owned popovers rather than parallel rows of unrelated text buttons.

Verified source mechanics include primary-button-only edits, existing-note
selection in Draw, remembered single-note length, additive Shift-marquee,
group-bound movement/resize, bounded Brush sweeps, velocity stroke editing and
double-click reset, and cleanup of uncommitted gestures on region change,
Escape, or lost pointer capture. Core owns shared history; optimistic note
images are temporary UI views, not independent project state.

Active key illumination consumes complete current-track telemetry bitmaps.
It must replace, not union, snapshots; authoritative empty snapshots clear
released keys. Sustain is retained as ordinary CC64 events and drawn minimally
in region/Piano Roll previews. Channel pitch-bend automation is not per-note
MIDI 2.0 glide.

---

## 1. Motivation & Principles

To evolve ResoStage into a professional live-first DAW, MIDI must be a first-class timeline citizen alongside audio stems. Live performance demands deterministic, sample-accurate MIDI event scheduling, while arrangement demands an editor that matches the speed and fluidity of FL Studio and the harmonic depth and editing precision of Logic Pro.

Key design principles:
1. **Sample-Accurate Audio Alignment**: MIDI notes scheduled on the timeline are dispatched directly inside the audio block (`audioDeviceIOCallbackWithContext`) at the exact sample offset matching their beat position.
2. **Zero Audio-Thread Allocations**: MIDI buffers passed to strip generator plugins are preallocated inside `StripPluginChain`. Stamping note-ons, note-offs, and controllers never allocates on the heap.
3. **Canvas 2D Spatial Indexing**: Notes and overlays use Canvas 2D with a TypeScript bucket index, avoiding a DOM element per note. Frame-rate targets require measured workloads; there is no quad-tree or universal 60/120-FPS guarantee.
4. **Universal MIDI 1.0 & 2.0 / UMP Foundation**: The internal data structures represent pitch, velocity, and durations with floating-point or high-resolution integers compatible with both classic MIDI 1.0 and high-resolution MIDI 2.0 / Universal MIDI Packets (UMP).

---

## 2. Core MIDI Data Structures

### 2.1. Note Definition (`MidiNote`)

```cpp
struct MidiNote {
    uint64_t id{0};               // Numeric note ID; region IDs are UUIDv7 strings
    uint8_t pitch{60};            // 0-127 (60 = Middle C / C4)
    double startBeats{0.0};       // Musical position in beats relative to region start
    double durationBeats{1.0};    // Musical duration in beats
    float velocity{0.8f};         // Normalized 0.0 - 1.0 (maps to 1-127 in MIDI 1.0)
    float releaseVelocity{0.5f};  // Normalized 0.0 - 1.0
    float probability{1.0f};      // 0.0 - 1.0 for generative/humanized playback
    int8_t pan{-1};               // Per-note pan (-1 = default/inherited, 0-127 MIDI 2.0)
    int8_t tuningOffsetCents{0};  // Per-note microtonal detune in cents (-100 to +100)
    bool muted{false};            // Note-level mute
};
```

### 2.2. Region Definition (`MidiRegion`)

```cpp
struct MidiRegion {
    std::string id;               // Namespaced ID: "midi::region:<uuid>"
    std::string name;             // Display label
    double startBeats{0.0};       // Timeline start in beats
    double durationBeats{16.0};   // Total region duration on timeline in beats
    double clipOffsetBeats{0.0};  // Beat offset into internal note pattern
    bool loop{false};             // Whether the region loops
    double loopLengthBeats{16.0}; // Loop repetition length
    std::string color{"#3b82f6"}; // Hex color string
    std::vector<MidiNote> notes;  // Note container, sorted by startBeats
};
```

The complete region also has `trackId`, `loopStartBeats`, mute state, retained
MIDI 1.0 events, timed opaque UMP events, and automation lanes. Notes include a
source channel and optional exact 16-bit MIDI 2.0 velocity/group/attribute data.
`clipOffsetBeats` is source phase; the half-open source loop window is bounded
by `loopStartBeats` and `loopLengthBeats`. Left trim shrinks that visible window;
split preserves phase. Source-note coordinates are not rewritten for each
displayed loop iteration.

---

## 3. Real-Time Audio Block MIDI Scheduling

`core/app/engine/AudioEngineEventDispatch.cpp` prepares live sequenced MIDI
against the block's tempo/sample range. At a high level, during each block:

1. The block's time range is computed in samples: `[hwSamplePosition, hwSamplePosition + numSamples)`.
2. The active `TempoMap` converts sample positions to beat positions: `[blockStartBeats, blockEndBeats)`.
3. For each active `Instrument` or `MIDI` track:
   - Identify active `MidiRegion`s intersecting `[blockStartBeats, blockEndBeats)`.
   - Apply the region's trim/loop/source phase and find triggering notes/events.
   - For note-on:
     `sampleOffset = tempoMap.beatsToSamples(regionStartBeats + note.startBeats) - hwSamplePosition`.
     Clamp `sampleOffset` to `[0, numSamples - 1]`.
     Write `juce::MidiMessage::noteOn(channel, note.pitch, (uint8)(note.velocity * 127))` into the preallocated buffer.
   - For note-off:
     `sampleOffset = tempoMap.beatsToSamples(regionStartBeats + note.startBeats + note.durationBeats) - hwSamplePosition`.
     Clamp `sampleOffset` to `[0, numSamples - 1]`.
     Write `juce::MidiMessage::noteOff(channel, note.pitch, (uint8)(note.releaseVelocity * 127))`.
4. The strip's plugin chain invokes `MixProcessorView` with the filled `juce::MidiBuffer`.
5. Immediately after block execution, the buffer is reset with `clear()` without deallocating.

---

## 4. High-Performance Piano Roll UI

### 4.1. Rendering Architecture
- **Layer 1: Background & Grid Canvas**:
  - Vertical piano roll keys / drum labels on the left margin.
  - Horizontal grid lines for semitones.
  - Scale highlighting: Root key and scale mode (e.g. D Minor) visually shade non-scale rows in dark tones, while in-scale rows are highlighted.
  - Vertical bar, beat, and sub-beat lines adjusted dynamically with zoom.
- **Layer 2: Ghost Notes Canvas**:
  - Reads notes from other MIDI tracks within the same section/song.
  - Rendered with low opacity (~20-30%) and dashed/subtle borders.
  - Selected other regions may appear as non-editable ghost notes; primary
    region ownership remains explicit. Editable ghost-note switching is a
    possible future workflow, not a current guarantee.
- **Layer 3: Active Notes Canvas**:
  - Rendered with high-contrast rounded rectangles.
  - Track-theme color with velocity-dependent opacity and contrast-aware text.
  - Selected-note treatment is separate from track focus; the canvas uses theme
    surfaces and solid row highlights, not additive glowing backgrounds.
  - Muted notes rendered with diagonal hash lines or dimmed grey.
- **Layer 4: Interactive Overlays**:
  - Playhead cursor line with micro-interpolation.
  - Marquee selection rectangle.
  - Note creation / brush preview shadow.
- **Layer 5: Property / Velocity Lane Canvas**:
  - Bottom strip displaying vertical lollipop stalks with circular heads representing note velocity.
  - Dragging across stalks performs linear ramp, curve shaping, or compression.
  - Bottom-lane choices expose note attributes and channel-controller editing;
    labels must not imply unsupported native per-note MIDI 2.0 expression.

### 4.2. Spatial Indexing
The bucket index reduces work to the queried viewport:
- Default cells cover 4 beats × 1 octave, not four bars in every meter.
- Query cost follows intersected buckets and their candidate notes, with
  deduplication for notes spanning cells; it is not a proven $O(\log N + K)$ tree.
- Canvas render loops iterate strictly over visible notes.

Large-note-count/weak-machine frame-time measurements remain necessary before
publishing a numerical density or frame-rate claim.

### 4.3. Creative Editing Workflows
- **Quick Stamp**: Single-click adds note with current default duration and velocity.
- **Brush Tool**: Dragging paints consecutive notes snapping to the current grid (1/16, 1/8, etc.).
- **Chords & Scales**: Stamp triads, 7ths, 9ths, and inversions directly in scale.
- **Strum / Arpeggiate**: Micro-staggers note start times within a selected chord with customizable curve.
- **Humanize**: Adjustable randomization of velocity ($\pm \Delta v$) and micro-timing ($\pm \Delta t$).

## Validation still required

- Inspect wide/narrow toolbars, long region names, light/dark themes, no/single/
  multi selection, loop and snap toggles, and all bottom lanes.
- Test Draw before/beyond a loop, dragging/resizing during accelerated scroll,
  Shift-click/marquee, Escape mid-drag, and rapid region switch before command
  acknowledgement. Verify default velocity reset and note-length memory.
- Exercise global undo/redo and deletion repeatedly with remote latency; key
  illumination and shared project-cycle/follow behavior need actual playback.
- Preserve the difference between global project cycle and MIDI-region repeat.

Focused coverage lives in `tests/gestures.test.ts`, `gestureLifecycle.test.ts`,
`noteActions.test.ts`, `pianoRollModel.test.ts`, and `playheadFollow.test.ts`.
Passing pure tests/builds does not replace the visual/music checks above.

## Primary references used for editing policy

- [Apple: Add notes](https://support.apple.com/guide/logicpro/lgcpa904cb3a/mac)
- [Apple: Snap to grid](https://support.apple.com/guide/logicpro/lgcpa9051d7a/mac)
- [Apple: Modifier keys](https://support.apple.com/guide/logicpro/lgcp9a4b36c6/mac)
- [Ableton Live 12: Editing MIDI](https://www.ableton.com/en/live-manual/12/editing-midi/)

These manuals inform deliberate UI choices; ResoStage's existing cross-platform
hotkeys and the user's requested existing-note Draw selection take precedence
over copying another DAW's erase-on-click gesture.
