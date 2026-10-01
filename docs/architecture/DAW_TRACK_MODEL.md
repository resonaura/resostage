# Architecture Specification: Unified Track & Channel Strip Model

**Status**: track-kind/strip-link schema implemented; broader decoupled DAW
workflows remain in progress. Source review: 2026-10-01.

## Current ownership versus proposed workflows

`ProjectSchema.h` owns global `Project::tracks` and each track's controls,
optional `stripId`, plug-in slots, and execution-target metadata. Songs own
audio/MIDI regions and song-level automation lanes referencing those tracks.
The compiled `MixGraph` owns transient strip topology/buffers; it is not a
second mutable project document. `TrackDef::resolvedStripId()` falls back to the
track ID when no explicit strip is supplied.

The hierarchy below sketches the intended domain relationships, not the exact
serialized JSON shape. Tracks do not currently contain their own global
`audioRegions`/`midiRegions` arrays; those are song-owned. Separate strip IDs do
not by themselves implement multi-timbral sharing, take folders, distributed
execution, or hardware audio-return workflows. Verify each routing consumer
before expanding those capabilities.

The current project file format is 10. Its additive change makes the click
strip's solo-safe default true while preserving an explicitly saved false
value. Older compatible documents receive the default on load; the external
`pnpm migrate` path preserves existing canonical IDs and resources when upgrading
format 9 to 10. Runtime loading progress and power state do not become persisted
project fields.

---

## 1. Motivation & Principles

Historically, ResoStage paired timeline tracks 1:1 with audio channel strips. To evolve into a full professional DAW while preserving live-show determinism, the model must decouple **Tracks** from **Channel Strips**:

- **Track (`TrackDef`)**: An entity belonging to the timeline, arrangement, and recording domain. It owns audio or MIDI regions, automation lanes, take folders, record-arming, and monitoring states.
- **Channel Strip (`MixStrip`)**: A signal-processing and mixing node belonging to the audio mixing graph (`MixGraph`). It owns pre/post-fader buffers, faders, pan, plugin insert chains, sends, and routing egress.

Allowing an explicit strip identity provides a foundation for workflows such as:
- Multiple MIDI tracks playing the same multi-timbral instrument strip.
- Aux, submix, and master strips represented on the timeline for automation without becoming audio streaming tracks.
- External MIDI tracks sending MIDI to hardware ports with optional audio return monitoring.
- Lighting tracks scheduled on the timeline without masquerading as audio channels.

---

## 2. Track Kinds

```cpp
enum class TrackKind {
    Audio,        // Audio file streaming regions -> audio channel strip
    Instrument,   // MIDI regions -> MIDI FX -> Instrument Plugin -> Audio FX -> audio channel strip
    MIDI,         // MIDI regions -> internal/plugin/peer destination
    ExternalMIDI, // MIDI regions -> physical CoreMIDI/ALSA port; optional associated audio return
    Lighting,     // Light cues & lighting automation -> LightEngine (non-audio)
    Folder,       // Organizational hierarchy / bus summing parent
    BusTimeline   // Arrangement representation of an Aux/Send/Main strip for automation
};
```

---

## 3. Data Model Hierarchy

```text
Project
├── Global
│   ├── TempoMap (versioned beat <-> seconds transform)
│   ├── SignatureMap (time signature changes)
│   ├── Markers / Sections
│   └── Main Strip & Click Strip
│
├── Tracks[]
│   ├── id: string ("audio::track:1", "inst::track:2", etc.)
│   ├── name: string
│   ├── kind: TrackKind
│   ├── stripId: string (points to MixStrip id; defaults to track.id)
│   ├── executionTarget: ExecutionTarget (Local vs Peer UUID)
│   ├── audioRegions: Region[]
│   ├── midiRegions: MidiRegion[]
│   ├── automationLanes: TrackAutomationLane[]
│   ├── recordArmed: bool
│   └── inputMonitoring: bool
│
└── Mixer
    └── Strips[]
        ├── Track Strips
        ├── Aux / Bus Strips
        └── Main / Physical Output Strips
```

---

## 4. Real-Time Invariants

- **Callback Non-Blocking**: Audio thread never parses project JSON or walks unindexed track vectors. The message thread compiles the mutable project into an immutable flat `MixGraph` and `MixProcessorView`.
- **Zero-Allocation MIDI Delivery**: In `audioDeviceIOCallbackWithContext`, timeline MIDI events are stamped with block sample offsets into preallocated buffers.
- **Offline Parity**: Both live playback and offline stems render through the exact same `MixGraph` and `MixRenderer`.
