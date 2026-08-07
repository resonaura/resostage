#include "doctest.h"

#include "../app/engine/RoutingMath.h"

#include <cmath>

using namespace resostage;

TEST_CASE("routing_math::placeIntoBus keeps stereo into a stereo bus") {
    // Stereo destination: untouched L/R with balanced pan (pan = 0).
    const auto p = routing_math::placeIntoBus(true, -1, 0.9f, -0.9f, 1.0f, 1.0f);
    CHECK(std::abs(p.ch0 - 0.9f) < 1e-6f);
    CHECK(std::abs(p.ch1 - (-0.9f)) < 1e-6f);
}

TEST_CASE("routing_math::placeIntoBus places L into the first mono lane") {
    const auto p = routing_math::placeIntoBus(false, 0, 0.5f, -0.5f, 1.0f, 1.0f);
    CHECK(std::abs(p.ch0 - 0.5f) < 1e-6f); // only L
    CHECK(p.ch1 == 0.0f);
}

TEST_CASE("routing_math::placeIntoBus places R into the second mono lane") {
    const auto p = routing_math::placeIntoBus(false, 1, 0.5f, -0.5f, 1.0f, 1.0f);
    CHECK(std::abs(p.ch0 - (-0.5f)) < 1e-6f); // only R
    CHECK(p.ch1 == 0.0f);
}

TEST_CASE("routing_math::placeIntoBus sums L+R into a single mono lane") {
    const auto p = routing_math::placeIntoBus(false, -1, 0.4f, -0.2f, 1.0f, 1.0f);
    CHECK(std::abs(p.ch0 - 0.1f) < 1e-6f); // 0.5*(0.4 + -0.2)
}

TEST_CASE("routing_math::clickSendTargets applies the click master gain") {
    // Regression: send gain alone was used, ignoring the click's own volume.
    float tl = 0.f, tr = 0.f;
    routing_math::clickSendTargets(false, 0.5f, 0.25f, 0.0f, tl, tr);
    CHECK(std::abs(tl - 0.125f) < 1e-6f); // 0.5 * 0.25
    CHECK(std::abs(tr - 0.125f) < 1e-6f);
    // Mono click forces equal sides regardless of pan.
    routing_math::clickSendTargets(true, 1.0f, 2.0f, 0.9f, tl, tr);
    CHECK(std::abs(tl - 2.0f) < 1e-6f);
    CHECK(std::abs(tr - 2.0f) < 1e-6f);
    // Stereo click pans correctly (balance law: pan right attenuates L, R stays 1×).
    routing_math::clickSendTargets(false, 1.0f, 1.0f, 0.5f, tl, tr);
    CHECK(std::abs(tl - 0.5f) < 1e-6f);
    CHECK(std::abs(tr - 1.0f) < 1e-6f);
}

TEST_CASE("routing_math::egressChannels mono bus -> ONE physical channel") {
    int c0 = -1, c1 = 0;
    routing_math::egressChannels(1, 10, c0, c1);
    CHECK(c0 == 10);
    CHECK(c1 == -1); // no pair overlap
}

TEST_CASE("routing_math::egressChannels stereo bus -> contiguous pair") {
    int c0 = -1, c1 = 0;
    routing_math::egressChannels(2, 12, c0, c1);
    CHECK(c0 == 12);
    CHECK(c1 == 13);
}

TEST_CASE("routing_math::isChannelAudible respects mute and solo group") {
    CHECK(routing_math::isChannelAudible(false, false, false) == true);
    CHECK(routing_math::isChannelAudible(true, false, false) == false);  // muted
    CHECK(routing_math::isChannelAudible(false, false, true) == false);  // dimmed by solo
    CHECK(routing_math::isChannelAudible(false, true, true) == true);    // solo active
}

TEST_CASE("routing_math::calculateMeterFrame calculates post-fader peak") {
    const float inL[4] = { 0.8f, 0.8f, 0.8f, 0.8f };
    const float inR[4] = { 0.4f, 0.4f, 0.4f, 0.4f };
    float outL[4] = { 0 };
    float outR[4] = { 0 };
    float peakL = 0.0f, peakR = 0.0f;

    routing_math::calculateMeterFrame(inL, inR, 4, 0.5f, 0.0f, 2, outL, outR, peakL, peakR);
    CHECK(peakL == doctest::Approx(0.4f)); // 0.8 * 0.5
    CHECK(peakR == doctest::Approx(0.2f)); // 0.4 * 0.5
}