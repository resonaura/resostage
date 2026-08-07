#include "doctest.h"

#include "audio/MixMath.h"

#include <cmath>

using namespace resostage;
using namespace resostage::mix_math;

TEST_CASE("isAudible: mute always wins") {
    CHECK_FALSE(isAudible(/*mute=*/true, /*solo=*/false, /*anySoloInGroup=*/false));
    // Muting a strip you also soloed still silences it -- solo selects among
    // the un-muted, it does not override an explicit mute.
    CHECK_FALSE(isAudible(/*mute=*/true, /*solo=*/true, /*anySoloInGroup=*/true));
}

TEST_CASE("isAudible: nothing soloed leaves every un-muted strip up") {
    CHECK(isAudible(/*mute=*/false, /*solo=*/false, /*anySoloInGroup=*/false));
}

TEST_CASE("isAudible: someone else's solo silences the rest of the group") {
    CHECK_FALSE(isAudible(/*mute=*/false, /*solo=*/false, /*anySoloInGroup=*/true));
    CHECK(isAudible(/*mute=*/false, /*solo=*/true, /*anySoloInGroup=*/true));
}

TEST_CASE("dbToGain: unity at 0 dB, exact silence at the floor") {
    CHECK(dbToGain(0.0) == doctest::Approx(1.0f));
    CHECK(dbToGain(-6.0) == doctest::Approx(0.5011872f).epsilon(1e-5));
    CHECK(dbToGain(6.0) == doctest::Approx(1.9952624f).epsilon(1e-5));
    // A fader at the bottom must be true zero, not a residual trickle.
    CHECK(dbToGain(-144.0) == 0.0f);
    CHECK(dbToGain(-1000.0) == 0.0f);
}

TEST_CASE("panGains: centre is unity on both sides") {
    float l = 0.0f, r = 0.0f;
    panGains(1.0f, 0.0f, l, r);
    CHECK(l == doctest::Approx(1.0f));
    CHECK(r == doctest::Approx(1.0f));
}

TEST_CASE("panGains: balance attenuates the far side, never boosts the near one") {
    float l = 0.0f, r = 0.0f;
    panGains(1.0f, 1.0f, l, r); // hard right
    CHECK(l == doctest::Approx(0.0f));
    CHECK(r == doctest::Approx(1.0f));

    panGains(1.0f, -1.0f, l, r); // hard left
    CHECK(l == doctest::Approx(1.0f));
    CHECK(r == doctest::Approx(0.0f));

    panGains(1.0f, 0.5f, l, r);
    CHECK(l == doctest::Approx(0.5f));
    CHECK(r == doctest::Approx(1.0f));
}

TEST_CASE("panGains: out-of-range pan is clamped, not wrapped") {
    float l = 0.0f, r = 0.0f;
    panGains(1.0f, 4.0f, l, r);
    CHECK(l == doctest::Approx(0.0f));
    CHECK(r == doctest::Approx(1.0f));
}

TEST_CASE("panGains: the fader scales both sides") {
    float l = 0.0f, r = 0.0f;
    panGains(0.25f, -0.5f, l, r);
    CHECK(l == doctest::Approx(0.25f));
    CHECK(r == doctest::Approx(0.125f));
}

TEST_CASE("monoSum averages, so a correlated pair keeps its level") {
    CHECK(monoSum(1.0f, 1.0f) == doctest::Approx(1.0f));
    CHECK(monoSum(0.4f, -0.2f) == doctest::Approx(0.1f));
    CHECK(monoSum(1.0f, -1.0f) == doctest::Approx(0.0f));
}
