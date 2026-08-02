#pragma once

#include "LightGradient.h"
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
    enum class Type {
        None, Meter, Strobe, Pulse, Ripple, Converge, GradientFlow, Chase, Helix, Plasma, Twinkle, SonicBoom,
        // Concert-pack additions -- see addressableEffectLedColor for the
        // per-LED shape of each. All seven are pure functions of
        // (i, totalLeds, tSec, rateHz) like everything above them; none
        // needs persistent cross-frame simulation state (see RESTORE_POINT.md's
        // "no FFT / spectral analysis exists yet" note for why GEQ/Blurz from
        // the source research doc were deliberately left out of this batch
        // rather than faked without real spectral data).
        Fire, Bouncing, Drip, Fireworks, Colorwaves, StrobeSwipe, VuPeak,
    } type{Type::None};
    float intensity    = 0.8f;   // 0..1 — depth of the effect
    float rateHz       = 2.0f;   // cycles per second (pre-computed from tempoSubdiv if synced)
    float audioLevel   = 0.0f;   // 0..1 peak level from the target bus (for Meter, VuPeak)
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
    if (s == "fire")         return EffectParams::Type::Fire;
    if (s == "bouncing")     return EffectParams::Type::Bouncing;
    if (s == "drip")         return EffectParams::Type::Drip;
    if (s == "fireworks")    return EffectParams::Type::Fireworks;
    if (s == "colorwaves")   return EffectParams::Type::Colorwaves;
    if (s == "strobeswipe")  return EffectParams::Type::StrobeSwipe;
    if (s == "vupeak")       return EffectParams::Type::VuPeak;
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
        case EffectParams::Type::Fire:         return "fire";
        case EffectParams::Type::Bouncing:     return "bouncing";
        case EffectParams::Type::Drip:         return "drip";
        case EffectParams::Type::Fireworks:    return "fireworks";
        case EffectParams::Type::Colorwaves:   return "colorwaves";
        case EffectParams::Type::StrobeSwipe:  return "strobeswipe";
        case EffectParams::Type::VuPeak:       return "vupeak";
    }
    return "none";
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
        case EffectParams::Type::VuPeak: {
            // Whole-bar fallback: continuous (unquantized) level, unlike
            // Meter's 8-step VU feel -- the addressable per-LED path adds a
            // highlighted peak-hold cap on top of this same fill.
            level = std::clamp(p.audioLevel, 0.0f, 1.0f) * p.intensity;
            break;
        }
        case EffectParams::Type::Chase:
        case EffectParams::Type::Helix:
        case EffectParams::Type::Plasma:
        case EffectParams::Type::Twinkle:
        case EffectParams::Type::SonicBoom:
        case EffectParams::Type::Fire:
        case EffectParams::Type::Bouncing:
        case EffectParams::Type::Drip:
        case EffectParams::Type::Fireworks:
        case EffectParams::Type::Colorwaves:
        case EffectParams::Type::StrobeSwipe:
            level = p.intensity;
            break;
        case EffectParams::Type::None:
            break;
    }

    base.intensity *= std::clamp(static_cast<double>(level), 0.0, 1.0);
    return base;
}

// ─── Deterministic value noise (Fire) ──────────────────────────────────────
//
// A tiny 2D value-noise implementation (hash + smoothstep bilinear
// interpolation) -- NOT Perlin/simplex noise, but visually equivalent for a
// single flame texture and a few lines instead of a permutation-table
// dependency. Pure function of its inputs (no seeding/state), so Fire stays
// as testable/deterministic as every other effect in this file.
inline uint32_t noiseHash(int32_t ix, int32_t iy) {
    uint32_t h = static_cast<uint32_t>(ix) * 374761393u + static_cast<uint32_t>(iy) * 668265263u;
    h = (h ^ (h >> 13)) * 1274126177u;
    return h ^ (h >> 16);
}
inline double noiseHash01(int32_t ix, int32_t iy) {
    return (noiseHash(ix, iy) & 0xFFFFFFu) / static_cast<double>(0xFFFFFFu);
}
inline double valueNoise2D(double x, double y) {
    const auto x0 = static_cast<int32_t>(std::floor(x));
    const auto y0 = static_cast<int32_t>(std::floor(y));
    const double fx = x - x0, fy = y - y0;
    const double v00 = noiseHash01(x0, y0),     v10 = noiseHash01(x0 + 1, y0);
    const double v01 = noiseHash01(x0, y0 + 1), v11 = noiseHash01(x0 + 1, y0 + 1);
    const double sx = fx * fx * (3.0 - 2.0 * fx); // smoothstep
    const double sy = fy * fy * (3.0 - 2.0 * fy);
    const double a = v00 + (v10 - v00) * sx;
    const double b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
}

// A narrow, symmetric falloff around `center` -- the shared "how bright is
// this LED given it's `dist` away from a moving point" shape used by
// Converge/Chase/SonicBoom above and every new travelling-point effect
// below (bouncing balls, drips, firework sparks).
inline double pointFalloff(double t, double center, double width) {
    return std::clamp(1.0 - std::abs(t - center) / width, 0.0, 1.0);
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
//
// `palette` (optional): resolved gradient stops (see LightOutputResolver.h's
// resolveGradientStops) for effects that sample a color ramp instead of
// procedurally computing hue -- Fire and Colorwaves. Null/empty falls back
// to each effect's own built-in default (Fire: the Vulcan palette;
// Colorwaves: a full rainbow via hsvToRgb, matching GradientFlow's sweep).
//
// `audioLevel` (optional, 0..1): only meaningful for VuPeak -- see
// LightOutputResolver.h for why it's threaded separately from the
// Meter-only meterLevel01/meterLedColor path.
inline void addressableEffectLedColor(int i, int totalLeds, EffectParams::Type type,
                                       double tSec, float rateHz,
                                       uint8_t baseR, uint8_t baseG, uint8_t baseB,
                                       uint8_t& outR, uint8_t& outG, uint8_t& outB,
                                       double& outLevel,
                                       const std::vector<GradientStop>* palette = nullptr,
                                       float audioLevel = 0.0f) {
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
    } else if (type == EffectParams::Type::Fire) {
        // y=0 (LED index 0, the bottom of the bar) is the base of the flame;
        // y=1 is the tip. Two octaves of upward-drifting value noise, then
        // an attenuation curve that gates the tip so the flame doesn't just
        // fill solid to the top. rateHz scales how fast the flame "boils".
        const double rise = std::max(0.0, tSec) * rateHz * 0.6;
        double n = 0.6 * valueNoise2D(0.0, t * 6.0 - rise * 4.0)
                 + 0.4 * valueNoise2D(3.7, t * 11.0 - rise * 7.0);
        n = std::clamp(n, 0.0, 1.0);
        const double attenuation = std::clamp(1.0 - t * 1.15, 0.0, 1.0);
        double heat = std::clamp(n * attenuation * 1.35, 0.0, 1.0);
        heat = std::pow(heat, 1.4); // more contrast: real gaps of near-black between licks
        if (palette != nullptr && !palette->empty())
            sampleGradient(*palette, heat, outR, outG, outB);
        else
            sampleGradient(builtinPalette("vulcanFire"), heat, outR, outG, outB);
        outLevel = 1.0; // brightness is already baked into the sampled color
    } else if (type == EffectParams::Type::Colorwaves) {
        // Three incommensurate sine/cosine terms (Pride2015-style) so the
        // palette scan never visibly repeats over a short span.
        const double idx = std::sin(4.0 * t + phase * TAU)
                          + std::sin(7.0 * t - 1.5 * phase * TAU)
                          + std::cos(2.3 * t + 2.0 * phase * TAU);
        const double idx01 = std::clamp((idx + 3.0) / 6.0, 0.0, 1.0); // -3..3 -> 0..1
        if (palette != nullptr && !palette->empty())
            sampleGradient(*palette, idx01, outR, outG, outB);
        else
            hsvToRgb(idx01, 1.0, 1.0, outR, outG, outB);
        outLevel = 1.0;
    } else if (type == EffectParams::Type::Bouncing) {
        // Three balls, closed-form: a decaying |sin| envelope per bounce
        // cycle reads as "bouncing with energy loss" without needing to
        // simulate/track actual collisions frame to frame -- see the class
        // comment's "no persistent state" invariant.
        constexpr int kBalls = 3;
        double best = 0.0;
        int bestBall = 0;
        for (int k = 0; k < kBalls; ++k) {
            const double cycleLen = 1.6 + k * 0.35; // seconds per ball's full decay-and-reset cycle
            const double cyclePos = std::fmod(std::max(0.0, tSec) * rateHz / cycleLen + k * 0.29, 1.0);
            const double period = 0.10 + k * 0.015; // fraction of the cycle per individual bounce
            const double envelope = std::exp(-3.2 * cyclePos); // amplitude decays over the cycle
            const double bouncePhase = std::fmod(cyclePos / period, 1.0);
            const double height = envelope * std::abs(std::sin(TAU * 0.5 * bouncePhase));
            const double lvl = pointFalloff(t, height, 0.05);
            if (lvl > best) { best = lvl; bestBall = k; }
        }
        outLevel = best;
        hsvToRgb(0.08 * bestBall, 0.7, 1.0, outR, outG, outB);
    } else if (type == EffectParams::Type::Drip) {
        // Two or three droplets fall from the tip under acceleration
        // (quadratic ease-in), then a brief widening splash at the base.
        constexpr int kDrips = 2;
        double best = 0.0;
        for (int j = 0; j < kDrips; ++j) {
            const double cyclePos = std::fmod(std::max(0.0, tSec) * rateHz * 0.5 + j * 0.53, 1.0);
            double lvl;
            if (cyclePos < 0.8) {
                const double f = cyclePos / 0.8;
                const double y = 1.0 - f * f; // accelerating fall from the tip
                lvl = pointFalloff(t, y, 0.045);
            } else {
                const double f = (cyclePos - 0.8) / 0.2;
                lvl = (1.0 - f) * pointFalloff(t, 0.0, 0.05 + f * 0.25); // widening, fading splash
            }
            best = std::max(best, lvl);
        }
        outLevel = best;
    } else if (type == EffectParams::Type::Fireworks) {
        // Launch (bottom to a hashed apex height) then burst into a
        // deterministic-per-LED spray of sparks that fly outward from the
        // apex and fade exponentially. `shot` re-rolls the apex/spark
        // pattern every cycle without needing remembered particle state.
        const double cyclePos = std::fmod(std::max(0.0, tSec) * rateHz * 0.4, 1.0);
        const auto shot = static_cast<int32_t>(std::floor(std::max(0.0, tSec) * rateHz * 0.4));
        const double apex = 0.55 + 0.4 * noiseHash01(shot, 97);
        if (cyclePos < 0.3) {
            const double f = cyclePos / 0.3;
            outLevel = pointFalloff(t, f * apex, 0.05) * (0.6 + 0.4 * f);
            outR = baseR; outG = baseG; outB = baseB;
        } else {
            const double f = (cyclePos - 0.3) / 0.7; // 0..1 since the burst started
            const double h = noiseHash01(i, shot * 131 + 7);
            const double speed = 0.25 + 0.9 * h;
            const double dist = speed * f;
            const bool isSpark = h < 0.35; // sparse subset of LEDs carry a spark this shot
            const double lvl = isSpark
                ? pointFalloff(t, apex - dist, 0.035) * std::exp(-3.0 * f)
                : 0.0;
            outLevel = lvl;
            hsvToRgb(0.02 + h * 0.12, 0.85, 1.0, outR, outG, outB); // warm spark hues
        }
    } else if (type == EffectParams::Type::StrobeSwipe) {
        // Fast bottom-to-top fill on each beat (first ~8% of the phase),
        // then the whole bar decays together exponentially -- a stage
        // strobe "swipe" rather than a uniform on/off square wave.
        const double elapsedBeats = phase / std::max(1e-6f, rateHz); // seconds since the last beat
        constexpr double kSwipeFrac = 0.08;
        if (phase < kSwipeFrac) {
            outLevel = t <= phase / kSwipeFrac ? 1.0 : 0.0;
        } else {
            constexpr double kTau = 0.15; // decay time constant, seconds
            outLevel = std::exp(-elapsedBeats / kTau);
        }
        outR = baseR; outG = baseG; outB = baseB;
    } else if (type == EffectParams::Type::VuPeak) {
        // Continuous-resolution VU fill (unlike Meter's 8-step quantized
        // one) with a brighter highlight at the fill's leading edge. A
        // simplified stand-in for true peak-hold ballistics (which would
        // need cross-frame memory of the recent maximum -- see
        // RESTORE_POINT.md) that's still a genuinely distinct, useful
        // visual: smoother fill, plus a "cap" pixel that pops.
        const double level01 = std::clamp(static_cast<double>(audioLevel), 0.0, 1.0);
        const double capWidth = totalLeds > 1 ? 1.0 / (totalLeds - 1) : 1.0;
        if (t <= level01) {
            outLevel = t >= level01 - capWidth * 1.5 ? 1.0 : 0.65;
        } else {
            outLevel = 0.0;
        }
        outR = baseR; outG = baseG; outB = baseB;
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
