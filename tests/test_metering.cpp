// NOTE: These tests check monotonicity/sanity properties of LoudnessMeter
// (louder-is-higher, silence-stays-gated, peak-tracks-signal), not bit-exact
// ITU-R BS.1770-4 conformance against a golden reference number. See the
// "Integrated-loudness note" in Metering.h for why: this meter is a bounded-
// memory running estimate for live monitoring, not a certification tool.
#include "doctest.h"

#include "audio/Metering.h"

#include <algorithm>
#include <cmath>
#include <vector>

using namespace resostage;

namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<float> makeSine(double freqHz, double sampleRate, int numSamples, float amplitude) {
    std::vector<float> out(static_cast<size_t>(numSamples));
    for (int i = 0; i < numSamples; ++i) {
        out[static_cast<size_t>(i)] =
            amplitude * static_cast<float>(std::sin(2.0 * kPi * freqHz * static_cast<double>(i) / sampleRate));
    }
    return out;
}

struct RunResult {
    float maxPeakDb = -144.0f;
    float maxTruePeakDb = -144.0f;
    MeterFrame finalFrame;
};

// Feeds a mono buffer through a LoudnessMeter in fixed-size render blocks,
// tracking the peak/true-peak seen across ALL blocks (peakDb itself is
// block-local / non-latching by design) alongside the final frame's
// short-term/integrated LUFS readings.
RunResult runMeter(const std::vector<float>& samples, double sampleRate, int blockSize) {
    LoudnessMeter meter;
    meter.prepare(sampleRate, 1);

    RunResult result;
    int pos = 0;
    while (pos < static_cast<int>(samples.size())) {
        const int n = std::min(blockSize, static_cast<int>(samples.size()) - pos);
        const float* channelPtrs[1] = {samples.data() + pos};
        meter.processBlock(channelPtrs, n);

        const MeterFrame frame = meter.currentFrame();
        result.maxPeakDb = std::max(result.maxPeakDb, frame.peakDb);
        result.maxTruePeakDb = std::max(result.maxTruePeakDb, frame.truePeakDb);
        result.finalFrame = frame;

        pos += n;
    }
    return result;
}

} // namespace

TEST_CASE("LoudnessMeter: silence never leaves the gated floor") {
    std::vector<float> silence(static_cast<size_t>(48000 * 2), 0.0f); // 2s @ 48kHz
    RunResult result = runMeter(silence, 48000.0, 512);
    CHECK(result.finalFrame.integratedLufs <= -100.0f);
    CHECK(result.maxPeakDb <= -100.0f);
}

TEST_CASE("LoudnessMeter: full-scale tone's peak is reported near 0 dBFS") {
    auto sine = makeSine(1000.0, 48000.0, 48000 * 2, 1.0f);
    RunResult result = runMeter(sine, 48000.0, 512);
    CHECK(result.maxPeakDb > -1.0f);
    CHECK(result.maxPeakDb <= 0.1f); // allow tiny float slack above 0dB
}

TEST_CASE("LoudnessMeter: louder tone reads a higher (less negative) integrated LUFS") {
    auto loud = makeSine(1000.0, 48000.0, 48000 * 3, 1.0f);
    auto quiet = makeSine(1000.0, 48000.0, 48000 * 3, 0.1f);

    RunResult loudResult = runMeter(loud, 48000.0, 512);
    RunResult quietResult = runMeter(quiet, 48000.0, 512);

    CHECK(loudResult.finalFrame.integratedLufs > quietResult.finalFrame.integratedLufs);
}

TEST_CASE("LoudnessMeter: true peak never undershoots the sample peak") {
    auto sine = makeSine(1000.0, 44100.0, 44100 * 2, 0.9f);
    RunResult result = runMeter(sine, 44100.0, 512);
    CHECK(result.maxTruePeakDb >= result.maxPeakDb - 0.5f);
}

TEST_CASE("LoudnessMeter: short-term LUFS is stable (low variance) on a steady tone") {
    // Feed a long steady tone and sample short-term LUFS periodically after the
    // 3s short-term window has filled; readings should cluster tightly.
    LoudnessMeter meter;
    meter.prepare(48000.0, 1);
    auto sine = makeSine(1000.0, 48000.0, 48000 * 6, 0.5f);

    std::vector<float> readings;
    int pos = 0;
    const int blockSize = 512;
    while (pos < static_cast<int>(sine.size())) {
        const int n = std::min(blockSize, static_cast<int>(sine.size()) - pos);
        const float* channelPtrs[1] = {sine.data() + pos};
        meter.processBlock(channelPtrs, n);
        pos += n;
        if (pos > 48000 * 4) // only sample once the short-term window is well established
            readings.push_back(meter.currentFrame().shortTermLufs);
    }

    REQUIRE_FALSE(readings.empty());
    const float first = readings.front();
    for (float r : readings)
        CHECK(std::abs(r - first) < 1.0f); // within 1 LU of each other on a steady tone
}

// ─── BandEnergyMeter (GEQ/Blurz spectrum source) ───────────────────────────

// Feeds a mono buffer through a BandEnergyMeter and returns the settled 0..1
// per-band levels (index 0 = lowest band).
std::vector<float> runBandMeter(const std::vector<float>& samples, double sampleRate) {
    BandEnergyMeter meter;
    meter.prepare(sampleRate, 1);
    int pos = 0;
    const int blockSize = 512;
    while (pos < static_cast<int>(samples.size())) {
        const int n = std::min(blockSize, static_cast<int>(samples.size()) - pos);
        const float* channelPtrs[1] = {samples.data() + pos};
        meter.processBlock(channelPtrs, n);
        pos += n;
    }
    std::vector<float> levels(static_cast<size_t>(kLightBandCount));
    meter.currentLevels(levels.data());
    return levels;
}

TEST_CASE("BandEnergyMeter: a tone at a band centre peaks that band and falls off monotonically") {
    // 250 Hz sits exactly on band 1's centre (kLightBandCentersHz[1]). With
    // Q=1 RBJ bandpasses the overlap is deliberately gentle (see Metering.h),
    // so neighbouring bands read noticeably but the CENTRE band is the
    // unambiguous peak and levels decay monotonically away from it.
    auto sine = makeSine(250.0, 48000.0, 48000 * 3, 0.9f);
    auto levels = runBandMeter(sine, 48000.0);

    REQUIRE(levels.size() == static_cast<size_t>(kLightBandCount));
    // Centre band is the peak...
    CHECK(levels[1] > levels[0]);
    CHECK(levels[1] > levels[2]);
    // ...and levels fall off monotonically away from it in both directions.
    CHECK(levels[0] < levels[1]);
    CHECK(levels[2] < levels[1]);
    CHECK(levels[3] < levels[2]);
    CHECK(levels[4] < levels[3]);
    CHECK(levels[5] < levels[4]);
    // The centre band is strongly lit.
    CHECK(levels[1] > 0.5f);
    // A full-scale tone far outside a band still leaks only a fraction of the
    // centre level (the 10 kHz band is ~6 octaves above 250 Hz).
    CHECK(levels[5] < levels[1] * 0.5f);
}

TEST_CASE("BandEnergyMeter: a louder tone reads a higher level on its band") {
    auto quiet = makeSine(1600.0, 48000.0, 48000 * 3, 0.08f); // ~ -24dBFS RMS -> ~0.5
    auto loud  = makeSine(1600.0, 48000.0, 48000 * 3, 1.0f);  // near full-scale -> ~0.94
    auto quietLevels = runBandMeter(quiet, 48000.0);
    auto loudLevels  = runBandMeter(loud, 48000.0);

    CHECK(loudLevels[3] > quietLevels[3] + 0.2f);
    CHECK(quietLevels[3] > 0.3f); // quiet-but-audible still reads above silence
    CHECK(quietLevels[3] < loudLevels[3]); // strictly monotonic in amplitude
}

TEST_CASE("BandEnergyMeter: silence reads as all-zero bands") {
    std::vector<float> silence(static_cast<size_t>(48000 * 2), 0.0f);
    auto levels = runBandMeter(silence, 48000.0);
    for (float l : levels)
        CHECK(l < 0.01f);
}

TEST_CASE("LoudnessMeter: currentFrame carries bandLevel from its BandEnergyMeter pass") {
    LoudnessMeter meter;
    meter.prepare(48000.0, 1);
    auto sine = makeSine(630.0, 48000.0, 48000 * 3, 0.9f); // band 2 centre
    int pos = 0;
    const int blockSize = 512;
    while (pos < static_cast<int>(sine.size())) {
        const int n = std::min(blockSize, static_cast<int>(sine.size()) - pos);
        const float* channelPtrs[1] = {sine.data() + pos};
        meter.processBlock(channelPtrs, n);
        pos += n;
    }
    const MeterFrame frame = meter.currentFrame();
    CHECK(frame.bandLevel[2] > 0.5f);
    // 10kHz band reads well below the 630Hz centre band for a 630Hz tone.
    CHECK(frame.bandLevel[5] < frame.bandLevel[2] * 0.5f);
}
