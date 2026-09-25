# Architecture Specification: Unified Automation & Modulation Framework

**Status**: `IN_PROGRESS` (Phase 4)

---

## 1. Motivation & Principles

Live performance and studio production require continuous expressive parameter control over time. In a hybrid live-first DAW, automation must cover multiple disparate targets:
- Mixer channel strips (faders, pan, mutes, send gains).
- Hosted VST3 / AU plugin parameters (filter cutoffs, resonance, dry/wet, decay).
- Hardware / MIDI CC outputs (expression pedal, mod wheel, pitch bend).
- Live lighting fixtures and universe parameters (master intensity, color RGB, pan/tilt).

Rather than fragmenting parameter automation across four separate subsystems, ResoStage unifies all parameter changes into a single high-performance **`AutomationTarget`** model.

Key design principles:
1. **Target Agnostic**: Curves do not care whether they modulate an audio EQ, a synth oscillator, a DMX dimmer, or a MIDI CC.
2. **Deterministic Real-Time Evaluation**: Bounded per-block curve sampling with curvature matching `AutomationEnvelope` ($pow(t, 2^{-curve \cdot 2})$). Zero heap allocation and vectorized SIMD smoothing.
3. **Multi-Scope Hierarchy**:
   - `TrackAutomation`: Anchored to the timeline/song, continuous across regions.
   - `RegionAutomation`: Attached to an audio or MIDI region; moves, trims, duplicates, and loops with the region.
   - `RegionModulation`: Relative bipolar delta ($\pm \Delta$) multiplied or added on top of base automation.
4. **Professional Console Write Modes**: `Read`, `Touch`, `Latch`, and `Write` with smooth punch-in and punch-out return smoothing.

---

## 2. Automation Target Specification

```cpp
enum class AutomationDomain : uint8_t {
    Strip = 0,    // Mixer strip parameters (gain, pan, send levels, mute)
    Plugin = 1,   // Hosted VST3/AU plugin parameters
    MidiCC = 2,   // MIDI Continuous Controllers & Channel Voice messages
    Lighting = 3  // DMX channel, universe master, fixture attributes
};

enum class ParameterValueType : uint8_t {
    FloatNormalized = 0, // 0.0 to 1.0 (used by VST3 and generic controls)
    Decibels = 1,        // -inf to +12.0 dB (audio faders)
    FrequencyHz = 2,     // 20 Hz to 20,000 Hz (EQ, filters)
    Milliseconds = 3,    // 0.1 ms to 10,000 ms (delays, reverb times)
    Boolean = 4,         // 0 or 1 (mutes, solos, bypass toggles)
    Integer = 5,         // Discrete steps (e.g. waveform selector, MIDI CC 0-127)
    ColorRgb = 6         // 24-bit RGB packed for lighting
};

struct AutomationTarget {
    AutomationDomain domain{AutomationDomain::Strip};
    std::string entityId;       // Strip ID ("audio::track:1"), Plugin Slot ID, or Fixture ID
    std::string parameterId;    // "faderGainDb", "pan", "param:104", "cc:1", "intensity"
    ParameterValueType valueType{ParameterValueType::FloatNormalized};
    float defaultValue{0.0f};
    float minValue{0.0f};
    float maxValue{1.0f};
};
```

---

## 3. Automation Points & Curves

Each automation lane contains sorted breakpoint nodes:

```cpp
struct AutomationPoint {
    double timeBeats{0.0};  // Position in beats (or seconds if time-locked)
    float value{0.0f};      // Normalized or typed target value
    float curve{0.0f};      // Curvature: -1.0 (concave/exponential) to 0.0 (linear) to +1.0 (convex/logarithmic)
};

struct AutomationLane {
    std::string id;
    AutomationTarget target;
    bool enabled{true};
    bool muted{false};
    AutomationWriteMode writeMode{AutomationWriteMode::Read};
    std::vector<AutomationPoint> points;
};
```

### Curvature Formula & SIMD Evaluation
The curve between points $P_1(t_1, v_1)$ and $P_2(t_2, v_2)$ is evaluated at normalized $u = \frac{t - t_1}{t_2 - t_1} \in [0, 1]$:

$$u_{shaped} = \begin{cases} 
u^{2^{-2 \cdot curve}} & \text{if } curve \neq 0 \\ 
u & \text{if } curve = 0 
\end{cases}$$

$$v(t) = v_1 + (v_2 - v_1) \cdot u_{shaped}$$

This exact formula matches ResoStage's `RegionFade` and `AutomationEnvelope`, guaranteeing perceptual linearity for volume, filter cutoff, and lighting fades.

---

## 4. Console Write Modes

| Mode | Behaviour During Playback | On User Touch (Fader / Knob) | On User Release |
| --- | --- | --- | --- |
| **`Read`** | Plays existing curve. Incoming user moves are ignored or temporarily override without writing. | No recording. | No recording. |
| **`Touch`** | Plays existing curve. | Punches in instantly. Records user touch stream. | Punches out with configurable return ramp (e.g. 150 ms) back to existing curve. |
| **`Latch`** | Plays existing curve. | Punches in instantly. Records user touch stream. | Keeps recording the last touched value until transport stops or punch-out button is pressed. |
| **`Write`** | Overwrites existing curve across entire playback range. | Records user touches continuously. | Continues recording current fader position. |

### Data Thinning (Ramer-Douglas-Peucker)
High-rate hardware controller gestures (e.g. 100 Hz USB/MIDI fader updates) generate thousands of points. Upon recording punch-out, an asynchronous background task applies the **Ramer-Douglas-Peucker (RDP)** reduction algorithm with a configurable error tolerance ($\epsilon \approx 0.002$ in normalized space), reducing point counts by 85–95% while preserving audible curve shape.
