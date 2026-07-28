#include "ClickGenerator.h"

#include <algorithm>
#include <cmath>

namespace resoset {

namespace {
constexpr double kPi = 3.14159265358979323846;
}

void ClickGenerator::prepare(double sampleRateHzIn, double bpmIn, int beatsPerBarIn) {
    sampleRateHz = sampleRateHzIn > 0.0 ? sampleRateHzIn : 48000.0;
    bpm = bpmIn > 0.0 ? bpmIn : 120.0;
    beatsPerBar = beatsPerBarIn > 0 ? beatsPerBarIn : 4;
}

void ClickGenerator::render(float* outMono, int numFrames, int64_t startSample) const {
    // samplesPerBeat is the single source of truth for beat boundaries --
    // identical math every call, no internal phase state -- so the click
    // stays sample-locked to whatever absolute playhead the engine passes
    // (which must be the same index used for StreamingTrackBuffer::read).
    const double samplesPerBeat = sampleRateHz * 60.0 / bpm;
    if (!(samplesPerBeat > 0.0) || numFrames <= 0 || outMono == nullptr) {
        if (outMono != nullptr && numFrames > 0)
            std::fill(outMono, outMono + numFrames, 0.0f);
        return;
    }
    const double clickDurationSamples = std::min(samplesPerBeat * 0.5, sampleRateHz * 0.03); // <=30ms
    const int64_t beatsPerBarSafe = beatsPerBar > 0 ? static_cast<int64_t>(beatsPerBar) : 4;

    for (int i = 0; i < numFrames; ++i) {
        // Integer-stable beat index: floor(sample / spb) via truncation of a
        // non-negative quotient. Avoids fmod edge cases at exact boundaries
        // where floating residual could push the click one sample early/late
        // relative to a WAV that was authored on the same grid.
        const double absPos = static_cast<double>(startSample + i);
        const double quot = absPos / samplesPerBeat;
        const int64_t beatIndex = quot >= 0.0 ? static_cast<int64_t>(quot) : static_cast<int64_t>(std::floor(quot));
        const double positionInBeat = absPos - static_cast<double>(beatIndex) * samplesPerBeat;

        if (positionInBeat >= 0.0 && positionInBeat < clickDurationSamples) {
            const int64_t beatInBar = ((beatIndex % beatsPerBarSafe) + beatsPerBarSafe) % beatsPerBarSafe;
            const bool accented = beatInBar == 0;
            const double freq = accented ? 1500.0 : 1000.0;
            const double t = positionInBeat / sampleRateHz;
            const double envelope = std::exp(-t * 80.0);
            outMono[i] = static_cast<float>(envelope * std::sin(2.0 * kPi * freq * t) * (accented ? 0.9 : 0.6));
        } else {
            outMono[i] = 0.0f;
        }
    }
}

} // namespace resoset
