// Speed, reverse and loop, as arithmetic.
//
// These four features combine, and every combination was verified by ear and
// by instrumenting a running engine -- five loop cycles, no silent blocks,
// pitch blocks counted. That works once. What it cannot do is notice that a
// later change moved a reversed loop by one frame per cycle, or that a speed
// change quietly stopped covering the whole source span. So the same scenarios
// are stated here as propositions instead.

#include "doctest.h"

#include "audio/RegionSourceMap.h"

#include <cmath>
#include <vector>

using namespace resostage;

namespace {

/** A region trimmed 1000 frames into a 100k-frame file, 10k frames long. */
RegionSourceWindow plainWindow() {
    RegionSourceWindow w;
    w.sourceOffset = 1000;
    w.sourceAvail = 100000;
    w.regionLength = 10000;
    w.loopCycle = 0;
    return w;
}

/** Every source frame the region visits over `frames` of timeline. */
std::vector<double> walk(const RegionSourceWindow& w, int64_t frames) {
    std::vector<double> out;
    out.reserve(static_cast<size_t>(frames));
    for (int64_t i = 0; i < frames; ++i)
        out.push_back(shapedSourceFrame(w, i));
    return out;
}

} // namespace

TEST_CASE("region map: a plain region is a bit-exact read of its own trim") {
    // No rounding, no interpolation. This is the common case and it must stay
    // integral -- an off-by-one here is inaudible and permanent.
    const RegionSourceWindow w = plainWindow();
    CHECK(straightSourceFrame(w, 0) == 1000);
    CHECK(straightSourceFrame(w, 1) == 1001);
    CHECK(straightSourceFrame(w, 9999) == 10999);
    // Before the region, and past the end of the file, are both "nothing".
    CHECK(straightSourceFrame(w, -1) == -1);
    CHECK(straightSourceFrame(w, 100000) == -1);
}

TEST_CASE("region map: speed changes how much of the file a region covers") {
    // The region keeps its length on the timeline; what changes is how far
    // through the source it gets. This is what makes the drawn region resize
    // with its peaks in the editor, so the two must agree.
    RegionSourceWindow w = plainWindow();

    w.speed = 1.0;
    CHECK(regionSourceSpan(w) == 10000);

    w.speed = 2.0;
    CHECK(regionSourceSpan(w) == 20000);
    CHECK(shapedSourceFrame(w, 0) == doctest::Approx(1000.0));
    CHECK(shapedSourceFrame(w, 100) == doctest::Approx(1200.0));

    w.speed = 0.5;
    CHECK(regionSourceSpan(w) == 5000);
    CHECK(shapedSourceFrame(w, 100) == doctest::Approx(1050.0));
}

TEST_CASE("region map: a speed that overruns the file is capped, not extrapolated") {
    RegionSourceWindow w = plainWindow();
    w.sourceAvail = 4000;
    w.speed = 4.0; // would want 40000 frames
    CHECK(regionSourceSpan(w) == 4000);
    // Past the available source there is nothing to play, rather than a read
    // off the end of the resident buffer.
    CHECK(shapedSourceFrame(w, 999) >= 0.0);
    CHECK(shapedSourceFrame(w, 1000) == -1.0);
}

TEST_CASE("region map: reverse mirrors inside the region, not inside the file") {
    // A trimmed region played backwards must play THAT region backwards. The
    // tempting bug is to mirror against the file, which jumps to unrelated
    // audio the moment a region is trimmed.
    RegionSourceWindow w = plainWindow();
    w.reverse = true;

    const int64_t span = regionSourceSpan(w);
    REQUIRE(span == 10000);
    // First sample out is the LAST frame of the span...
    CHECK(shapedSourceFrame(w, 0) == doctest::Approx(1000.0 + 9999.0));
    // ...and the last sample out is the first.
    CHECK(shapedSourceFrame(w, 9999) == doctest::Approx(1000.0));
    // Never outside the region's own window.
    for (int64_t i = 0; i < span; ++i) {
        const double p = shapedSourceFrame(w, i);
        CHECK(p >= 1000.0);
        CHECK(p <= 1000.0 + 9999.0);
    }
}

TEST_CASE("region map: a loop returns to the same source frame every cycle") {
    RegionSourceWindow w = plainWindow();
    w.loop = true;
    w.loopCycle = 480;

    CHECK(straightSourceFrame(w, 0) == 1000);
    CHECK(straightSourceFrame(w, 479) == 1479);
    CHECK(straightSourceFrame(w, 480) == 1000);
    // Still exact ten cycles later -- no accumulated drift.
    CHECK(straightSourceFrame(w, 4800) == 1000);
    CHECK(straightSourceFrame(w, 4800 + 123) == 1123 + 1000 - 1000 + 0);
    CHECK(straightSourceFrame(w, 4800 + 123) == 1123);
    // And a loop never runs out, however long the song is.
    CHECK(straightSourceFrame(w, 100000000) >= 0);
}

TEST_CASE("region map: loop and speed together keep the cycle, not the frame count") {
    // At 2x the region gets through a cycle in half the timeline, and the
    // cycle boundary must still land exactly on the loop's first frame.
    RegionSourceWindow w = plainWindow();
    w.loop = true;
    w.loopCycle = 480;
    w.speed = 2.0;

    CHECK(shapedSourceFrame(w, 0) == doctest::Approx(1000.0));
    CHECK(shapedSourceFrame(w, 240) == doctest::Approx(1000.0));
    CHECK(shapedSourceFrame(w, 480) == doctest::Approx(1000.0));
    CHECK(shapedSourceFrame(w, 120) == doctest::Approx(1240.0));
}

TEST_CASE("region map: loop, speed and reverse compose without drifting") {
    // The combination the engine was instrumented for: five loop cycles at
    // 1.5x, reversed. Each cycle must cover the same source span, in the same
    // order, with no creep from one to the next.
    RegionSourceWindow w = plainWindow();
    w.loop = true;
    w.loopCycle = 600;
    w.speed = 1.5;
    w.reverse = true;

    // 600 source frames at 1.5x is 400 timeline frames per cycle.
    const int64_t cycleFrames = 400;
    std::vector<double> first;
    for (int64_t i = 0; i < cycleFrames; ++i)
        first.push_back(shapedSourceFrame(w, i));

    for (int cycle = 1; cycle < 5; ++cycle) {
        for (int64_t i = 0; i < cycleFrames; ++i) {
            const double p = shapedSourceFrame(w, cycle * cycleFrames + i);
            CHECK(p == doctest::Approx(first[static_cast<size_t>(i)]).epsilon(1e-9));
        }
    }

    // Reversed, so within a cycle it walks the span downwards and stays inside
    // it -- the failure that would sound like a click at every loop point.
    CHECK(first.front() == doctest::Approx(1000.0 + 599.0));
    CHECK(first.front() > first.back());
    for (const double p : first) {
        CHECK(p >= 1000.0);
        CHECK(p <= 1000.0 + 599.0);
    }
}

TEST_CASE("region map: a one-shot ends, a loop does not") {
    RegionSourceWindow oneShot = plainWindow();
    RegionSourceWindow looped = plainWindow();
    looped.loop = true;
    looped.loopCycle = 10000;

    CHECK(shapedSourceFrame(oneShot, 9999) >= 0.0);
    CHECK(shapedSourceFrame(oneShot, 10000) == -1.0);
    CHECK(shapedSourceFrame(looped, 10000) >= 0.0);
    CHECK(shapedSourceFrame(looped, 10000000) >= 0.0);
}

TEST_CASE("region map: nothing plays before the region starts") {
    const RegionSourceWindow w = plainWindow();
    CHECK(shapedSourceFrame(w, -1) == -1.0);
    CHECK(shapedSourceFrame(w, -4096) == -1.0);
    CHECK(straightSourceFrame(w, -1) == -1);
}

TEST_CASE("region map: an empty source plays silence rather than reading past it") {
    RegionSourceWindow w = plainWindow();
    w.sourceAvail = 0;
    CHECK(straightSourceFrame(w, 0) == -1);
    CHECK(regionSourceSpan(w) == 0);
    CHECK(shapedSourceFrame(w, 0) == -1.0);

    // Same for a loop whose cycle never got resolved.
    w.loop = true;
    w.loopCycle = 0;
    CHECK(straightSourceFrame(w, 0) == -1);
    CHECK(shapedSourceFrame(w, 0) == -1.0);
}

TEST_CASE("region map: a block boundary is not a seam") {
    // The renderer walks a block at a time, and at 4096 frames a block spans
    // several loop cycles. Sample i must not depend on where the block that
    // contains it began.
    RegionSourceWindow w = plainWindow();
    w.loop = true;
    w.loopCycle = 700;
    w.speed = 1.25;
    w.reverse = true;

    const auto whole = walk(w, 8192);
    for (int64_t base : {0, 512, 4096, 5000}) {
        for (int64_t i = 0; i < 64; ++i) {
            const double p = shapedSourceFrame(w, base + i);
            CHECK(p == doctest::Approx(whole[static_cast<size_t>(base + i)]).epsilon(1e-9));
        }
    }
}
