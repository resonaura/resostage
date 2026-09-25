# ResoStage: Current Task & Agent Memory

**Date**: 2026-09-24T22:27:00-07:00 (2026-09-25 UTC)  
**Status**: ACTIVE — Phase 1: Foundation Audit, Track/Timeline Generalization, & Baseline

---

## 1. Verbatim User Request

```text
Реализовать вот это теперь тебе надо:
# ResoStage как live-first DAW: исследование архитектуры и ультимативный промпт для coding-agent
[Full text of the prompt included in conversation history:
Transform ResoStage from a live-show playback/routing/lighting system into a live-first professional DAW platform without building a second engine, maintaining unified Core, Project, Timeline, Clock, MixGraph, Automation, MIDI, and Offline Renderer; implementing Track != Strip separation, extensible TrackKinds, full Piano Roll, unified AutomationTarget framework, PluginPowerManager state machine, and ResoLink Core-to-Core session protocol.]
```

---

## 2. Derived Non-Negotiable Requirements

1. **Unified Engine Principle**:
   - Exactly ONE Core, ONE MasterClock, ONE MixGraph DAG, ONE MixRenderer, ONE Automation Evaluator, ONE MIDI Engine, ONE Offline Renderer.
   - NO second "DAW engine" or duplicate signal-processing semantics.
   - Workspaces (Live vs Arrange) are view layers over the same immutable project state.
2. **Track vs Channel Strip Decoupling**:
   - `Track` = timeline/editor/recording entity (owns regions, automation lanes, record/monitor state).
   - `Channel Strip` = DSP node/routing strip in `MixGraph` (fader, pan, insert plugins, sends).
   - `TrackId != StripId`. Default 1:1, but architecture permits multi-track to single instrument strip, bus without track, aux timeline representation.
3. **Extensible Track Kinds**:
   - `Audio`, `Instrument`, `MIDI`, `ExternalMIDI`, `Lighting`, `Folder`, `BusTimeline`.
4. **Typed Device Chain**:
   - `MIDI FX -> Instrument -> Audio FX` (generalizing the initial `generator at slot 0` slice).
5. **Timeline Maps**:
   - `TempoMap` and `SignatureMap` as dedicated versioned, immutable snapshot structures with $O(\log N)$ / cached beat-to-time conversion.
6. **Piano Roll**:
   - Fast, dense editing (FL Studio speed + Logic clarity): scale snap, chord stamping, ghost notes (read-only & editable), per-note lanes (velocity, pitch, release, expression), drum/named-note mode, Canvas 2D spatial indexing (zero DOM explosion).
7. **Unified Automation Framework**:
   - `AutomationTarget` (domain, entityId, paramId, valueKind) across mixer, plugins, MIDI CC, and lighting.
   - Scopes: `TrackAutomation` (timeline-locked), `RegionAutomation` (moves with region), `RegionModulation` (relative).
   - Write modes: `Read`, `Touch`, `Latch`, `Write`.
8. **Conservative Plugin Power Management (`PluginPowerManager`)**:
   - State machine: `ACTIVE`, `QUIESCENT`, `SUSPENDED`, `PARKED`, `LOADING/WARMING`.
   - Never unload plugins solely on silent input. Heuristics: tail length, infinite tail, approaching MIDI/automation prewarm.
9. **ResoLink Core-to-Core Session Protocol**:
   - Dedicated Core-to-Core network synchronization layer (separate from Electron UDP telemetry).
   - Versioned timeline/tempo maps, SessionClock anchor beacons, distributed instrument execution targets.
10. **Zero Real-Time Regressions**:
    - Audio callback remains bounded, non-allocating, and non-blocking (0 blocking locks, 0 disk I/O, 0 network calls, 0 heap allocations).

---

## 3. Current Phase & Progress

- [x] **Phase 0: Baseline & Foundation Audit**:
  - Benchmarked Apple M1 callback sweep & DSP throughput.
  - Documented baseline metrics in `docs/performance/DAW_BASELINE.md`.
  - Documented architecture roadmap in `docs/ai/IMPLEMENTATION_PLAN.md` and `docs/architecture/`.
- [x] **Phase 1: Track & Timeline Model Generalization**:
  - `ProjectSchema.h` expanded with `TrackKind`, `MidiNote`, `MidiRegion`, `TempoMap`, `SignatureMap`.
  - Backwards-compatible schema parsing & promotion.
  - Core engine tests for tempo/signature conversions.
- [ ] **Phase 2: MIDI & Instrument End-to-End Vertical Slice**:
  - Instrument track -> Instrument plugin -> MIDI region -> block timeline event dispatch -> synthesis -> audio inserts -> mixer strip.
- [ ] **Phase 3: Piano Roll & Arrange Workspace**:
  - Canvas 2D note editor, scale/ghost workflow, velocity lanes.
- [ ] **Phase 4: Unified Automation Framework**:
  - `AutomationTarget` bindings, `Touch`/`Latch`/`Write` modes.
- [ ] **Phase 5: Plugin Power Manager**:
  - State machine, compatibility profiles, prewarming.
- [ ] **Phase 6: ResoLink Core-to-Core Protocol**:
  - SessionClock anchors, execution targets, distributed synths.

---

## 4. Hardware Baseline Environment

- **OS**: macOS Darwin 24.x (Apple Silicon)
- **CPU**: Apple M1 (8 cores)
- **RAM**: 8 GB
- **Sample Rate**: 48,000 Hz
- **Commit**: `5ef04ee35370351ed2dc71fe10f458b2e4ca9dc8`
- **MixRenderer Callback Timing (8 tracks + 2 aux + 1 master)**:
  - 64 frames: 1.10 µs (0.08% of 1333.3 µs deadline)
  - 128 frames: 2.97 µs (0.11% of 2666.7 µs deadline)
  - 256 frames: 4.24 µs (0.08% of 5333.3 µs deadline)
  - 512 frames: 8.07 µs (0.08% of 10666.7 µs deadline)
  - 1024 frames: 16.61 µs (0.08% of 21333.3 µs deadline)
- **MixRenderer with 8 Insert Plugins (@ 256 frames)**: 3.65 µs (0.07% of deadline)
- **AutomationEnvelope Throughput**: 132.4 MSamples/sec
- **EnvelopeFollower Throughput**: 228.7 MSamples/sec
