#pragma once

#include "project/ProjectSchema.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace resostage {

struct LightCueValue {
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;
    double intensity = 0.0; // 0..1
};

// ─── Effect modulation ────────────────────────────────────────────────────────
//
// Called by LightEngine once per output frame per track×fixture, AFTER
// resolveLightCueValue(), to apply audio-reactive modulation.
//
// All time-based effects are driven by the same wall-clock `tSec` derived
// from MasterClock::currentSeconds() so every fixture stays frame-perfect.

struct EffectParams {
    enum class Type { None, Meter, Strobe, Pulse, Ripple } type{Type::None};
    float intensity    = 0.8f;   // 0..1 — depth of the effect
    float rateHz       = 2.0f;   // cycles per second (pre-computed from tempoSubdiv if synced)
    float audioLevel   = 0.0f;   // 0..1 peak level from the target bus (for Meter)
    double tSec        = 0.0;    // monotonic wall-clock time for Strobe/Pulse/Ripple
    int fixtureIndex   = 0;      // fixture position for Ripple phase offset
};

// Returns a clamped EffectParams::Type parsed from a LightCue's effectType string.
inline EffectParams::Type parseEffectType(const std::string& s) {
    if (s == "meter")  return EffectParams::Type::Meter;
    if (s == "strobe") return EffectParams::Type::Strobe;
    if (s == "pulse")  return EffectParams::Type::Pulse;
    if (s == "ripple") return EffectParams::Type::Ripple;
    return EffectParams::Type::None;
}

// Converts a tempo-subdivision string + BPM to Hz.
// Subdivisions are fractions of a bar (4/4 assumed):
//   "2" = 2 bars (8 beats), "1" = 1 bar (4 beats), "1/2" = 2 beats ...
// Returns rateHz if subdivision is unrecognised.
inline float subdivToHz(const std::string& subdiv, double bpm, float fallbackHz = 2.0f) {
    if (bpm <= 0.0) return fallbackHz;
    // beatsPerCycle for each label (in 4/4 bar fractions → beats)
    struct Entry { const char* label; float beats; };
    static constexpr Entry kTable[] = {
        {"2",    8.0f}, {"1",    4.0f},
        {"1/2",  2.0f}, {"1/3",  4.0f/3.0f},
        {"1/4",  1.0f}, {"1/6",  2.0f/3.0f},
        {"1/8",  0.5f}, {"1/16", 0.25f},
        {"1/32", 0.125f}, {"1/64", 0.0625f},
    };
    for (const auto& e : kTable)
        if (subdiv == e.label)
            return static_cast<float>(bpm / 60.0 / e.beats);
    return fallbackHz;
}

// Apply audio-reactive modulation to `base`. Returns a copy with intensity
// scaled by the computed level. Color is never touched.
inline LightCueValue applyEffect(LightCueValue base, const EffectParams& p) {
    if (p.type == EffectParams::Type::None)
        return base;

    constexpr double TAU = 6.283185307179586;
    float level = 1.0f;

    switch (p.type) {
        case EffectParams::Type::Meter: {
            // Quantise into 8 discrete LED steps (bottom-to-top VU bar feel):
            //   audioLevel 0..1  →  floor(x*8)/8  →  0, 0.125, 0.25 … 1.0
            constexpr int kSegments = 8;
            const float raw = std::clamp(p.audioLevel, 0.0f, 1.0f);
            level = std::floor(raw * kSegments) / kSegments * p.intensity;
            break;
        }
        case EffectParams::Type::Strobe: {
            // Square wave: on for first half-period, off for second.
            const double phase = std::fmod(std::max(0.0, p.tSec) * p.rateHz, 1.0);
            level = (phase < 0.5) ? p.intensity : 0.0f;
            break;
        }
        case EffectParams::Type::Pulse: {
            // Smooth sine-based fade starting at 0 at tSec=0.
            const float sine = static_cast<float>(
                0.5 + 0.5 * std::sin(TAU * p.rateHz * std::max(0.0, p.tSec) - TAU * 0.25));
            level = sine * p.intensity;
            break;
        }
        case EffectParams::Type::Ripple: {
            // Travelling wave starting at 0 for fixture 0 at tSec=0.
            const float phaseOffset = p.fixtureIndex * 0.25f;
            const float sine = static_cast<float>(
                0.5 + 0.5 * std::sin(TAU * p.rateHz * std::max(0.0, p.tSec)
                                     - phaseOffset * TAU - TAU * 0.25));
            level = sine * p.intensity;
            break;
        }
        default:
            break;
    }

    base.intensity *= std::clamp(static_cast<double>(level), 0.0, 1.0);
    return base;
}

// ─── Cue interpolation ────────────────────────────────────────────────────────

// Resolves the color+intensity a single Light track should show at
// `timeSeconds`, given every LightCue placed on it (need not be pre-sorted).
//
// Rules (Phase A -- see RESTORE_POINT.md's deferred Phase C for tracking
// lines / automation-envelope view / anything fancier):
//  - No cue covers `timeSeconds` -> black, intensity 0. There is no
//    "hold previous value forever" concept yet -- every cue owns its own
//    complete on/off envelope.
//  - Overlapping cues on the same track: the LATEST-STARTING cue that is
//    currently active (timeSeconds inside its own [start, start+duration))
//    wins outright for that instant, i.e. a later cue starting before an
//    earlier one ends overrides it completely, not a color blend.
//  - Within the winning cue: intensity ramps 0 -> cue.intensity over
//    [start, start+fadeIn), holds at cue.intensity over the middle, then
//    ramps cue.intensity -> 0 over [end-fadeOut, end). Color is constant
//    across the whole span (only intensity fades -- matches a dimmer fade
//    on a real console; color/position snapping instantly is a deliberate
//    Phase A simplification, not an oversight).
//  - fadeIn + fadeOut > duration is clamped so they never overlap: fadeIn
//    first (up to the full duration), fadeOut gets whatever's left.
inline LightCueValue resolveLightCueValue(const std::vector<LightCue>& cues,
                                           double timeSeconds) {
    const LightCue* active = nullptr;
    double activeStart = 0.0;

    // Single pass, no allocation: track the latest-starting active cue seen
    // so far rather than sorting a copy -- cheap enough to call every frame
    // per track from a live preview.
    for (const auto& c : cues) {
        const double end = c.startSeconds + c.durationSeconds;
        if (timeSeconds < c.startSeconds || timeSeconds >= end)
            continue;
        if (active == nullptr || c.startSeconds >= activeStart) {
            active = &c;
            activeStart = c.startSeconds;
        }
    }
    if (active == nullptr)
        return {};

    const double dur = std::max(0.0, active->durationSeconds);
    const double fadeIn = std::clamp(active->fadeInSeconds, 0.0, dur);
    const double fadeOut = std::clamp(active->fadeOutSeconds, 0.0, dur - fadeIn);
    const double t = timeSeconds - active->startSeconds; // 0..dur
    const double fadeOutStart = dur - fadeOut;

    double level = 1.0;
    if (fadeIn > 0.0 && t < fadeIn)
        level = t / fadeIn;
    else if (fadeOut > 0.0 && t >= fadeOutStart)
        level = std::max(0.0, (dur - t) / fadeOut);

    LightCueValue out;
    out.r = active->colorR;
    out.g = active->colorG;
    out.b = active->colorB;
    out.intensity = active->intensity * level;
    return out;
}

} // namespace resostage

