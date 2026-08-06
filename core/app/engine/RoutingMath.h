// Pure channel-placement / gain math for the routing render path. Extracted so
// the exact rules the audio thread runs are unit-testable headlessly (see
// core/tests/test_routing_math.cpp) instead of being buried in the realtime
// callback. Every function is `inline`, free of side effects, and independent
// of JUCE / device state.
#pragma once

#include <algorithm>
#include <cmath>

namespace resostage {
namespace routing_math {

// Route one sample into a destination bus.
//   busStereo   : destination has >= 2 channels (busScratch holds L + R).
//   sourceChannel: -1 = sum both source channels, 0 = LEFT only, 1 = RIGHT only
//                  (only meaningful for a 1-channel destination -- a mono lane).
//   preL/preR   : source sample (post mono-mix crossfade, pre-pan).
//   gL/gR       : pan/gain coefficients for L and R.
// Returns the sample(s) to add into the destination's channel 0 (out0) and
// channel 1 (out1). A 1-channel destination only ever writes out0.
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
    return { 0.5f * (preL * gL + preR * gR), 0.0f };
}

// Balance-pan coefficients (the engine's single pan law for tracks/buses/click).
inline void panGains(float g, float pan, float& gL, float& gR) {
    gL = g * (1.0f - std::max(0.0f, pan));
    gR = g * (1.0f + std::min(0.0f, pan));
}

// Per-send target gains for a mono click into a (possibly stereo) send bus.
// clickGainLinear is the metronome's own level -- it MUST be included or the
// send amount is independent of the click volume knob.
inline void clickSendTargets(bool clickMono, float clickGainLinear,
                             float sendGain, float pan, float& tL, float& tR) {
    const float base = clickGainLinear * sendGain;
    if (clickMono) {
        tL = base;
        tR = base;
        return;
    }
    tL = base * (1.0f - std::max(0.0f, pan));
    tR = base * (1.0f + std::min(0.0f, pan));
}

// A project bus that is mono (channelCount == 1) physically writes to exactly
// ONE output channel (its start) -- the honest routing model. The legacy
// "mono hits both speakers" pair-doubling overlapped adjacent sends and made
// a mono click sound louder in one ear. Returns the two physical channels the
// bus should write (second = -1 when mono).
inline void egressChannels(int busChannels, int start, int& outCh0,
                           int& outCh1) {
    outCh0 = start;
    outCh1 = (busChannels >= 2) ? start + 1 : -1;
}

} // namespace routing_math
} // namespace resostage
