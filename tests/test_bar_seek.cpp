#include "doctest.h"

#include "timing/BarSeek.h"

using namespace resostage;

TEST_CASE("barLengthSeconds computes wall-clock bar length from bpm and numerator") {
    CHECK(barLengthSeconds(120.0, 4) == doctest::Approx(2.0));
    CHECK(barLengthSeconds(60.0, 3) == doctest::Approx(3.0));
    CHECK(barLengthSeconds(140.0, 7) == doctest::Approx((60.0 / 140.0) * 7.0));
    // Denominator doesn't factor in -- bpm is quarter-notes-per-minute
    // regardless of notated meter, matching SongDef::bpm's own convention.
}

TEST_CASE("barLengthSeconds falls back to sane defaults for invalid input") {
    CHECK(barLengthSeconds(0.0, 4) == doctest::Approx(2.0));
    CHECK(barLengthSeconds(-10.0, 4) == doctest::Approx(2.0));
    CHECK(barLengthSeconds(120.0, 0) == doctest::Approx(2.0));
    CHECK(barLengthSeconds(120.0, -3) == doctest::Approx(2.0));
}

TEST_CASE("barSeekTargetSeconds: previous-bar mid-bar snaps to current bar start") {
    // 120bpm 4/4 -> 2s/bar. 4.5s is mid-way through bar index 2 (starts 4.0s).
    CHECK(barSeekTargetSeconds(4.5, 120.0, 4, -1) == doctest::Approx(4.0));
}

TEST_CASE("barSeekTargetSeconds: previous-bar exactly on a boundary steps back one more bar") {
    CHECK(barSeekTargetSeconds(4.0, 120.0, 4, -1) == doctest::Approx(2.0));
}

TEST_CASE("barSeekTargetSeconds: previous-bar near time zero clamps at zero") {
    CHECK(barSeekTargetSeconds(0.0, 120.0, 4, -1) == doctest::Approx(0.0));
    CHECK(barSeekTargetSeconds(0.4, 120.0, 4, -1) == doctest::Approx(0.0));
}

TEST_CASE("barSeekTargetSeconds: next-bar always advances to the next boundary ahead") {
    CHECK(barSeekTargetSeconds(0.0, 120.0, 4, +1) == doctest::Approx(2.0));
    CHECK(barSeekTargetSeconds(0.4, 120.0, 4, +1) == doctest::Approx(2.0));
    CHECK(barSeekTargetSeconds(3.999, 120.0, 4, +1) == doctest::Approx(4.0));
}

TEST_CASE("barSeekTargetSeconds: odd time signatures and fractional bpm") {
    // 128.3bpm, 7/8 numerator=7 -> bar = 60/128.3*7 seconds.
    const double barSec = barLengthSeconds(128.3, 7);
    CHECK(barSeekTargetSeconds(barSec * 2.5, 128.3, 7, -1) == doctest::Approx(barSec * 2.0));
    CHECK(barSeekTargetSeconds(barSec * 2.5, 128.3, 7, +1) == doctest::Approx(barSec * 3.0));

    // 3/4 at 90bpm -> 2s/bar.
    CHECK(barSeekTargetSeconds(5.0, 90.0, 3, -1) == doctest::Approx(4.0));
    CHECK(barSeekTargetSeconds(5.0, 90.0, 3, +1) == doctest::Approx(6.0));
}
