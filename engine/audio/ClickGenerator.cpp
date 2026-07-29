#include "ClickGenerator.h"

#include <algorithm>
#include <cmath>

namespace resostage {

namespace {
constexpr double kPi = 3.14159265358979323846;
}

double ClickGenerator::samplesPerBeat() const {
    // Project BPM is "beats per minute" for the notated beat (same unit the
    // UI bar|beat counter and globalBeatsElapsed use). Denominator is part of
    // the meter identity for retarget/MIDI but does not rescale this grid --
    // authors bake the intended beat rate into BPM.
    const double safeBpm = bpm > 0.0 ? bpm : 120.0;
    const double safeSr = sampleRateHz > 0.0 ? sampleRateHz : 48000.0;
    return safeSr * 60.0 / safeBpm;
}

void ClickGenerator::prepare(double sampleRateHzIn, double bpmIn, int beatsPerBarIn, int beatUnitIn) {
    sampleRateHz = sampleRateHzIn > 0.0 ? sampleRateHzIn : 48000.0;
    bpm = bpmIn > 0.0 ? bpmIn : 120.0;
    beatsPerBar = beatsPerBarIn > 0 ? beatsPerBarIn : 4;
    beatUnit = beatUnitIn > 0 ? beatUnitIn : 4;
}

void ClickGenerator::retarget(double bpmIn, int beatsPerBarIn, int beatUnitIn) {
    bpm = bpmIn > 0.0 ? bpmIn : 120.0;
    beatsPerBar = beatsPerBarIn > 0 ? beatsPerBarIn : 4;
    beatUnit = beatUnitIn > 0 ? beatUnitIn : 4;
}

void ClickGenerator::render(float* outMono, int numFrames, int64_t startSample) const {
    // samplesPerBeat is the single source of truth for beat boundaries --
    // identical math every call, no internal phase state -- so the click
    // stays sample-locked to whatever absolute playhead the engine passes.
    // Strong beat = beatIndex % beatsPerBar == 0 (bar downbeat).
    const double spb = samplesPerBeat();
    if (!(spb > 0.0) || numFrames <= 0 || outMono == nullptr) {
        if (outMono != nullptr && numFrames > 0)
            std::fill(outMono, outMono + numFrames, 0.0f);
        return;
    }
    const double clickDurationSamples = std::min(spb * 0.5, sampleRateHz * 0.03); // <=30ms
    const int64_t beatsPerBarSafe = beatsPerBar > 0 ? static_cast<int64_t>(beatsPerBar) : 4;
    const double sr = sampleRateHz > 0.0 ? sampleRateHz : 48000.0;

    for (int i = 0; i < numFrames; ++i) {
        // Integer-stable beat index: floor(sample / spb) via truncation of a
        // non-negative quotient. Avoids fmod edge cases at exact boundaries.
        const double absPos = static_cast<double>(startSample + i);
        const double quot = absPos / spb;
        const int64_t beatIndex =
            quot >= 0.0 ? static_cast<int64_t>(quot) : static_cast<int64_t>(std::floor(quot));
        const double positionInBeat = absPos - static_cast<double>(beatIndex) * spb;

        if (positionInBeat >= 0.0 && positionInBeat < clickDurationSamples) {
            // Strong (accented) on beat 1 of each bar; weak on the rest.
            // beatsPerBar comes from time-signature numerator (3/4 → accent
            // every 3, 7/8 → every 7, 4/4 → every 4).
            const int64_t beatInBar =
                ((beatIndex % beatsPerBarSafe) + beatsPerBarSafe) % beatsPerBarSafe;
            const bool accented = beatInBar == 0;
            const double freq = accented ? 1500.0 : 1000.0;
            const double t = positionInBeat / sr;
            const double envelope = std::exp(-t * 80.0);
            outMono[i] = static_cast<float>(
                envelope * std::sin(2.0 * kPi * freq * t) * (accented ? 0.9 : 0.6));
        } else {
            outMono[i] = 0.0f;
        }
    }
}

} // namespace resostage
