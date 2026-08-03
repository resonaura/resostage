#pragma once

#include "LightBlend.h"
#include "LightCueInterpolation.h"
#include "LightGradient.h"
#include "project/ProjectSchema.h"
#include "../telemetry/Telemetry.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace resostage {

// Convert -inf..0 dBFS to a 0..1 linear level. Maps [-60dBFS, 0dBFS] ->
// [0, 1]; anything quieter than -60dBFS reads as silence.
inline float dbToLinearLevel(float peakDb) {
    return std::max(0.0f, std::min(1.0f, (peakDb + 60.0f) / 60.0f));
}

// "custom" samples the cue's own typed gradientColors stops; the four named
// presets are built-in palettes from LightGradient.h's catalogue, usable
// without authoring stops by hand.
enum class GradientPreset { Solid, GreenYellowRed, Custom, VulcanFire, ToxicFire, CryoFire, CyberpunkFire };

inline GradientPreset parseGradientPreset(const std::string& s) {
    if (s == "greenYellowRed") return GradientPreset::GreenYellowRed;
    if (s == "custom") return GradientPreset::Custom;
    if (s == "vulcanFire") return GradientPreset::VulcanFire;
    if (s == "toxicFire") return GradientPreset::ToxicFire;
    if (s == "cryoFire") return GradientPreset::CryoFire;
    if (s == "cyberpunkFire") return GradientPreset::CyberpunkFire;
    return GradientPreset::Solid;
}

inline const char* gradientPresetToString(GradientPreset p) {
    switch (p) {
        case GradientPreset::Solid:         return "solid";
        case GradientPreset::GreenYellowRed: return "greenYellowRed";
        case GradientPreset::Custom:        return "custom";
        case GradientPreset::VulcanFire:    return "vulcanFire";
        case GradientPreset::ToxicFire:     return "toxicFire";
        case GradientPreset::CryoFire:      return "cryoFire";
        case GradientPreset::CyberpunkFire: return "cyberpunkFire";
    }
    return "solid";
}

// Resolves a preset (+ the cue's own typed stops, only consulted for
// Custom) into actual sample-able gradient stops. Solid/GreenYellowRed
// return empty -- they're handled by their own fixed logic, not stop
// sampling. Called ONCE per fixture per frame (not per LED) by every
// consumer below; the resolved vector is then threaded through the
// per-LED loop instead of re-parsing the CSV string 120 times a frame.
inline std::vector<GradientStop> resolveGradientStops(GradientPreset preset, const std::string& customCsv) {
    switch (preset) {
        case GradientPreset::Solid:
        case GradientPreset::GreenYellowRed: return {};
        case GradientPreset::Custom:        return parseGradientStops(customCsv, builtinPalette("vulcanFire"));
        case GradientPreset::VulcanFire:    return builtinPalette("vulcanFire");
        case GradientPreset::ToxicFire:     return builtinPalette("toxicFire");
        case GradientPreset::CryoFire:      return builtinPalette("cryoFire");
        case GradientPreset::CyberpunkFire: return builtinPalette("cyberpunkFire");
    }
    return {};
}

// Color for LED index `i` of `totalLeds`, lit bottom-up to `litCount` LEDs
// (a real VU meter's fill direction -- see LevelMeterBar.tsx, which every
// other meter in the app already fills bottom-to-top). LEDs at/above
// litCount are off. "solid" uses the cue's own color for every lit LED;
// "greenYellowRed" colors by LED *position* on the bar (bottom 60% green,
// next 25% yellow, top 15% red), matching a classic VU meter's fixed scale
// -- independent of whatever color the cue was given. Custom/named-palette
// presets sample `stops` (see resolveGradientStops) by the same LED
// position -- pass the already-resolved stops, not a preset+string pair,
// so this stays a cheap per-LED call with no parsing in the hot path.
inline void meterLedColor(int i, int litCount, int totalLeds, GradientPreset preset,
                           uint8_t baseR, uint8_t baseG, uint8_t baseB,
                           uint8_t& outR, uint8_t& outG, uint8_t& outB,
                           const std::vector<GradientStop>* stops = nullptr) {
    if (i >= litCount) {
        outR = outG = outB = 0;
        return;
    }
    if (preset == GradientPreset::Solid) {
        outR = baseR;
        outG = baseG;
        outB = baseB;
        return;
    }
    const double t = totalLeds > 1 ? static_cast<double>(i) / (totalLeds - 1) : 0.0;
    if (preset == GradientPreset::GreenYellowRed) {
        if (t < 0.6) {
            outR = 40; outG = 220; outB = 90; // green
        } else if (t < 0.85) {
            outR = 240; outG = 210; outB = 40; // yellow
        } else {
            outR = 235; outG = 60; outB = 50; // red
        }
        return;
    }
    if (stops != nullptr && !stops->empty()) {
        sampleGradient(*stops, t, outR, outG, outB);
        return;
    }
    outR = baseR; outG = baseG; outB = baseB; // defensive: no stops resolved, fall back to the cue's color
}

struct ResolvedFixtureOutput {
    std::string fixtureId;
    LightCueValue value;
    // Raw 0..1 audio level (pre-quantization, pre-depth), only meaningful
    // when this fixture's active cue's effect is Meter or VuPeak -- 0
    // otherwise. Consumers distinguish the two by effectType (VuPeak still
    // renders through addressableEffectLedColor, not meterLedColor).
    float meterLevel01 = 0.0f;
    GradientPreset gradient = GradientPreset::Solid;
    // The cue's own typed stops, only meaningful when gradient == Custom --
    // see resolveGradientStops. Forwarded raw (not pre-parsed) so a caller
    // that doesn't need per-LED color (e.g. a whole-bar fixture) never pays
    // for parsing it.
    std::string gradientColors;
    // Effect identity + phase, forwarded so addressable fixtures can render
    // per-LED spatial patterns (Converge, GradientFlow) that need more than
    // the uniform `value` above captures -- see
    // LightCueInterpolation.h's addressableEffectLedColor(). None/0 when
    // there's no active cue or its effect has no per-LED shape of its own
    // (Strobe/Pulse/Ripple are whole-bar uniform; Meter already has
    // meterLevel01/gradient above).
    EffectParams::Type effectType = EffectParams::Type::None;
    double effectTSec = 0.0;
    float effectRateHz = 2.0f;
    // 0..1 per-band energy (index 0 = lowest band) from the active cue's
    // audio source -- filled whenever the cue is audio-driven (Meter, VuPeak,
    // Geq, Blurz). All-zero otherwise. Forwarded so consumers (WebUiState /
    // writeDmxChannels) can render Geq/Blurz's spectrum without re-fetching.
    float bandLevel[kLightBandCount] = {};
};

// What an audio-source callback reports for one meter point at one instant.
// peakDb is the post-fader peak (the classic Meter/VuPeak level); bandLevel
// is the per-band 0..1 energy (index 0 = lowest band) that drives the
// Geq/Blurz spectrum effects -- all zero if the meter pool has no band data
// (e.g. a cue wired to a source the engine doesn't know).
struct SourceLevels {
    float peakDb = -144.0f;
    float bandLevel[kLightBandCount] = {};
};

// (sourceType "bus"|"track", sourceId) -> current peak + per-band levels for
// that source. Return all-zero levels (silence) for an unknown id rather than
// throwing -- a cue pointing at a since-removed track/bus should just read as
// silent, not crash the light output thread.
using SourceLevelDbFn = std::function<SourceLevels(const std::string& sourceType, const std::string& sourceId)>;

// Duration of the idle-behavior transition fade (blackout / staticColor
// kicking in when the transport stops). Shared by LightEngine's real DMX
// thread and MainComponent's WebUiState preview push so the stage and every
// preview fade to the idle target at exactly the same rate.
inline constexpr double kIdleFadeSeconds = 0.8;

// Duration of the fade BACK from an idle behavior to normal lighting when the
// transport resumes. Deliberately much shorter than kIdleFadeSeconds:
// drifting into blackout / house-color between songs is a slow, classy ramp,
// but coming back up on a cue hit should snap briskly (~0.25s reads as
// "instant" to an audience) so the show never lingers in the idle look once
// playback starts. Same sharing contract as kIdleFadeSeconds.
inline constexpr double kResumeFadeSeconds = 0.25;

// Resolves what every fixture driven by `lightTracks` should display at
// `tSec`, given `songLightCues` (the currently staged song's cues) and
// `bpm` (for tempo-synced effect rates). Single source of truth for "what
// should this fixture show right now" -- LightEngine's real-time DMX thread
// and MainComponent's ~30Hz WebUiState push both call this, so the live
// preview the user sees can never show something the real hardware isn't
// also doing (see RESTORE_POINT.md Feature 6 / the "намертво к таймлайну"
// sync fix).
// One fixture's contribution from a single track that currently drives it,
// bundled with the blend mode its active cue asked for -- kept only long
// enough to fold multiple simultaneous tracks together below.
struct LayerContribution {
    ResolvedFixtureOutput out;
    BlendMode mode = BlendMode::Normal;
};

inline std::vector<ResolvedFixtureOutput> resolveLightOutputs(
    const std::vector<LightTrack>& lightTracks,
    const std::vector<LightCue>& songLightCues,
    double tSec,
    double bpm,
    const SourceLevelDbFn& sourceLevelDb) {
    std::map<std::string, std::vector<const LightCue*>> cuesByTrack;
    for (const auto& cue : songLightCues)
        cuesByTrack[cue.trackId].push_back(&cue);

    // Per-fixture accumulation across every track that drives it, in track
    // order (first-listed track = base layer, later ones layer on top --
    // see LightBlend.h). `fixtureOrder` preserves first-seen order so
    // output ordering stays exactly what a single-track fixture always had.
    std::vector<std::string> fixtureOrder;
    std::map<std::string, bool> anyTrackHasCues;
    std::map<std::string, std::vector<LayerContribution>> layersByFixture;

    for (const auto& track : lightTracks) {
        std::vector<LightCue> trackCues;
        if (auto it = cuesByTrack.find(track.id); it != cuesByTrack.end())
            for (const LightCue* cp : it->second)
                trackCues.push_back(*cp);
        if (trackCues.empty())
            continue;

        const LightCueValue baseVal = resolveLightCueValue(trackCues, tSec);

        // Same "latest-starting active cue" rule resolveLightCueValue uses
        // internally -- re-derived here because effect params (unlike
        // color/intensity) aren't part of LightCueValue's return shape.
        const LightCue* activeCue = nullptr;
        double latestStart = -1.0;
        for (const auto& c : trackCues) {
            const double end = c.startSeconds + c.durationSeconds;
            if (tSec >= c.startSeconds && tSec < end && c.startSeconds > latestStart) {
                latestStart = c.startSeconds;
                activeCue = &c;
            }
        }

        int fixturePos = 0;
        for (const auto& fxId : track.fixtureIds) {
            if (!anyTrackHasCues[fxId]) fixtureOrder.push_back(fxId);
            anyTrackHasCues[fxId] = true;

            if (activeCue != nullptr) {
                ResolvedFixtureOutput r;
                r.fixtureId = fxId;
                r.value = baseVal;
                r.gradient = parseGradientPreset(activeCue->gradientPreset);
                r.gradientColors = activeCue->gradientColors;

                EffectParams p;
                p.type = parseEffectType(activeCue->effectType);
                p.intensity = activeCue->effectIntensity;
                p.fixtureIndex = fixturePos;
                // Tempo-synced effects phase-lock to the SONG's beat grid
                // (t=0 is bar 1 beat 1, same convention BarSeek.h uses) so
                // the rhythm lands on the actual music regardless of where
                // the cue happens to start -- anchoring to the cue's own
                // start instead would only look on-beat if the cue was
                // placed exactly on a bar boundary, and would visibly drift
                // otherwise. Free-rate (non-synced) effects have no beat
                // grid to lock to, so they keep starting their own phase
                // fresh at the cue's start, which is the more intuitive
                // "this effect begins when the cue begins" behavior there.
                p.tSec = activeCue->tempoSync
                    ? std::max(0.0, tSec)
                    : std::max(0.0, tSec - activeCue->startSeconds);
                p.rateHz = activeCue->tempoSync
                    ? subdivToHz(activeCue->tempoSubdiv, bpm, activeCue->effectRateHz)
                    : activeCue->effectRateHz;

                if ((p.type == EffectParams::Type::Meter || p.type == EffectParams::Type::VuPeak ||
                     p.type == EffectParams::Type::Geq || p.type == EffectParams::Type::Blurz) && sourceLevelDb) {
                    const SourceLevels lv = sourceLevelDb(activeCue->effectSourceType, activeCue->effectSourceId);
                    p.audioLevel = dbToLinearLevel(lv.peakDb);
                    for (int b = 0; b < kLightBandCount; ++b)
                        p.bandLevel[b] = lv.bandLevel[b];
                    // Shared by all four -- writeDmxChannels/the frontend
                    // preview key their Meter-vs-spatial routing off
                    // effectType explicitly (see its own doc comment), not
                    // off this field's presence, so VuPeak still gets its
                    // own per-LED shape via addressableEffectLedColor.
                    r.meterLevel01 = p.audioLevel;
                    for (int b = 0; b < kLightBandCount; ++b)
                        r.bandLevel[b] = p.bandLevel[b];
                }

                r.effectType = p.type;
                r.effectTSec = p.tSec;
                r.effectRateHz = p.rateHz;
                r.value = applyEffect(r.value, p);

                layersByFixture[fxId].push_back({std::move(r), parseBlendMode(activeCue->blendMode)});
            }
            ++fixturePos;
        }
    }

    std::vector<ResolvedFixtureOutput> out;
    out.reserve(fixtureOrder.size());
    for (const auto& fxId : fixtureOrder) {
        auto& layers = layersByFixture[fxId];
        if (layers.empty()) {
            // Every track driving this fixture has cues, but none is active
            // right now -- still a real "off" row (matches what a single
            // idle track has always produced), not an omitted one.
            ResolvedFixtureOutput r;
            r.fixtureId = fxId;
            out.push_back(std::move(r));
            continue;
        }
        if (layers.size() == 1) {
            // Single layer -- the overwhelmingly common case (one track per
            // fixture) -- passes through untouched, identical to before
            // cross-track layering existed.
            out.push_back(std::move(layers[0].out));
            continue;
        }
        // Two or more tracks are simultaneously driving this fixture with
        // active cues: fold them bottom-to-top. Each layer's OWN blend mode
        // decides how it lands on the accumulator; "normal" (the default,
        // and the only mode a pre-layering project's cues can have) replaces
        // outright, so a fixture with exactly one ACTUAL simultaneous
        // contributor per frame (even if two tracks nominally share it,
        // just never active at the same instant) never sees blend math run.
        ResolvedFixtureOutput acc = layers[0].out;
        for (size_t i = 1; i < layers.size(); ++i) {
            const ResolvedFixtureOutput& top = layers[i].out;
            const BlendMode mode = layers[i].mode;
            if (mode == BlendMode::Normal) {
                acc = top;
                continue;
            }
            // Effective (premultiplied-by-intensity) 0..1 channels -- a
            // faded-in/faded-out layer blends proportionally to its current
            // envelope, not as a hard on/off switch.
            const auto effective = [](const LightCueValue& v, int ch) {
                const double c = ch == 0 ? v.r : ch == 1 ? v.g : v.b;
                return c / 255.0 * v.intensity;
            };
            LightCueValue blended;
            const auto mix = [&](int ch) {
                const double b = blendChannel(mode, effective(acc.value, ch), effective(top.value, ch));
                return static_cast<uint8_t>(std::clamp(std::lround(b * 255.0), 0L, 255L));
            };
            blended.r = mix(0);
            blended.g = mix(1);
            blended.b = mix(2);
            blended.intensity = 1.0; // brightness is fully baked into r/g/b above
            acc.value = blended;
            // The topmost layer with a renderable identity (a spatial shape,
            // or Meter which needs meterLevel01/gradient) wins the forwarded
            // effect slot -- one shape renders per fixture per frame, not a
            // per-LED merge of two (see LightBlend.h's class comment).
            if (top.effectType != EffectParams::Type::None) {
                acc.effectType = top.effectType;
                acc.effectTSec = top.effectTSec;
                acc.effectRateHz = top.effectRateHz;
                acc.gradient = top.gradient;
                acc.gradientColors = top.gradientColors;
                acc.meterLevel01 = top.meterLevel01;
                for (int b = 0; b < kLightBandCount; ++b)
                    acc.bandLevel[b] = top.bandLevel[b];
            }
        }
        out.push_back(std::move(acc));
    }
    return out;
}

// Overrides the whole rig's output while the transport is stopped, per
// LightingConfig::idleBehavior -- called by LightEngine's real DMX thread
// and MainComponent's WebUiState push INSTEAD OF resolveLightOutputs (not
// alongside it), so both apply the exact same idle rule. Covers every
// fixture in `fixtures` unconditionally, unlike resolveLightOutputs (which
// only emits a row for fixtures some track with an ACTIVE cue is currently
// driving) -- a stopped rig has no "active cue" to derive from, so this
// forces a value for the whole roster instead of leaving untouched fixtures
// to whatever they last held.
//
// "holdLast" (the default) returns empty: the caller's contract is to fall
// back to a normal resolveLightOutputs(..., tSec, ...) call in that case,
// i.e. literally hold whatever the frozen playhead position resolves to --
// this function is only ever called for the other three modes.
inline std::vector<ResolvedFixtureOutput> buildIdleLightOutputs(
    const std::vector<LightFixture>& fixtures,
    const std::string& idleBehavior,
    uint8_t idleR, uint8_t idleG, uint8_t idleB, double idleIntensity) {
    std::vector<ResolvedFixtureOutput> out;
    if (idleBehavior != "blackout" && idleBehavior != "staticColor")
        return out;
    out.reserve(fixtures.size());
    for (const auto& f : fixtures) {
        ResolvedFixtureOutput r;
        r.fixtureId = f.id;
        if (idleBehavior == "staticColor")
            r.value = {idleR, idleG, idleB, std::clamp(idleIntensity, 0.0, 1.0)};
        // else "blackout": default-constructed LightCueValue is already
        // {0, 0, 0, intensity 0.0}.
        out.push_back(std::move(r));
    }
    return out;
}

// Idle target for idleBehavior "effect": every fixture runs `idleEffectType`
// (a rhythm-independent effect -- Strobe/Pulse/Ripple/Chase/Plasma/...; see
// the LightingConfig::idleEffectType doc comment for which are eligible) at
// idleEffectRateHz, seeded with idleColorR/G/B as the effect's base color.
// `tSec` is the wall-clock time since the idle transition began (advances
// even though the transport is stopped, so the effect keeps animating).
// Uses the exact same applyEffect + effectType forwarding as
// resolveLightOutputs, so the per-LED shapes it renders are identical to a
// cue-driven effect of the same type.
inline std::vector<ResolvedFixtureOutput> buildIdleEffectOutputs(
    const std::vector<LightFixture>& fixtures,
    const std::string& idleEffectType,
    double idleEffectRateHz,
    uint8_t idleR, uint8_t idleG, uint8_t idleB, double idleIntensity,
    const std::string& idleGradientPreset, const std::string& idleGradientColors,
    double tSec) {
    EffectParams p;
    p.type = parseEffectType(idleEffectType);
    p.rateHz = static_cast<float>(idleEffectRateHz);
    p.tSec = tSec;
    p.intensity = static_cast<float>(idleIntensity);
    const LightCueValue base{idleR, idleG, idleB, std::clamp(idleIntensity, 0.0, 1.0)};
    const GradientPreset grad = parseGradientPreset(idleGradientPreset);

    std::vector<ResolvedFixtureOutput> out;
    out.reserve(fixtures.size());
    for (size_t i = 0; i < fixtures.size(); ++i) {
        ResolvedFixtureOutput r;
        r.fixtureId = fixtures[i].id;
        p.fixtureIndex = static_cast<int>(i);
        r.value = applyEffect(base, p);
        r.effectType = p.type;
        r.effectTSec = p.tSec;
        r.effectRateHz = p.rateHz;
        r.gradient = grad;
        r.gradientColors = idleGradientColors;
        out.push_back(std::move(r));
    }
    return out;
}

// The full idle target for the whole rig -- the single place both
// LightEngine's real DMX thread and MainComponent's web preview compute it,
// so the stage and every preview agree on every idleBehavior. `effectPhaseT`
// is the wall-clock seconds since the idle transition began (pass 0 for a
// fresh fade-in; callers own the clock), consumed only by the "effect" mode
// so the effect keeps animating while stopped.
inline std::vector<ResolvedFixtureOutput> buildIdleTarget(
    const std::vector<LightFixture>& fixtures,
    const std::string& idleBehavior,
    uint8_t idleR, uint8_t idleG, uint8_t idleB, double idleIntensity,
    const std::string& idleEffectType, double idleEffectRateHz,
    const std::string& idleGradientPreset, const std::string& idleGradientColors,
    double effectPhaseT) {
    if (idleBehavior == "effect")
        return buildIdleEffectOutputs(fixtures, idleEffectType, idleEffectRateHz,
                                      idleR, idleG, idleB, idleIntensity,
                                      idleGradientPreset, idleGradientColors, effectPhaseT);
    return buildIdleLightOutputs(fixtures, idleBehavior, idleR, idleG, idleB, idleIntensity);
}

// Linearly interpolates every fixture in `to` (the idle target, from
// buildIdleLightOutputs) from its counterpart in `from` (the last output
// while playing, snapshotted at the instant the transport stopped) at
// progress `t` (0 = still `from`, 1 = fully `to`) -- this is what makes the
// idle-behavior transition a smooth fade instead of an instant snap. A
// fixture present in `to` but missing from `from` (never had an active cue
// at the moment of stopping) fades in from black, not from nothing. Pure
// function of its inputs (no clock/state reads), same convention as every
// other resolver in this file, so it's trivially unit-testable and the
// caller (LightEngine's real-time thread) owns all the timing/state.
inline std::vector<ResolvedFixtureOutput> blendTowardIdle(
    const std::vector<ResolvedFixtureOutput>& from,
    const std::vector<ResolvedFixtureOutput>& to,
    double t) {
    t = std::clamp(t, 0.0, 1.0);
    std::map<std::string, const ResolvedFixtureOutput*> fromById;
    for (const auto& f : from)
        fromById[f.fixtureId] = &f;

    std::vector<ResolvedFixtureOutput> out;
    out.reserve(to.size());
    for (const auto& target : to) {
        ResolvedFixtureOutput r = target; // keep the target's identity/effect-none fields
        LightCueValue src; // defaults to black/off -- fades in from nothing if never live
        if (auto it = fromById.find(target.fixtureId); it != fromById.end())
            src = it->second->value;

        const auto lerp = [t](double a, double b) { return a + (b - a) * t; };
        r.value.r = static_cast<uint8_t>(std::clamp(lerp(src.r, target.value.r), 0.0, 255.0));
        r.value.g = static_cast<uint8_t>(std::clamp(lerp(src.g, target.value.g), 0.0, 255.0));
        r.value.b = static_cast<uint8_t>(std::clamp(lerp(src.b, target.value.b), 0.0, 255.0));
        r.value.intensity = std::clamp(lerp(src.intensity, target.value.intensity), 0.0, 1.0);
        out.push_back(std::move(r));
    }
    return out;
}

// Final per-LED wire color for one fixture -- the exact bytes the DMX
// universe receives after intensity scaling (see writeDmxChannels). `w` is
// only meaningful when a ResoLightBar's channelProfile is "rgbw" -- see
// resolveLedWireColors' toWire conversion below and
// ResoLightChannelMap.h's colorProfileByteCount, the shared source of truth
// for how many of these fields actually get written per pixel.
struct LedWireColor {
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;
    uint8_t w = 0;
};

// Resolves the final per-LED colors `fixture` should display for its resolved
// output, using the same routing as LightEngine's DMX path (Meter's
// progressive fill, spatial effects via addressableEffectLedColor, otherwise
// the uniform cue color) and baking intensity into each color. Non-addressable
// fixtures (or ledCount<=1) yield a single uniform entry; addressable fixtures
// yield one entry per LED.
//
// Single source of truth for per-LED rendering: LightEngine's real-time DMX
// output and MainComponent's per-LED websocket stream both call this, so the
// web preview can never show something the hardware isn't doing.
inline std::vector<LedWireColor> resolveLedWireColors(const ResolvedFixtureOutput& out,
                                                      const LightFixture& fixture) {
    const int leds = fixture.addressable && fixture.ledCount > 1 ? fixture.ledCount : 1;
    const auto scale = [&](uint8_t ch, double ledLevel) -> uint8_t {
        return static_cast<uint8_t>(
            std::clamp(static_cast<double>(ch) * out.value.intensity * ledLevel, 0.0, 255.0));
    };

    // ResoLightBar's color type ("dimmer" | "rgb" | "rgbw", see LightFixture's
    // doc comment) actually changes what bytes get written -- unlike
    // DmxGeneric's channelProfile, which is purely a UI label/channel-count
    // convenience (see writeDmxChannels' own doc comment for why that's the
    // safe choice there). "rgbw" splits the shared white component out via
    // the standard min(r,g,b) subtractive conversion; "dimmer" carries a
    // single brightness byte (the loudest of r/g/b) in `.r` -- pick a white
    // cue color so a Dimmer-only bar's own color choice doesn't matter.
    const bool isResoLight = fixture.kind == LightFixture::Kind::ResoLightBar;
    const std::string& profile = fixture.channelProfile;
    const auto toWire = [&](uint8_t r, uint8_t g, uint8_t b, double ledLevel) -> LedWireColor {
        LedWireColor c;
        if (isResoLight && profile == "rgbw") {
            const uint8_t white = std::min({r, g, b});
            c.r = scale(static_cast<uint8_t>(r - white), ledLevel);
            c.g = scale(static_cast<uint8_t>(g - white), ledLevel);
            c.b = scale(static_cast<uint8_t>(b - white), ledLevel);
            c.w = scale(white, ledLevel);
        } else if (isResoLight && profile == "dimmer") {
            c.r = scale(std::max({r, g, b}), ledLevel);
        } else {
            c.r = scale(r, ledLevel);
            c.g = scale(g, ledLevel);
            c.b = scale(b, ledLevel);
        }
        return c;
    };

    if (leds == 1) {
        return {toWire(out.value.r, out.value.g, out.value.b, 1.0)};
    }

    const bool meterActive = out.effectType == EffectParams::Type::Meter;
    const bool spatialEffectActive = !meterActive && out.effectType != EffectParams::Type::None;
    const int litCount = meterActive
        ? std::clamp(static_cast<int>(std::lround(out.meterLevel01 * static_cast<float>(leds))), 0, leds)
        : leds; // not metering: every LED "lit" at the resolved uniform color

    // Resolved ONCE per fixture per frame, not per LED -- see
    // resolveGradientStops's doc comment. Empty for Solid/GreenYellowRed
    // (meterLedColor/addressableEffectLedColor ignore the pointer then).
    const std::vector<GradientStop> stops = resolveGradientStops(out.gradient, out.gradientColors);
    const std::vector<GradientStop>* stopsPtr = stops.empty() ? nullptr : &stops;

    std::vector<LedWireColor> colors;
    colors.reserve(static_cast<size_t>(leds));
    for (int i = 0; i < leds; ++i) {
        uint8_t r = out.value.r, g = out.value.g, b = out.value.b;
        double ledLevel = 1.0;
        if (meterActive) {
            meterLedColor(i, litCount, leds, out.gradient, out.value.r, out.value.g, out.value.b, r, g, b, stopsPtr);
        } else if (spatialEffectActive) {
            addressableEffectLedColor(i, leds, out.effectType, out.effectTSec, out.effectRateHz,
                                      out.value.r, out.value.g, out.value.b, r, g, b, ledLevel,
                                      stopsPtr, out.meterLevel01, out.bandLevel);
        }
        colors.push_back(toWire(r, g, b, ledLevel));
    }
    return colors;
}

} // namespace resostage
