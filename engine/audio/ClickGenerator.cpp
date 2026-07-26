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
    const double samplesPerBeat = sampleRateHz * 60.0 / bpm;
    const double clickDurationSamples = std::min(samplesPerBeat * 0.5, sampleRateHz * 0.03); // <=30ms, never into the next beat

    for (int i = 0; i < numFrames; ++i) {
        const double absPos = static_cast<double>(startSample + i);
        const int64_t beatIndex = static_cast<int64_t>(std::floor(absPos / samplesPerBeat));
        const double positionInBeat = absPos - static_cast<double>(beatIndex) * samplesPerBeat;

        if (positionInBeat < clickDurationSamples) {
            const int64_t beatInBar = ((beatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar;
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
