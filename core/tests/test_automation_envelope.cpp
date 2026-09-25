#include "doctest.h"

#include "audio/AutomationEnvelope.h"
#include <cmath>
#include <vector>

using namespace resostage;

TEST_SUITE("AutomationEnvelope") {

TEST_CASE("Empty envelope returns default value") {
    AutomationEnvelope env;
    CHECK(env.empty());
    CHECK(env.size() == 0);
    CHECK(env.evaluateAt(0.0, 0.5) == doctest::Approx(0.5));
    CHECK(env.evaluateAt(10.0, -1.0) == doctest::Approx(-1.0));

    std::vector<float> block(128, -999.0f);
    size_t cursor = 0;
    env.evaluateBlock(0.0, 48000.0, block.data(), static_cast<int>(block.size()), cursor, 0.75);
    for (float sample : block)
        CHECK(sample == doctest::Approx(0.75f));
}

TEST_CASE("Single point holds constant across all time") {
    AutomationEnvelope env;
    env.addPoint(5.0, 0.8, 0.0);
    CHECK_FALSE(env.empty());
    CHECK(env.size() == 1);

    CHECK(env.evaluateAt(0.0) == doctest::Approx(0.8));
    CHECK(env.evaluateAt(5.0) == doctest::Approx(0.8));
    CHECK(env.evaluateAt(100.0) == doctest::Approx(0.8));

    std::vector<float> block(256, 0.0f);
    size_t cursor = 0;
    env.evaluateBlock(4.0, 48000.0, block.data(), static_cast<int>(block.size()), cursor);
    for (float sample : block)
        CHECK(sample == doctest::Approx(0.8f));
}

TEST_CASE("Two points linear interpolation") {
    AutomationEnvelope env;
    env.addPoint(0.0, 0.0, 0.0);
    env.addPoint(2.0, 1.0, 0.0); // Linear from 0 to 1 over 2 seconds

    CHECK(env.evaluateAt(-1.0) == doctest::Approx(0.0));
    CHECK(env.evaluateAt(0.0) == doctest::Approx(0.0));
    CHECK(env.evaluateAt(0.5) == doctest::Approx(0.25));
    CHECK(env.evaluateAt(1.0) == doctest::Approx(0.5));
    CHECK(env.evaluateAt(1.5) == doctest::Approx(0.75));
    CHECK(env.evaluateAt(2.0) == doctest::Approx(1.0));
    CHECK(env.evaluateAt(3.0) == doctest::Approx(1.0));
}

TEST_CASE("Curvature interpolation matches shapedFadeGain formula") {
    // Ease-out (curve > 0): fast start, slow end
    // t=0.5 with curve=1.0: exp = 2^(-2) = 0.25 -> 0.5^0.25 ≈ 0.840896
    const double easeOut = AutomationEnvelope::interpolate(0.5, 0.0, 1.0, 1.0);
    CHECK(easeOut == doctest::Approx(std::pow(0.5, 0.25)));
    CHECK(easeOut > 0.5);

    // Ease-in (curve < 0): slow start, fast end
    // t=0.5 with curve=-1.0: exp = 2^2 = 4.0 -> 0.5^4 = 0.0625
    const double easeIn = AutomationEnvelope::interpolate(0.5, 0.0, 1.0, -1.0);
    CHECK(easeIn == doctest::Approx(std::pow(0.5, 4.0)));
    CHECK(easeIn < 0.5);

    // Flat endpoints
    CHECK(AutomationEnvelope::interpolate(0.0, 10.0, 20.0, 0.5) == doctest::Approx(10.0));
    CHECK(AutomationEnvelope::interpolate(1.0, 10.0, 20.0, 0.5) == doctest::Approx(20.0));
}

TEST_CASE("Out of order point insertion preserves time sorting") {
    AutomationEnvelope env;
    env.addPoint(3.0, 0.3);
    env.addPoint(1.0, 0.1);
    env.addPoint(2.0, 0.2);

    const auto& pts = env.getPoints();
    REQUIRE(pts.size() == 3);
    CHECK(pts[0].timeSeconds == doctest::Approx(1.0));
    CHECK(pts[1].timeSeconds == doctest::Approx(2.0));
    CHECK(pts[2].timeSeconds == doctest::Approx(3.0));

    // Updating existing point at same time
    env.addPoint(2.0, 0.99);
    REQUIRE(env.size() == 3);
    CHECK(env.getPoints()[1].value == doctest::Approx(0.99));
}

TEST_CASE("evaluateBlock matches evaluateAt sample by sample") {
    AutomationEnvelope env;
    env.addPoint(0.0, 0.0, 0.5);
    env.addPoint(0.1, 1.0, -0.5);
    env.addPoint(0.2, 0.2, 0.0);
    env.addPoint(0.3, 0.8, 1.0);

    constexpr double kRate = 48000.0;
    constexpr int kBlockSize = 512;
    std::vector<float> block(kBlockSize, 0.0f);
    size_t cursor = 0;

    for (int blockIdx = 0; blockIdx < 20; ++blockIdx) {
        const double blockTime = (blockIdx * kBlockSize) / kRate;
        env.evaluateBlock(blockTime, kRate, block.data(), kBlockSize, cursor);

        for (int i = 0; i < kBlockSize; ++i) {
            const double t = blockTime + (i / kRate);
            const double expected = env.evaluateAt(t);
            CHECK(block[static_cast<size_t>(i)] == doctest::Approx(static_cast<float>(expected)).epsilon(1.0e-5));
        }
    }
}

TEST_CASE("applyGainBlock multiplies stereo audio buffers") {
    AutomationEnvelope env;
    env.addPoint(0.0, 2.0);
    env.addPoint(1.0, 2.0); // Constant 2x gain

    constexpr int kSamples = 64;
    std::vector<float> left(kSamples, 0.5f);
    std::vector<float> right(kSamples, -0.25f);
    size_t cursor = 0;

    env.applyGainBlock(0.1, 48000.0, left.data(), right.data(), kSamples, cursor);

    for (int i = 0; i < kSamples; ++i) {
        CHECK(left[static_cast<size_t>(i)] == doctest::Approx(1.0f));
        CHECK(right[static_cast<size_t>(i)] == doctest::Approx(-0.5f));
    }
}

} // TEST_SUITE
