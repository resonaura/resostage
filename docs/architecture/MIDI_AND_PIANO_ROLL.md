# Architecture Specification: MIDI Engine & High-Performance Piano Roll

**Status**: `IN_PROGRESS` (Phase 2 & Phase 3)

---

## 1. Motivation & Principles

To evolve ResoStage into a professional live-first DAW, MIDI must be a first-class timeline citizen alongside audio stems. Live performance demands deterministic, sample-accurate MIDI event scheduling, while arrangement demands an editor that matches the speed and fluidity of FL Studio and the harmonic depth and editing precision of Logic Pro.

Key design principles:
1. **Sample-Accurate Audio Alignment**: MIDI notes scheduled on the timeline are dispatched directly inside the audio block (`audioDeviceIOCallbackWithContext`) at the exact sample offset matching their beat position.
2. **Zero Audio-Thread Allocations**: MIDI buffers passed to strip generator plugins are preallocated inside `StripPluginChain`. Stamping note-ons, note-offs, and controllers never allocates on the heap.
3. **Canvas 2D Spatial Indexing**: The Piano Roll UI must render thousands of notes at 60/120 FPS without DOM explosion. Notes, selection rectangles, and ghost notes are drawn via HTML5 Canvas 2D backed by an interval/spatial quad-tree structure in TypeScript.
4. **Universal MIDI 1.0 & 2.0 / UMP Foundation**: The internal data structures represent pitch, velocity, and durations with floating-point or high-resolution integers compatible with both classic MIDI 1.0 and high-resolution MIDI 2.0 / Universal MIDI Packets (UMP).

---

## 2. Core MIDI Data Structures

### 2.1. Note Definition (`MidiNote`)

```cpp
struct MidiNote {
    uint64_t id{0};               // Unique note ID (UUIDv7 or sequential timeline ID)
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
    std::vector<MidiNote> notes;  // Note container (sorted by startBeats for fast binary search)
};
```

---

## 3. Real-Time Audio Block MIDI Scheduling

In `AudioEngineTransport.cpp`, during each block:

1. The block's time range is computed in samples: `[hwSamplePosition, hwSamplePosition + numSamples)`.
2. The active `TempoMap` converts sample positions to beat positions: `[blockStartBeats, blockEndBeats)`.
3. For each active `Instrument` or `MIDI` track:
   - Identify active `MidiRegion`s intersecting `[blockStartBeats, blockEndBeats)`.
   - Perform binary search on region `notes` to find notes triggering in this window.
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
  - Toggleable option: "Editable Ghost Notes" (double-click ghost note switches active track focus).
- **Layer 3: Active Notes Canvas**:
  - Rendered with high-contrast rounded rectangles.
  - Color gradient reflecting velocity (cooler/lighter for low velocity, saturated/warm for high velocity).
  - Selected notes outlined with glowing accent border.
  - Muted notes rendered with diagonal hash lines or dimmed grey.
- **Layer 4: Interactive Overlays**:
  - Playhead cursor line with micro-interpolation.
  - Marquee selection rectangle.
  - Note creation / brush preview shadow.
- **Layer 5: Property / Velocity Lane Canvas**:
  - Bottom strip displaying vertical lollipop stalks with circular heads representing note velocity.
  - Dragging across stalks performs linear ramp, curve shaping, or compression.
  - Switchable tabs: Velocity, Pitch Bend, Note Expression, Modulation (CC 1).

### 4.2. Spatial Indexing
To support 20,000+ notes without frame drops:
- Notes are indexed in a 2D spatial grid (cells of 4 bars × 1 octave).
- Viewport bounds query returns only visible note references in $O(\log N + K)$ time, where $K$ is the number of visible notes.
- Canvas render loops iterate strictly over visible notes.

### 4.3. Creative Editing Workflows
- **Quick Stamp**: Single-click adds note with current default duration and velocity.
- **Brush Tool**: Dragging paints consecutive notes snapping to the current grid (1/16, 1/8, etc.).
- **Chords & Scales**: Stamp triads, 7ths, 9ths, and inversions directly in scale.
- **Strum / Arpeggiate**: Micro-staggers note start times within a selected chord with customizable curve.
- **Humanize**: Adjustable randomization of velocity ($\pm \Delta v$) and micro-timing ($\pm \Delta t$).
