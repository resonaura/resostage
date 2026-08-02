#pragma once

#include "LightBlend.h"
#include "LightCueInterpolation.h"
#include "LightGradient.h"
#include "project/ProjectSchema.h"

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
        case GradientPreset::Custom:        return parseGradientStops(customCsv, builtinPalette("vulcanFire"));
        case GradientPreset::VulcanFire:    return builtinPalette("vulcanFire");
        case GradientPreset::ToxicFire:     return builtinPalette("toxicFire");
        case GradientPreset::CryoFire:      return builtinPalette("cryoFire");
        case GradientPreset::CyberpunkFire: return builtinPalette("cyberpunkFire");
        default:                            return {};
    }
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
};

// (sourceType "bus"|"track", sourceId) -> current peak dB for that source.
// Return -100 (silence) for an unknown id rather than throwing -- a cue
// pointing at a since-removed track/bus should just read as silent, not
// crash the light output thread.
using SourceLevelDbFn = std::function<float(const std::string& sourceType, const std::string& sourceId)>;

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

                if ((p.type == EffectParams::Type::Meter || p.type == EffectParams::Type::VuPeak) && sourceLevelDb) {
                    const float db = sourceLevelDb(activeCue->effectSourceType, activeCue->effectSourceId);
                    p.audioLevel = dbToLinearLevel(db);
                    // Shared by both effects -- writeDmxChannels/the frontend
                    // preview key their Meter-vs-spatial routing off
                    // effectType explicitly (see its own doc comment), not
                    // off this field's presence, so VuPeak still gets its
                    // own per-LED shape via addressableEffectLedColor.
                    r.meterLevel01 = p.audioLevel;
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
            }
        }
        out.push_back(std::move(acc));
    }
    return out;
}

} // namespace resostage
