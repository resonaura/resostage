# Architecture Specification: Conservative Plugin Power Management

**Status**: `IN_PROGRESS` (Phase 5)

---

## 1. Motivation & Principles

Modern production sessions frequently contain 50 to 150 plugin instances (synths, sample libraries, amp modelers, reverbs, delays, mastering limiters). Running all DSP instances simultaneously can saturate real-time audio threads, even when tracks are inactive for minutes at a time.

However, naive "silence-gate" auto-unloading causes disastrous failures in live performance:
- Unloading a reverb or delay abruptly cuts off natural decay tails with clicks.
- Re-instantiating heavy VST3/AU samplers (Kontakt, Serum, Omnisphere) takes 100–1000 ms, causing severe audio dropouts and hardware deadline misses.
- Certain plugins (tape emulations, analog modeled preamps, vinyl simulators) intentionally generate continuous low-level harmonics or noise even with zero input.
- Abrupt sample-rate or buffer resets on suspension can crash legacy plugin wrappers.

ResoStage implements a **conservative, multi-tiered state machine** designed specifically for real-time safety and zero audio interruptions.

---

## 2. Power State Machine

```text
                   Audio / MIDI Incoming (< 2 bars)
             ┌──────────────────────────────────────────────┐
             │                                              │
             ▼                                              │
       ┌───────────┐    No Input (> 8 bars)    ┌────────────┴┐
       │  ACTIVE   │ ────────────────────────> │  QUIESCENT  │
       └─────┬─────┘                           └──────┬──────┘
             │                                        │
             │ Prewarm                                │ Output Silence (> Tail Time)
             │ Budget                                 ▼
             │                                 ┌─────────────┐
             └──────────────────────────────── │  SUSPENDED  │
                                               └──────┬──────┘
                                                      │
                                                      │ User Park / Extreme Memory Pressure
                                                      ▼
                                               ┌─────────────┐
                                               │   PARKED    │
                                               └─────────────┘
```

### 2.1. States Defined

1. **`ACTIVE`**:
   - The plugin processes every audio block.
   - Zero latency, full DSP consumption.
2. **`QUIESCENT`**:
   - Track has no upcoming regions/notes, but the plugin's internal buffers or tails may still be ringing out.
   - Audio input is zeroed; plugin `process()` is called normally.
   - Output envelope is monitored via `EnvelopeFollower`.
3. **`SUSPENDED`**:
   - Output level has dropped below $-90\text{ dBFS}$ for longer than the plugin's reported tail time (or default 5.0 seconds).
   - Audio callback bypasses the plugin DSP call completely.
   - Plugin state, RAM buffers, and licenses remain locked in memory.
   - Audio input/output buffers are maintained in preallocated scratch memory.
   - Resuming to `ACTIVE` takes $< 0.05\text{ ms}$ (simply flipping a bypass atomic).
4. **`PARKED`**:
   - Plugin state chunk is serialized and cached to RAM/disk.
   - Vendor binary instance is released from memory to free massive RAM/VRAM.
   - Resuming requires background reload ($100 - 500\text{ ms}$), triggered well ahead of time by arrangement lookahead or manual operator unmute.

---

## 3. Transition Rules & Guard Rails

### 3.1. Never-Suspend Heuristics
A plugin is excluded from automatic suspension if:
- Track is record-armed or in input monitoring mode.
- Plugin manifests flag `NeverSuspend` or `ContinuousNoiseGenerator` (e.g. vinyl crackle, tape hiss).
- User explicitly toggles "Keep Awake" in the plugin header.
- Plugin reports infinite tail (`tailSamples == std::numeric_limits<uint32_t>::max()`).

### 3.2. Predictive Prewarming
Before playback reaches an inactive track:
1. Arrangement Lookahead scans the timeline 2 bars ahead of the playhead.
2. If upcoming audio regions, MIDI notes, or automation events are detected on a `SUSPENDED` track:
   - Audio engine flips state to `ACTIVE`.
   - Sends empty/priming blocks if the plugin requires clock sync.
   - All filters and internal oscillators stabilize before audible audio enters the strip.

---

## 4. Real-Time Thread Invariants

- The audio thread **never** allocates memory, unloads libraries, or acquires locks during power transitions.
- State checks are single atomic bitmasks (`uint32_t activeMask`).
- Skipping a suspended plugin in `MixProcessorView` is a single branch instruction ($O(1)$).
