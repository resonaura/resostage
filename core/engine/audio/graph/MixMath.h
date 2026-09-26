// The four rules every strip in the mixer obeys, in one place.
//
// Extracted from the render path so they are unit-testable headlessly (see
// core/tests/test_mix_math.cpp) and, more importantly, so there is exactly
// one of each. The bug this file exists to prevent is the one that shipped:
// four hand-written copies of the pan law and the audibility rule, of which
// the master's copy quietly stopped being applied.
//
// Every function is inline, side-effect free and independent of JUCE.
#pragma once

#include <algorithm>
#include <cmath>

namespace resostage {
namespace mix_math {

// Mute wins over everything. Otherwise, once anything in the strip's solo
// group is soloed, only the soloed members stay up.
inline bool isAudible(bool mute, bool solo, bool anySoloInGroup) {
    if (mute)
        return false;
    if (anySoloInGroup && !solo)
        return false;
    return true;
}

// Fader position -> linear gain. -144 dB and below is exact silence, so a
// fader pulled to the bottom cannot leave a residual -0.00001 trickle.
inline float dbToGain(double db) {
    if (!(db > -144.0))
        return 0.0f;
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

// Balance pan: attenuate the side you pan away from, never boost the other.
// One law for tracks, sends, the click and the master -- a strip's pan means
// the same thing wherever it sits in the graph.
inline void panGains(float gain, float pan, float& outL, float& outR) {
    const float p = std::clamp(pan, -1.0f, 1.0f);
    outL = gain * (1.0f - std::max(0.0f, p));
    outR = gain * (1.0f + std::min(0.0f, p));
}

// Stereo -> mono fold. Averaged, not summed, so folding a correlated stereo
// pair to mono holds its level instead of gaining 6 dB.
inline float monoSum(float left, float right) {
    return 0.5f * (left + right);
}

} // namespace mix_math
} // namespace resostage
