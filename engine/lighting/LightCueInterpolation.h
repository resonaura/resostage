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

// Converts an HSV triplet (h wraps to any range, s/v 0..1) to 8-bit RGB.
// Used by the GradientFlow effect to sweep a travelling rainbow, both as the
// whole-bar fallback (applyEffect) and the per-LED variant
// (addressableEffectLedColor).
inline void hsvToRgb(double h, double s, double v, uint8_t& r, uint8_t& g, uint8_t& b) {
    h -= std::floor(h);
    const double i = std::floor(h * 6.0);
    const double f = h * 6.0 - i;
    const double p = v * (1.0 - s);
    const double q = v * (1.0 - f * s);
    const double t = v * (1.0 - (1.0 - f) * s);
    double rf = v, gf = v, bf = v;
    switch (static_cast<int>(i) % 6) {
        case 0: rf = v; gf = t; bf = p; break;
        case 1: rf = q; gf = v; bf = p; break;
        case 2: rf = p; gf = v; bf = t; break;
        case 3: rf = p; gf = q; bf = v; break;
        case 4: rf = t; gf = p; bf = v; break;
        default: rf = v; gf = p; bf = q; break;
    }
    r = static_cast<uint8_t>(std::clamp(rf * 255.0, 0.0, 255.0));
    g = static_cast<uint8_t>(std::clamp(gf * 255.0, 0.0, 255.0));
    b = static_cast<uint8_t>(std::clamp(bf * 255.0, 0.0, 255.0));
}

// GradientFlow's hue sweep speed relative to rateHz -- rateHz alone (as used
// by Strobe/Pulse/Ripple) would spin the whole rainbow past in well under a
// second; this slows it to a legible shimmer. Shared by applyEffect's
// whole-bar fallback and addressableEffectLedColor's per-LED sweep so both
// stay in lockstep.
constexpr double kGradientFlowSpeedScale = 0.15;

// ─── Effect modulation ────────────────────────────────────────────────────────
//
// Called by LightEngine once per output frame per track×fixture, AFTER
// resolveLightCueValue(), to apply audio-reactive modulation.
//
// All time-based effects are driven by the same wall-clock `tSec` derived
// from MasterClock::currentSeconds() so every fixture stays frame-perfect.

struct EffectParams {
    enum class Type { None, Meter, Strobe, Pulse, Ripple, Converge, GradientFlow, Chase, Helix, Plasma, Twinkle, SonicBoom } type{Type::None};
    float intensity    = 0.8f;   // 0..1 — depth of the effect
    float rateHz       = 2.0f;   // cycles per second (pre-computed from tempoSubdiv if synced)
    float audioLevel   = 0.0f;   // 0..1 peak level from the target bus (for Meter)
    double tSec        = 0.0;    // monotonic wall-clock time for Strobe/Pulse/Ripple
    int fixtureIndex   = 0;      // fixture position for Ripple phase offset
};

// Returns a clamped EffectParams::Type parsed from a LightCue's effectType string.
inline EffectParams::Type parseEffectType(const std::string& s) {
    if (s == "meter")        return EffectParams::Type::Meter;
    if (s == "strobe")       return EffectParams::Type::Strobe;
    if (s == "pulse")        return EffectParams::Type::Pulse;
    if (s == "ripple")       return EffectParams::Type::Ripple;
    if (s == "converge")     return EffectParams::Type::Converge;
    if (s == "gradientflow") return EffectParams::Type::GradientFlow;
    if (s == "chase")        return EffectParams::Type::Chase;
    if (s == "helix")        return EffectParams::Type::Helix;
    if (s == "plasma")       return EffectParams::Type::Plasma;
    if (s == "twinkle")      return EffectParams::Type::Twinkle;
    if (s == "sonicboom")    return EffectParams::Type::SonicBoom;
    return EffectParams::Type::None;
}

// Inverse of parseEffectType -- used when forwarding a resolved fixture's
// active effect identity to the web UI (WebUiState::LightOutputRow), so the
// frontend's addressableEffectLedColor port knows which per-LED formula to
// run without re-deriving it from the cue list itself.
inline const char* effectTypeToString(EffectParams::Type t) {
    switch (t) {
        case EffectParams::Type::None:         return "none";
        case EffectParams::Type::Meter:        return "meter";
        case EffectParams::Type::Strobe:       return "strobe";
        case EffectParams::Type::Pulse:        return "pulse";
        case EffectParams::Type::Ripple:       return "ripple";
        case EffectParams::Type::Converge:     return "converge";
        case EffectParams::Type::GradientFlow: return "gradientflow";
        case EffectParams::Type::Chase:        return "chase";
        case EffectParams::Type::Helix:        return "helix";
        case EffectParams::Type::Plasma:       return "plasma";
        case EffectParams::Type::Twinkle:      return "twinkle";
        case EffectParams::Type::SonicBoom:    return "sonicboom";
    }
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
// scaled by the computed level (GradientFlow also overrides color -- see its
// case below).
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
            const float phaseOffset = static_cast<float>(p.fixtureIndex) * 0.25f;
            const float sine = static_cast<float>(
                0.5 + 0.5 * std::sin(TAU * p.rateHz * std::max(0.0, p.tSec)
                                     - phaseOffset * TAU - TAU * 0.25));
            level = sine * p.intensity;
            break;
        }
        case EffectParams::Type::Converge: {
            // Whole-bar fallback for non-addressable fixtures: two lines
            // race in from either edge and meet at the centre, brightening
            // as they close in, then the cycle restarts. Addressable
            // fixtures get the real travelling-band shape per LED via
            // addressableEffectLedColor -- this uniform value still applies
            // underneath it as the overall brightness ceiling.
            const double phase = std::fmod(std::max(0.0, p.tSec) * p.rateHz, 1.0);
            const double bandDistFromEdge = phase * 0.5; // 0 (edge) .. 0.5 (centre)
            level = static_cast<float>(bandDistFromEdge * 2.0) * p.intensity;
            break;
        }
        case EffectParams::Type::GradientFlow: {
            // Whole-bar fallback for non-addressable fixtures (or the base
            // color addressable ones start from before per-LED position
            // offsets the hue -- see addressableEffectLedColor): the
            // fixture's own hue slowly sweeps through the spectrum.
            uint8_t hr, hg, hb;
            hsvToRgb(std::max(0.0, p.tSec) * p.rateHz * kGradientFlowSpeedScale, 1.0, 1.0, hr, hg, hb);
            base.r = hr;
            base.g = hg;
            base.b = hb;
            level = p.intensity;
            break;
        }
        case EffectParams::Type::Chase:
        case EffectParams::Type::Helix:
        case EffectParams::Type::Plasma:
        case EffectParams::Type::Twinkle:
        case EffectParams::Type::SonicBoom:
            level = p.intensity;
            break;
        case EffectParams::Type::None:
            break;
    }

    base.intensity *= std::clamp(static_cast<double>(level), 0.0, 1.0);
    return base;
}

// ─── Per-LED addressable shape ────────────────────────────────────────────────
//
// Converge and GradientFlow are the first two effects with genuine spatial
// meaning across a physical LED strip (Meter's per-LED VU fill already has
// its own dedicated path -- see LightOutputResolver.h's meterLedColor).
// Called once per LED per output frame by both LightEngine's real-time DMX
// thread (writeDmxChannels) and MainComponent's WebUiState push -- driven by
// the same tSec/rateHz the resolved fixture already carries, so the preview
// can never diverge from the physical strip.
//
// `outLevel` is a 0..1 multiplier meant to be applied ON TOP OF the
// fixture's existing (envelope × applyEffect) intensity, not in place of it
// -- so the cue's own fade/brightness still governs the ceiling. `outR/G/B`
// override the LED's color outright for GradientFlow; Converge leaves color
// untouched and expresses itself purely through `outLevel`.
inline void addressableEffectLedColor(int i, int totalLeds, EffectParams::Type type,
                                       double tSec, float rateHz,
                                       uint8_t baseR, uint8_t baseG, uint8_t baseB,
                                       uint8_t& outR, uint8_t& outG, uint8_t& outB,
                                       double& outLevel) {
    outR = baseR;
    outG = baseG;
    outB = baseB;
    outLevel = 1.0;
    constexpr double TAU = 6.283185307179586;
    const double t = totalLeds > 1 ? static_cast<double>(i) / (totalLeds - 1) : 0.0;

    const double phase = std::fmod(std::max(0.0, tSec) * rateHz, 1.0);
    if (type == EffectParams::Type::Converge) {
        const double bandPos = phase * 0.5;                // 0 (edge) .. 0.5 (centre)
        const double distFromEdge = std::min(t, 1.0 - t);   // 0 at either edge, 0.5 at centre
        constexpr double kBandWidth = 0.12;
        outLevel = std::clamp(1.0 - std::abs(distFromEdge - bandPos) / kBandWidth, 0.0, 1.0);
    } else if (type == EffectParams::Type::GradientFlow) {
        const double hue = t + std::max(0.0, tSec) * rateHz * kGradientFlowSpeedScale;
        hsvToRgb(hue, 1.0, 1.0, outR, outG, outB);
    } else if (type == EffectParams::Type::Chase) {
        constexpr double kBandWidth = 0.16;
        outLevel = std::clamp(1.0 - std::abs(t - phase) / kBandWidth, 0.0, 1.0);
    } else if (type == EffectParams::Type::Helix) {
        const double wave = 0.5 + 0.5 * std::sin(TAU * (t * 2.0 + phase));
        outLevel = std::pow(wave, 3.0);
        hsvToRgb(t + phase, 0.85, 1.0, outR, outG, outB);
    } else if (type == EffectParams::Type::Plasma) {
        const double field = 0.5 + 0.5 * (
            std::sin(TAU * (t * 1.7 + phase)) +
            std::sin(TAU * (t * 3.1 - phase)) +
            std::sin(TAU * (t * 0.7 + phase * 2.0))) / 3.0;
        hsvToRgb(field + phase * 0.35, 0.9, 0.35 + field * 0.65, outR, outG, outB);
    } else if (type == EffectParams::Type::Twinkle) {
        const int timeCell = static_cast<int>(std::floor(std::max(0.0, tSec) * rateHz * 3.0));
        const uint32_t ledHash = static_cast<uint32_t>(i) * 1103515245u;
        const uint32_t timeHash = static_cast<uint32_t>(timeCell) * 2654435761u;
        const uint32_t h = ledHash ^ timeHash;
        outLevel = (h & 1023u) < 60u ? 1.0 : 0.03;
        hsvToRgb((h % 360u) / 360.0, 0.55, 1.0, outR, outG, outB);
    } else if (type == EffectParams::Type::SonicBoom) {
        constexpr double kBandWidth = 0.10;
        const double radius = phase * 0.5;
        outLevel = std::clamp(1.0 - std::abs(std::abs(t - 0.5) - radius) / kBandWidth, 0.0, 1.0);
    }
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
