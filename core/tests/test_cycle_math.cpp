// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#include "doctest.h"

#include "timing/CycleMath.h"

using namespace resostage;

TEST_CASE("project cycle remains sample-exact after ten thousand device blocks") {
    constexpr int64_t left = 12'345;
    constexpr int64_t right = 193'777;
    constexpr int64_t block = 511;
    constexpr int iterations = 10'000;

    int64_t position = left;
    for (int i = 0; i < iterations; ++i)
        position = wrapCycleSample(position + block, left, right);

    const int64_t expected = left
        + ((static_cast<int64_t>(iterations) * block) % (right - left));
    CHECK(position == expected);
}

TEST_CASE("project cycle maps its exclusive right edge exactly to the left") {
    CHECK(wrapCycleSample(400, 100, 400) == 100);
    CHECK(wrapCycleSample(700, 100, 400) == 100);
    CHECK(wrapCycleSample(99, 100, 400) == 99);
}
