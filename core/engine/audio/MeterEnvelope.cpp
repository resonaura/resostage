#include "MeterEnvelope.h"

#include <cmath>

namespace resostage {

void PpmBallistics::prepare(double sampleRate) {
    const double sr = sampleRate > 0.0 ? sampleRate : 48000.0;
    // Per-sample multiplier for the standard's fall rate, so the release is
    // the same wall-clock slope whatever the buffer size or sample rate.
    releasePerSample = std::pow(10.0, -(kReleaseDbPerSecond / (20.0 * sr)));
    current = 0.0f;
}

float PpmBallistics::process(float blockPeak, int numSamples) {
    if (numSamples > 0 && current > 0.0f) {
        const double decay = std::pow(releasePerSample, static_cast<double>(numSamples));
        current = static_cast<float>(static_cast<double>(current) * decay);
        // Below this the value is inaudible and unplottable; letting it run on
        // as a denormal costs more than it says.
        if (current < 1.0e-7f)
            current = 0.0f;
    }
    // Instant attack: a peak meter that averages its way up is under-reading.
    if (blockPeak > current)
        current = blockPeak;
    return current;
}

void MeterEnvelopeTracker::prepare(double sampleRate) {
    ppmL.prepare(sampleRate);
    ppmR.prepare(sampleRate);
}

void MeterEnvelopeTracker::reset() {
    ppmL.reset();
    ppmR.reset();
}

MeterEnvelopePoint MeterEnvelopeTracker::measure(const float* const* channels, int numChannels,
                                                 int start, int len) {
    MeterEnvelopePoint point;
    if (channels == nullptr || numChannels <= 0 || len <= 0)
        return point;

    // Channel 0 is left; channel 1 is right if there is one, otherwise left
    // again -- a mono strip drives both needles rather than leaving one dead.
    float peaks[2] = {0.0f, 0.0f};
    double sumSquares = 0.0;
    int counted = 0;
    for (int ch = 0; ch < numChannels && ch < 2; ++ch) {
        const float* data = channels[ch];
        if (data == nullptr)
            continue;
        float peak = 0.0f;
        for (int i = start; i < start + len; ++i) {
            const float v = data[i];
            const float a = v < 0.0f ? -v : v;
            if (a > peak)
                peak = a;
            sumSquares += static_cast<double>(v) * static_cast<double>(v);
        }
        peaks[ch] = peak;
        ++counted;
    }
    if (counted == 1)
        peaks[1] = peaks[0];

    point.peakL = peaks[0];
    point.peakR = peaks[1];
    point.rms = counted > 0
        ? static_cast<float>(
              std::sqrt(sumSquares / (static_cast<double>(len) * static_cast<double>(counted))))
        : 0.0f;
    point.ppmL = ppmL.process(peaks[0], len);
    point.ppmR = ppmR.process(peaks[1], len);
    return point;
}

} // namespace resostage
