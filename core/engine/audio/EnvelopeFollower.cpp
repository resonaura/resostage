#include "EnvelopeFollower.h"

namespace resostage {

EnvelopeFollower::EnvelopeFollower(double sampleRateIn, double attackMsIn,
                                   double releaseMsIn,
                                   EnvelopeDetectorMode modeIn) noexcept {
    prepare(sampleRateIn, attackMsIn, releaseMsIn, modeIn);
}

void EnvelopeFollower::prepare(double sampleRateIn, double attackMsIn, double releaseMsIn,
                               EnvelopeDetectorMode modeIn) noexcept {
    sampleRate = sampleRateIn > 0.0 ? sampleRateIn : 48000.0;
    mode = modeIn;
    setAttackMs(attackMsIn);
    setReleaseMs(releaseMsIn);
    reset();
}

void EnvelopeFollower::setAttackMs(double attackMs) noexcept {
    attackTimeMs = std::max(0.01, attackMs);
    attackCoeff = static_cast<float>(
        std::exp(-1000.0 / (attackTimeMs * sampleRate)));
}

void EnvelopeFollower::setReleaseMs(double releaseMs) noexcept {
    releaseTimeMs = std::max(0.01, releaseMs);
    releaseCoeff = static_cast<float>(
        std::exp(-1000.0 / (releaseTimeMs * sampleRate)));
}

void EnvelopeFollower::reset(float initialValue) noexcept {
    envelope = initialValue;
}

void EnvelopeFollower::process(const float* input, float* output, int numSamples) noexcept {
    if (input == nullptr || numSamples <= 0)
        return;

    float env = envelope;
    const float att = attackCoeff;
    const float rel = releaseCoeff;

    if (mode == EnvelopeDetectorMode::Peak) {
        for (int i = 0; i < numSamples; ++i) {
            const float in = std::abs(input[i]);
            if (in > env)
                env = in + att * (env - in);
            else
                env = in + rel * (env - in);

            // Anti-denormal flush
            if (env < 1.0e-9f)
                env = 0.0f;

            if (output != nullptr)
                output[i] = env;
        }
    } else { // RMS mode
        for (int i = 0; i < numSamples; ++i) {
            const float inSq = input[i] * input[i];
            if (inSq > env)
                env = inSq + att * (env - inSq);
            else
                env = inSq + rel * (env - inSq);

            if (env < 1.0e-18f)
                env = 0.0f;

            if (output != nullptr)
                output[i] = std::sqrt(env);
        }
    }

    envelope = env;
}

void EnvelopeFollower::processStereo(const float* inputL, const float* inputR,
                                     float* output, int numSamples) noexcept {
    if (inputL == nullptr || inputR == nullptr || numSamples <= 0)
        return;

    float env = envelope;
    const float att = attackCoeff;
    const float rel = releaseCoeff;

    if (mode == EnvelopeDetectorMode::Peak) {
        for (int i = 0; i < numSamples; ++i) {
            const float inL = std::abs(inputL[i]);
            const float inR = std::abs(inputR[i]);
            const float in = std::max(inL, inR);

            if (in > env)
                env = in + att * (env - in);
            else
                env = in + rel * (env - in);

            if (env < 1.0e-9f)
                env = 0.0f;

            if (output != nullptr)
                output[i] = env;
        }
    } else { // RMS mode
        for (int i = 0; i < numSamples; ++i) {
            const float inSqL = inputL[i] * inputL[i];
            const float inSqR = inputR[i] * inputR[i];
            const float inSq = std::max(inSqL, inSqR);

            if (inSq > env)
                env = inSq + att * (env - inSq);
            else
                env = inSq + rel * (env - inSq);

            if (env < 1.0e-18f)
                env = 0.0f;

            if (output != nullptr)
                output[i] = std::sqrt(env);
        }
    }

    envelope = env;
}

} // namespace resostage
