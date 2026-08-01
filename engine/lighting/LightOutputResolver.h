#pragma once

#include "LightCueInterpolation.h"
#include "project/ProjectSchema.h"

#include <algorithm>
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

enum class GradientPreset { Solid, GreenYellowRed };

inline GradientPreset parseGradientPreset(const std::string& s) {
    return s == "greenYellowRed" ? GradientPreset::GreenYellowRed : GradientPreset::Solid;
}

// Color for LED index `i` of `totalLeds`, lit bottom-up to `litCount` LEDs
// (a real VU meter's fill direction -- see LevelMeterBar.tsx, which every
// other meter in the app already fills bottom-to-top). LEDs at/above
// litCount are off. "solid" uses the cue's own color for every lit LED;
// "greenYellowRed" colors by LED *position* on the bar (bottom 60% green,
// next 25% yellow, top 15% red), matching a classic VU meter's fixed scale
// -- independent of whatever color the cue was given.
inline void meterLedColor(int i, int litCount, int totalLeds, GradientPreset preset,
                           uint8_t baseR, uint8_t baseG, uint8_t baseB,
                           uint8_t& outR, uint8_t& outG, uint8_t& outB) {
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
    if (t < 0.6) {
        outR = 40; outG = 220; outB = 90; // green
    } else if (t < 0.85) {
        outR = 240; outG = 210; outB = 40; // yellow
    } else {
        outR = 235; outG = 60; outB = 50; // red
    }
}

struct ResolvedFixtureOutput {
    std::string fixtureId;
    LightCueValue value;
    // Raw 0..1 audio level (pre-quantization, pre-depth), only meaningful
    // when this fixture's active cue's effect is Meter -- 0 otherwise.
    float meterLevel01 = 0.0f;
    GradientPreset gradient = GradientPreset::Solid;
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
inline std::vector<ResolvedFixtureOutput> resolveLightOutputs(
    const std::vector<LightTrack>& lightTracks,
    const std::vector<LightCue>& songLightCues,
    double tSec,
    double bpm,
    const SourceLevelDbFn& sourceLevelDb) {
    std::vector<ResolvedFixtureOutput> out;

    std::map<std::string, std::vector<const LightCue*>> cuesByTrack;
    for (const auto& cue : songLightCues)
        cuesByTrack[cue.trackId].push_back(&cue);

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
            ResolvedFixtureOutput r;
            r.fixtureId = fxId;
            r.value = baseVal;

            if (activeCue != nullptr) {
                r.gradient = parseGradientPreset(activeCue->gradientPreset);

                EffectParams p;
                p.type = parseEffectType(activeCue->effectType);
                p.intensity = activeCue->effectIntensity;
                p.fixtureIndex = fixturePos;
                p.tSec = std::max(0.0, tSec - activeCue->startSeconds);
                p.rateHz = activeCue->tempoSync
                    ? subdivToHz(activeCue->tempoSubdiv, bpm, activeCue->effectRateHz)
                    : activeCue->effectRateHz;

                if (p.type == EffectParams::Type::Meter && sourceLevelDb) {
                    const float db = sourceLevelDb(activeCue->effectSourceType, activeCue->effectSourceId);
                    p.audioLevel = dbToLinearLevel(db);
                    r.meterLevel01 = p.audioLevel;
                }

                r.effectType = p.type;
                r.effectTSec = p.tSec;
                r.effectRateHz = p.rateHz;

                r.value = applyEffect(r.value, p);
            }

            out.push_back(std::move(r));
            ++fixturePos;
        }
    }

    return out;
}

} // namespace resostage
