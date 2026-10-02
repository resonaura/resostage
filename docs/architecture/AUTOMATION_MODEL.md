# Architecture Specification: Unified Automation & Modulation Framework

**Status**: domain/schema, arrangement editing and track-scope strip DSP are
implemented; complete live console ownership/recording acceptance remains in
progress. Source review: 2026-10-02. See [the current audit](../ai/tasks/audit.md).

## Implemented scope

`ProjectSchema.h` defines targets, scopes, write modes, and points. Song, audio
region, and MIDI region lanes are persisted and published as structural state.
`AutomationEvaluator` and `AutomationCurve` provide deterministic curve and
multi-scope evaluation; `AutomationRecorder` provides touch/latch/punch/RDP
primitives. These types do not imply every domain has a complete editor or live
write-mode lifecycle.

The plug-in-chain panel's automation editor lists parameter metadata copied
from the isolated host and edits normalized slot/parameter lanes. Live dispatch
queues plug-in changes at block granularity; offline rendering evaluates lanes
against its private session. MIDI-region CC/channel pitch bend is dispatched to
instrument/external MIDI paths where applicable. Arrangement tracks expose real
vendor parameters and strip gain/pan/mute/send lanes. `StripAutomationPlan`
prepares immutable track-scope bindings off audio; `MixRenderer` applies them
through its existing coefficient/audibility smoothing. Manual recording has
UI/session foundations but requires the ownership/tempo/cycle/epoch acceptance
listed in the audit. Unified lighting automation and native per-note MIDI 2.0
glide remain separate integration work. Never describe channel bend as per-note
expression.

The type excerpts below are design summaries. The schema is the source of
truth and includes `AutomationLane::scope` in addition to the abbreviated fields.

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
2. **Deterministic Real-Time Evaluation**: Curve sampling with curvature matching `AutomationEnvelope` ($pow(t, 2^{-curve \cdot 2})$), prepared storage, and no routine evaluator allocation. Do not assume every live dispatch is sample-wise or SIMD; the current plug-in control path is block-granular.
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

This formula matches ResoStage's curve convention. Perceptual mapping depends
on the target's units and normalization; a shared curve formula alone cannot
guarantee perceptual linearity for gain, frequency, or color.

---

## 4. Console Write Modes

| Mode | Behaviour During Playback | On User Touch (Fader / Knob) | On User Release |
| --- | --- | --- | --- |
| **`Read`** | Plays existing curve. Incoming user moves are ignored or temporarily override without writing. | No recording. | No recording. |
| **`Touch`** | Plays existing curve. | Punches in instantly. Records user touch stream. | Punches out with configurable return ramp (e.g. 150 ms) back to existing curve. |
| **`Latch`** | Plays existing curve. | Punches in instantly. Records user touch stream. | Keeps recording the last touched value until transport stops or punch-out button is pressed. |
| **`Write`** | Overwrites existing curve across entire playback range. | Records user touches continuously. | Continues recording current fader position. |

### Data Thinning (Ramer-Douglas-Peucker)
High-rate gestures can generate many points. The recorder/builder applies
**Ramer-Douglas-Peucker (RDP)** reduction with configurable tolerance (default
$\epsilon = 0.002$ in normalized space). Reduction ratio depends on the input;
85–95% is not a measured universal result. `MainComponentBuilderAutomation.cpp`
owns command mutation on the message thread; do not assume a background task
or use these vector-growing recording helpers in the audio callback.
