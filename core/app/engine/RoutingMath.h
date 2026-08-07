// Pure channel-placement, gain math, metering, and audibility rules for the
// engine routing render path. Extracted so the exact rules the audio thread runs
// are unit-testable headlessly (see core/tests/test_routing_math.cpp). Every
// function is `inline`, free of side effects, and independent of JUCE / device state.
#pragma once

#include <algorithm>
#include <cmath>

namespace resostage {
namespace routing_math {

// Audibility / Mute & Solo evaluation for any channel strip
inline bool isChannelAudible(bool mute, bool solo, bool anySoloInGroup) {
    if (mute) return false;
    if (anySoloInGroup && !solo) return false;
    return true;
}

// Linear Gain conversion helper
inline float dbToGain(double db) {
    if (db <= -144.0) return 0.0f;
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

// Balance-pan coefficients (the engine's single pan law for tracks/buses/click).
inline void panGains(float g, float pan, float& gL, float& gR) {
    const float p = std::clamp(pan, -1.0f, 1.0f);
    gL = g * (1.0f - std::max(0.0f, p));
    gR = g * (1.0f + std::min(0.0f, p));
}

// Standard mono sum formula
inline float monoSum(float sampleL, float sampleR) {
    return 0.5f * (sampleL + sampleR);
}

// Route one sample into a destination bus.
struct Placed {
    float ch0 = 0.0f;
    float ch1 = 0.0f;
};

inline Placed placeIntoBus(bool busStereo, int sourceChannel, float preL,
                           float preR, float gL, float gR) {
    if (busStereo)
        return { preL * gL, preR * gR };
    if (sourceChannel == 0)
        return { preL * gL, 0.0f };
    if (sourceChannel == 1)
        return { preR * gR, 0.0f };
    return { monoSum(preL * gL, preR * gR), 0.0f };
}

// Per-send target gains for a mono click into a (possibly stereo) send bus.
inline void clickSendTargets(bool clickMono, float clickGainLinear,
                             float sendGain, float pan, float& tL, float& tR) {
    const float base = clickGainLinear * sendGain;
    if (clickMono) {
        tL = base;
        tR = base;
        return;
    }
    panGains(base, pan, tL, tR);
}

// Physical channels for bus egress.
inline void egressChannels(int busChannels, int start, int& outCh0,
                           int& outCh1) {
    outCh0 = start;
    outCh1 = (busChannels >= 2) ? start + 1 : -1;
}

// Unified Metering Processor: Post-Fader & Post-Pan calculation for ANY channel.
// Independent of downstream Mute / Solo silences.
inline void calculateMeterFrame(const float* pL, const float* pR, int numSamples,
                                float rawGainLinear, float pan, int channelCount,
                                float* meterBufL, float* meterBufR,
                                float& outPeakL, float& outPeakR) {
    float gL = 0.0f, gR = 0.0f;
    panGains(rawGainLinear, pan, gL, gR);

    outPeakL = 0.0f;
    outPeakR = 0.0f;

    for (int i = 0; i < numSamples; ++i) {
        float sampleL = (pL != nullptr && std::isfinite(pL[i])) ? pL[i] : 0.0f;
        float sampleR = (pR != nullptr && std::isfinite(pR[i])) ? pR[i] : sampleL;

        if (channelCount == 1) {
            const float mid = monoSum(sampleL, sampleR);
            sampleL = mid * gL;
            sampleR = mid * gR;
        } else {
            sampleL *= gL;
            sampleR *= gR;
        }

        if (meterBufL != nullptr) meterBufL[i] = sampleL;
        if (meterBufR != nullptr) meterBufR[i] = sampleR;

        outPeakL = std::max(outPeakL, std::abs(sampleL));
        outPeakR = std::max(outPeakR, std::abs(sampleR));
    }
}

} // namespace routing_math
} // namespace resostage
