#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace resostage {

enum class EnvelopeDetectorMode {
    Peak,
    Rms,
};

class EnvelopeFollower {
public:
    EnvelopeFollower() = default;
    explicit EnvelopeFollower(double sampleRate, double attackMs = 10.0,
                              double releaseMs = 100.0,
                              EnvelopeDetectorMode mode = EnvelopeDetectorMode::Peak) noexcept;

    void prepare(double sampleRateIn, double attackMsIn, double releaseMsIn,
                 EnvelopeDetectorMode modeIn = EnvelopeDetectorMode::Peak) noexcept;

    void setAttackMs(double attackMs) noexcept;
    void setReleaseMs(double releaseMs) noexcept;

    void reset(float initialValue = 0.0f) noexcept;

    float getCurrentValue() const noexcept { return envelope; }

    // Process mono buffer into output buffer (can be in-place if input == output)
    void process(const float* input, float* output, int numSamples) noexcept;

    // Process stereo buffer, tracking maximum level between left and right
    void processStereo(const float* inputL, const float* inputR,
                       float* output, int numSamples) noexcept;

private:
    double sampleRate = 48000.0;
    double attackTimeMs = 10.0;
    double releaseTimeMs = 100.0;
    float attackCoeff = 0.0f;
    float releaseCoeff = 0.0f;
    float envelope = 0.0f;
    EnvelopeDetectorMode mode = EnvelopeDetectorMode::Peak;
};

} // namespace resostage
