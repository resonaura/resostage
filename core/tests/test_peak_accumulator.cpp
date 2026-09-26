#include "doctest.h"
#include "audio/AudioRecordWorker.h"

#include <vector>

using namespace resostage;

TEST_SUITE("PeakMipAccumulator") {
    TEST_CASE("Hierarchical peak propagation across mip levels") {
        PeakMipAccumulator accum;
        std::vector<PeakPair16> emitted[kMaxPeakLevels];

        auto emit = [&](size_t level, PeakPair16 p) {
            REQUIRE(level < kMaxPeakLevels);
            emitted[level].push_back(p);
        };

        // Push 8 level-0 peaks
        // Pair 0: (-100, 150)
        // Pair 1: (-50, 200)   -> L1 merged: (-100, 200)
        // Pair 2: (-300, 50)
        // Pair 3: (-20, 100)   -> L1 merged: (-300, 100) -> L2 merged: (-300, 200)
        // Pair 4: (-10, 80)
        // Pair 5: (-70, 90)    -> L1 merged: (-70, 90)
        // Pair 6: (-400, 500)
        // Pair 7: (-100, 250)  -> L1 merged: (-400, 500) -> L2 merged: (-400, 500) -> L3 merged: (-400, 500)

        accum.pushLevel0(PeakPair16{-100, 150}, emit);
        accum.pushLevel0(PeakPair16{-50, 200}, emit);
        accum.pushLevel0(PeakPair16{-300, 50}, emit);
        accum.pushLevel0(PeakPair16{-20, 100}, emit);
        accum.pushLevel0(PeakPair16{-10, 80}, emit);
        accum.pushLevel0(PeakPair16{-70, 90}, emit);
        accum.pushLevel0(PeakPair16{-400, 500}, emit);
        accum.pushLevel0(PeakPair16{-100, 250}, emit);

        CHECK(emitted[0].size() == 8);
        CHECK(emitted[1].size() == 4);
        CHECK(emitted[2].size() == 2);
        CHECK(emitted[3].size() == 1);

        // Verify L1 merged pairs
        CHECK(emitted[1][0].min == -100);
        CHECK(emitted[1][0].max == 200);

        CHECK(emitted[1][1].min == -300);
        CHECK(emitted[1][1].max == 100);

        // Verify L2 merged pairs
        CHECK(emitted[2][0].min == -300);
        CHECK(emitted[2][0].max == 200);

        CHECK(emitted[2][1].min == -400);
        CHECK(emitted[2][1].max == 500);

        // Verify L3 merged pair
        CHECK(emitted[3][0].min == -400);
        CHECK(emitted[3][0].max == 500);
    }

    TEST_CASE("LivePeakPyramid range slice query") {
        LivePeakPyramid pyramid;
        for (int i = 0; i < 100; ++i) {
            pyramid.addPeak(0, PeakPair16{static_cast<int16_t>(-i * 10), static_cast<int16_t>(i * 10)});
        }

        CHECK(pyramid.size(0) == 100);
        CHECK(pyramid.countLevel0.load() == 100);

        // Query middle chunk
        auto chunk = pyramid.getPeaks(0, 10, 5);
        REQUIRE(chunk.size() == 5);
        CHECK(chunk[0].min == -100);
        CHECK(chunk[0].max == 100);
        CHECK(chunk[4].min == -140);
        CHECK(chunk[4].max == 140);

        // Query beyond end
        auto emptyChunk = pyramid.getPeaks(0, 150, 10);
        CHECK(emptyChunk.empty());
    }
}
