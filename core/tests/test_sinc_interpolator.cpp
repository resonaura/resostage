// Varispeed quality, measured rather than described.
//
// Linear interpolation does not fail loudly. It rolls off the top end and
// folds images back as a quiet metallic edge, which on a busy mix is easy to
// mistake for the material. So these tests do not ask "does it sound right" --
// they resample known sine waves and measure how much of the output is not the
// tone that went in.

#include "doctest.h"

#include "audio/SincInterpolator.h"

#include <cmath>
#include <vector>

using namespace resostage;

namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<float> sineTable(int frames, double cyclesPerSample, double amplitude = 1.0) {
    std::vector<float> v(static_cast<size_t>(frames));
    for (int i = 0; i < frames; ++i)
        v[static_cast<size_t>(i)] =
            static_cast<float>(amplitude * std::sin(2.0 * kPi * cyclesPerSample * i));
    return v;
}

/** Linear interpolation -- the thing being replaced, for a like-for-like read. */
float linearSample(const std::vector<float>& src, double pos) {
    const int64_t i0 = static_cast<int64_t>(std::floor(pos));
    const double frac = pos - static_cast<double>(i0);
    const auto at = [&](int64_t i) {
        return (i >= 0 && i < static_cast<int64_t>(src.size()))
                   ? static_cast<double>(src[static_cast<size_t>(i)])
                   : 0.0;
    };
    return static_cast<float>(at(i0) + (at(i0 + 1) - at(i0)) * frac);
}

/**
 * Energy at `cyclesPerSample` relative to total energy, over a window well
 * inside the signal so kernel edge effects are not what is being measured.
 */
double toneFraction(const std::vector<float>& sig, double cyclesPerSample, int from, int count) {
    double re = 0.0;
    double im = 0.0;
    double total = 0.0;
    for (int i = 0; i < count; ++i) {
        const double v = sig[static_cast<size_t>(from + i)];
        const double a = 2.0 * kPi * cyclesPerSample * i;
        re += v * std::cos(a);
        im += v * std::sin(a);
        total += v * v;
    }
    if (total <= 0.0)
        return 0.0;
    const double toneEnergy = 2.0 * (re * re + im * im) / static_cast<double>(count);
    return toneEnergy / total;
}

/** Resample `src` at `speed`, sinc or linear, into `count` output samples. */
std::vector<float> resample(const std::vector<float>& src, double speed, int count,
                            const SincTable* table) {
    std::vector<float> out(static_cast<size_t>(count));
    for (int i = 0; i < count; ++i) {
        const double pos = static_cast<double>(i) * speed;
        out[static_cast<size_t>(i)] =
            table != nullptr
                ? sincSample(*table, src.data(), static_cast<int64_t>(src.size()), pos)
                : linearSample(src, pos);
    }
    return out;
}

} // namespace

TEST_CASE("sinc: a table is built for the ratio it was asked for") {
    SincTable t;
    CHECK_FALSE(t.isBuilt());
    t.build(1.5);
    CHECK(t.isBuilt());
    CHECK(t.ratio() == doctest::Approx(1.5));
    CHECK(SincTable::taps() == 2 * kSincHalfTaps);
}

TEST_CASE("sinc: every phase has unity gain, so a steady level stays steady") {
    // A kernel whose gain ripples with phase turns a sustained note into a
    // slow tremolo -- the artefact hardest to attribute to the interpolator,
    // because it sounds like an effect rather than a fault.
    SincTable t;
    t.build(1.0);
    for (int p = 0; p <= kSincPhases; p += 7) {
        const double phase = static_cast<double>(p) / static_cast<double>(kSincPhases);
        const float* w = t.weightsForPhase(phase);
        REQUIRE(w != nullptr);
        double sum = 0.0;
        for (int i = 0; i < SincTable::taps(); ++i)
            sum += w[i];
        CHECK(sum == doctest::Approx(1.0).epsilon(1e-5));
    }
}

TEST_CASE("sinc: reading at integer positions returns the sample itself") {
    SincTable t;
    t.build(1.0);
    const auto src = sineTable(512, 0.031);
    for (int i = 64; i < 448; i += 37) {
        CHECK(sincSample(t, src.data(), 512, static_cast<double>(i))
              == doctest::Approx(src[static_cast<size_t>(i)]).epsilon(1e-4));
    }
}

TEST_CASE("sinc: a high tone survives resampling that linear interpolation dulls") {
    // 0.3 cycles/sample is well up the top octave -- a cymbal, a consonant, the
    // air on an acoustic guitar. Read at a fractional offset, linear loses
    // several dB of it. This is the roll-off, not the aliasing.
    const auto src = sineTable(4096, 0.3);
    SincTable t;
    t.build(1.0);

    double sincPeak = 0.0;
    double linearPeak = 0.0;
    for (int i = 64; i < 4000; ++i) {
        const double pos = static_cast<double>(i) + 0.5; // worst-case phase
        sincPeak = std::max(sincPeak,
                            std::abs(static_cast<double>(
                                sincSample(t, src.data(), 4096, pos))));
        linearPeak = std::max(linearPeak, std::abs(static_cast<double>(linearSample(src, pos))));
    }

    // Linear at half-sample phase is a two-point average: at 0.3 cyc/sample it
    // costs about 4 dB. The sinc kernel keeps essentially all of it.
    CHECK(sincPeak > 0.97);
    CHECK(linearPeak < 0.85);
    CHECK(sincPeak > linearPeak);
}

TEST_CASE("sinc: speeding up rejects the images that linear folds back") {
    // The one that matters for varispeed. At 1.5x a tone at 0.3 cyc/sample
    // lands at 0.45 -- just under Nyquist -- and everything the source had
    // above 0.333 folds. A band-limiting kernel removes it first; linear
    // does not, and the fold lands in the audible band as a metallic tone.
    const double speed = 1.5;
    const double inputFreq = 0.3;
    const auto src = sineTable(8192, inputFreq);

    SincTable t;
    t.build(speed);

    const int count = 4096;
    const auto viaSinc = resample(src, speed, count, &t);
    const auto viaLinear = resample(src, speed, count, nullptr);

    // Where the tone should be in the output.
    const double outFreq = inputFreq * speed;
    const double sincPurity = toneFraction(viaSinc, outFreq, 512, 2048);
    const double linearPurity = toneFraction(viaLinear, outFreq, 512, 2048);

    // Nearly all of the sinc output is the tone; anything else is artefact.
    CHECK(sincPurity > 0.98);
    CHECK(sincPurity > linearPurity);
}

TEST_CASE("sinc: slowing down keeps the full top end") {
    // Below 1x there are no images to reject, so the kernel must NOT be
    // narrowed -- doing that would trade away real high frequency content for
    // filtering that nothing needs.
    SincTable slow;
    slow.build(0.5);
    SincTable unity;
    unity.build(1.0);

    const auto src = sineTable(4096, 0.35);
    double slowPeak = 0.0;
    for (int i = 64; i < 2000; ++i) {
        const double pos = static_cast<double>(i) * 0.5;
        slowPeak = std::max(slowPeak,
                            std::abs(static_cast<double>(
                                sincSample(slow, src.data(), 4096, pos))));
    }
    CHECK(slowPeak > 0.97);
    // A ratio at or below 1 leaves the kernel alone, so the two tables agree.
    for (int i = 0; i < SincTable::taps(); ++i) {
        CHECK(slow.weightsForPhase(0.5)[i]
              == doctest::Approx(unity.weightsForPhase(0.5)[i]).epsilon(1e-6));
    }
}

TEST_CASE("sinc: outside the source is silence, not a read past the end") {
    SincTable t;
    t.build(1.0);
    const auto src = sineTable(256, 0.1);

    // Deep before and deep after: every tap is out of range.
    CHECK(sincSample(t, src.data(), 256, -100.0) == doctest::Approx(0.0f));
    CHECK(sincSample(t, src.data(), 256, 400.0) == doctest::Approx(0.0f));
    // Right at the edges the kernel is partly outside; the result must be
    // finite and small, never a wild value from uninitialised memory.
    CHECK(std::isfinite(sincSample(t, src.data(), 256, 0.5)));
    CHECK(std::isfinite(sincSample(t, src.data(), 256, 255.5)));
    // Degenerate inputs are answered, not crashed on.
    CHECK(sincSample(t, nullptr, 256, 10.0) == doctest::Approx(0.0f));
    CHECK(sincSample(t, src.data(), 0, 10.0) == doctest::Approx(0.0f));
    CHECK(sincSample(t, src.data(), 256, std::nan("")) == doctest::Approx(0.0f));
}

TEST_CASE("sinc: a loop seam is continuous, not a dip every cycle") {
    // The non-looping kernel reads silence past the end, so the last sixteen
    // samples of every loop cycle fade and the first sixteen ramp back -- a
    // click, once per cycle, forever.
    SincTable t;
    t.build(1.0);
    // A whole number of cycles, so the loop point is a genuine continuation.
    const int length = 480;
    const auto src = sineTable(length, 8.0 / static_cast<double>(length));

    double worstLooped = 0.0;
    double worstPlain = 0.0;
    for (int i = -8; i < 8; ++i) {
        const double pos = static_cast<double>(length + i) + 0.5;
        const double wrapped = std::fmod(pos, static_cast<double>(length));
        const double expected = std::sin(2.0 * kPi * 8.0 * wrapped / static_cast<double>(length));
        worstLooped = std::max(
            worstLooped,
            std::abs(static_cast<double>(sincSampleLooped(t, src.data(), length, wrapped))
                     - expected));
        worstPlain = std::max(
            worstPlain,
            std::abs(static_cast<double>(sincSample(t, src.data(), length, wrapped)) - expected));
    }

    CHECK(worstLooped < 0.01);
    // ...and the non-wrapping one is visibly worse right at the seam, which is
    // exactly why the loop path needs its own.
    CHECK(worstPlain > worstLooped);
}

TEST_CASE("sinc ladder: a speed picks a kernel at or above it, never below") {
    // Below would leave images unrejected, which is the artefact the kernel
    // exists to remove -- so the rounding direction is not a detail.
    SincTableSet set;
    CHECK_FALSE(set.isBuilt());
    set.build();
    CHECK(set.isBuilt());

    for (const double speed : {0.25, 0.5, 0.99, 1.0, 1.01, 1.3, 1.6, 2.2, 3.9, 4.0}) {
        const SincTable& t = set.forSpeed(speed);
        CHECK(t.isBuilt());
        CHECK(t.ratio() >= speed);
    }

    // Anything at or below 1x shares the unity kernel, keeping the full top
    // end on a slowed-down region.
    CHECK(set.forSpeed(0.25).ratio() == doctest::Approx(1.0));
    CHECK(set.forSpeed(1.0).ratio() == doctest::Approx(1.0));
    // ...and past the top of the range it degrades to the widest kernel rather
    // than reading off the end.
    CHECK(set.forSpeed(99.0).isBuilt());
}
