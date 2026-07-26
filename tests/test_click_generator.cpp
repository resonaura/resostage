#include "doctest.h"

#include "audio/ClickGenerator.h"

#include <algorithm>
#include <cmath>
#include <vector>

using namespace resoset;

namespace {
// The click is a decaying sine burst, which starts at a zero-crossing (sin(0)==0
// even though the envelope peaks there) -- so "is there a click here" is best
// checked as the max absolute value over a short window, not one exact sample.
float peakAbsInWindow(const ClickGenerator& click, int64_t startSample, int windowSamples) {
    std::vector<float> buf(static_cast<size_t>(windowSamples));
    click.render(buf.data(), windowSamples, startSample);
    float peak = 0.0f;
    for (float v : buf)
        peak = std::max(peak, std::abs(v));
    return peak;
}
} // namespace

TEST_CASE("ClickGenerator produces a peak right at each beat boundary and silence between") {
    ClickGenerator click;
    const double sampleRate = 48000.0;
    const double bpm = 120.0; // samplesPerBeat = 48000*60/120 = 24000
    click.prepare(sampleRate, bpm, 4);

    const int64_t samplesPerBeat = 24000;

    CHECK(peakAbsInWindow(click, 0, 50) > 0.5f); // beat 0 (accented)

    // Well inside the beat, past the ~30ms click window (30ms @ 48kHz = 1440 samples).
    std::vector<float> single(1);
    click.render(single.data(), 1, 5000);
    CHECK(single[0] == doctest::Approx(0.0f));

    CHECK(peakAbsInWindow(click, samplesPerBeat, 50) > 0.5f); // next beat boundary

    // Mid-way between beat 1 and beat 2: silence again.
    click.render(single.data(), 1, samplesPerBeat + 5000);
    CHECK(single[0] == doctest::Approx(0.0f));
}

TEST_CASE("ClickGenerator accents beat 1 of each bar louder than other beats") {
    ClickGenerator click;
    const double sampleRate = 48000.0;
    const double bpm = 120.0;
    click.prepare(sampleRate, bpm, 4);
    const int64_t samplesPerBeat = 24000;

    const float accentedPeak = peakAbsInWindow(click, 0, 50);              // beat 0 (bar-start, accented)
    const float normalPeak = peakAbsInWindow(click, samplesPerBeat, 50);   // beat 1 (not accented)
    CHECK(accentedPeak > normalPeak);

    const float nextBarPeak = peakAbsInWindow(click, samplesPerBeat * 4, 50); // beat 4 == next bar-start, accented again
    CHECK(nextBarPeak == doctest::Approx(accentedPeak));
}

TEST_CASE("ClickGenerator is consistent regardless of block boundaries (no internal state)") {
    ClickGenerator click;
    click.prepare(48000.0, 100.0, 3);

    // Render a stretch of samples in one call, then render the same stretch
    // split across several smaller calls starting at different absolute
    // positions -- results must match exactly, since render() is purely a
    // function of (position), not of prior calls.
    const int64_t start = 12345;
    const int total = 2000;

    std::vector<float> whole(static_cast<size_t>(total));
    click.render(whole.data(), total, start);

    std::vector<float> pieced(static_cast<size_t>(total));
    int pos = 0;
    const int chunk = 137; // deliberately awkward, doesn't divide evenly
    while (pos < total) {
        const int n = std::min(chunk, total - pos);
        click.render(pieced.data() + pos, n, start + pos);
        pos += n;
    }

    for (int i = 0; i < total; ++i)
        CHECK(whole[static_cast<size_t>(i)] == pieced[static_cast<size_t>(i)]);
}
