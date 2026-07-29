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
    click.prepare(sampleRate, bpm, 4, 4);

    const int64_t samplesPerBeat = 24000;

    CHECK(peakAbsInWindow(click, 0, 50) > 0.5f); // beat 0 (accented)

    std::vector<float> single(1);
    click.render(single.data(), 1, 5000);
    CHECK(single[0] == doctest::Approx(0.0f));

    CHECK(peakAbsInWindow(click, samplesPerBeat, 50) > 0.5f);

    click.render(single.data(), 1, samplesPerBeat + 5000);
    CHECK(single[0] == doctest::Approx(0.0f));
}

TEST_CASE("ClickGenerator accents beat 1 of each bar louder than other beats") {
    ClickGenerator click;
    click.prepare(48000.0, 120.0, 4, 4);
    const int64_t samplesPerBeat = 24000;

    const float accentedPeak = peakAbsInWindow(click, 0, 50);
    const float normalPeak = peakAbsInWindow(click, samplesPerBeat, 50);
    CHECK(accentedPeak > normalPeak);

    const float nextBarPeak = peakAbsInWindow(click, samplesPerBeat * 4, 50);
    CHECK(nextBarPeak == doctest::Approx(accentedPeak));
}

TEST_CASE("ClickGenerator is consistent regardless of block boundaries (pure function of position)") {
    ClickGenerator click;
    click.prepare(48000.0, 100.0, 3, 4);

    const int64_t start = 12345;
    const int total = 2000;

    std::vector<float> whole(static_cast<size_t>(total));
    click.render(whole.data(), total, start);

    std::vector<float> pieced(static_cast<size_t>(total));
    int pos = 0;
    const int chunk = 137;
    while (pos < total) {
        const int n = std::min(chunk, total - pos);
        click.render(pieced.data() + pos, n, start + pos);
        pos += n;
    }

    for (int i = 0; i < total; ++i)
        CHECK(whole[static_cast<size_t>(i)] == pieced[static_cast<size_t>(i)]);
}

TEST_CASE("ClickGenerator 3/4 accents every 3 beats (strong on 1, weak on 2 and 3)") {
    ClickGenerator click;
    click.prepare(48000.0, 120.0, 3, 4);
    const int64_t spb = 24000;

    const float b0 = peakAbsInWindow(click, 0, 50);       // strong
    const float b1 = peakAbsInWindow(click, spb, 50);     // weak
    const float b2 = peakAbsInWindow(click, spb * 2, 50); // weak
    const float b3 = peakAbsInWindow(click, spb * 3, 50); // strong (next bar)

    CHECK(b0 > b1);
    CHECK(b0 > b2);
    CHECK(b1 == doctest::Approx(b2));
    CHECK(b3 == doctest::Approx(b0));
}

TEST_CASE("ClickGenerator 7/8 accents every 7 beats") {
    ClickGenerator click;
    click.prepare(48000.0, 140.0, 7, 8);
    const int64_t spb = static_cast<int64_t>(std::llround(click.samplesPerBeat()));

    const float strong0 = peakAbsInWindow(click, 0, 50);
    const float weak1 = peakAbsInWindow(click, spb, 50);
    const float strong7 = peakAbsInWindow(click, spb * 7, 50);

    CHECK(strong0 > weak1);
    CHECK(strong7 == doctest::Approx(strong0));
    CHECK(click.currentBeatUnit() == 8);
    CHECK(click.currentBeatsPerBar() == 7);
}

TEST_CASE("retarget updates meter accents without needing a phase reset") {
    ClickGenerator click;
    click.prepare(48000.0, 120.0, 4, 4);
    const int64_t spb = 24000;

    // Under 4/4, sample at 3*spb is beat 3 (weak, last of bar).
    const float weakUnder4 = peakAbsInWindow(click, spb * 3, 50);
    // Under 3/4 after retarget, sample at 3*spb is beat 0 of next bar (strong).
    click.retarget(120.0, 3, 4);
    const float strongUnder3 = peakAbsInWindow(click, spb * 3, 50);
    CHECK(strongUnder3 > weakUnder4);
    CHECK(click.currentBeatsPerBar() == 3);
}

TEST_CASE("playhead sample 0 is always the strong downbeat after tempo hop") {
    ClickGenerator click;
    click.prepare(48000.0, 100.0, 4, 4);
    click.retarget(180.0, 5, 8);
    // New song at playhead 0 must be accented regardless of prior tempo/meter.
    const float peak = peakAbsInWindow(click, 0, 50);
    CHECK(peak > 0.5f);
    // Beat 1 (not 0) is weak under 5/8.
    const int64_t spb = static_cast<int64_t>(std::llround(click.samplesPerBeat()));
    const float weak = peakAbsInWindow(click, spb, 50);
    CHECK(peak > weak);
}
