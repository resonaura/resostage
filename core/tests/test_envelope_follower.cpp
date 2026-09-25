#include "doctest.h"

#include "audio/EnvelopeFollower.h"
#include <cmath>
#include <vector>

using namespace resostage;

TEST_SUITE("EnvelopeFollower") {

TEST_CASE("Step response and attack ballistics") {
    constexpr double kRate = 48000.0;
    constexpr double kAttackMs = 10.0;
    constexpr double kReleaseMs = 100.0;

    EnvelopeFollower follower(kRate, kAttackMs, kReleaseMs, EnvelopeDetectorMode::Peak);
    CHECK(follower.getCurrentValue() == doctest::Approx(0.0f));

    // Feed a constant 1.0 signal for 10ms (480 samples)
    const int attackSamples = static_cast<int>(kRate * (kAttackMs / 1000.0));
    std::vector<float> input(attackSamples, 1.0f);
    std::vector<float> output(attackSamples, 0.0f);

    follower.process(input.data(), output.data(), attackSamples);

    // After 1 time constant (10ms), an exponential approach reaches 1 - 1/e ≈ 0.6321
    const float valAtTimeConstant = output.back();
    CHECK(valAtTimeConstant == doctest::Approx(1.0f - (1.0f / std::exp(1.0f))).epsilon(0.02f));
    CHECK(valAtTimeConstant > 0.60f);
    CHECK(valAtTimeConstant < 0.66f);
}

TEST_CASE("Release decay ballistics") {
    constexpr double kRate = 48000.0;
    constexpr double kAttackMs = 1.0;
    constexpr double kReleaseMs = 50.0;

    EnvelopeFollower follower(kRate, kAttackMs, kReleaseMs, EnvelopeDetectorMode::Peak);

    // Initialize follower to 1.0
    follower.reset(1.0f);
    CHECK(follower.getCurrentValue() == doctest::Approx(1.0f));

    // Feed silence for 50ms (release time constant)
    const int releaseSamples = static_cast<int>(kRate * (kReleaseMs / 1000.0));
    std::vector<float> input(releaseSamples, 0.0f);
    std::vector<float> output(releaseSamples, 0.0f);

    follower.process(input.data(), output.data(), releaseSamples);

    // After 1 release time constant, level should drop to 1/e ≈ 0.3678
    const float valAtRelease = output.back();
    CHECK(valAtRelease == doctest::Approx(1.0f / std::exp(1.0f)).epsilon(0.02f));
}

TEST_CASE("Stereo tracking takes maximum of left and right") {
    EnvelopeFollower follower(48000.0, 5.0, 50.0, EnvelopeDetectorMode::Peak);

    constexpr int kSamples = 512;
    std::vector<float> left(kSamples, 0.2f);
    std::vector<float> right(kSamples, 0.8f);
    std::vector<float> output(kSamples, 0.0f);

    follower.processStereo(left.data(), right.data(), output.data(), kSamples);

    // Output envelope should respond to the louder channel (0.8f)
    CHECK(output.back() > 0.5f);
    CHECK(output.back() <= 0.8f);
}

TEST_CASE("Denormal flush during extended silence") {
    EnvelopeFollower follower(48000.0, 1.0, 10.0, EnvelopeDetectorMode::Peak);
    follower.reset(1.0f);

    // Feed 1 second of silence (well past decay threshold)
    constexpr int kSamples = 48000;
    std::vector<float> silence(kSamples, 0.0f);
    std::vector<float> output(kSamples, 0.0f);

    follower.process(silence.data(), output.data(), kSamples);

    // Must be flushed to exact 0.0f, avoiding denormal CPU penalties
    CHECK(follower.getCurrentValue() == 0.0f);
}

} // TEST_SUITE
