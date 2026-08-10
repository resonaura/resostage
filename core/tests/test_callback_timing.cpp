// Telling "we did too much" apart from "we were not scheduled".
//
// This is the measurement that was missing when a loaded machine broke up
// while reporting zero underruns and low CPU. Averages could not show it and
// the driver's own counters could not see it, so the classification rule is
// written down here as propositions instead of living implicitly in a
// callback nobody can attach a debugger to at a gig.

#include "doctest.h"

#include "telemetry/CallbackTiming.h"

using namespace resostage;

namespace {
/** 512 frames at 48 kHz: the budget one callback has. */
constexpr double kDeadline = 512.0 / 48.0; // ~10.67 ms
} // namespace

TEST_CASE("callback timing: a comfortable callback is not a stall") {
    CHECK(classifyCallback(1.0, 0.9, kDeadline) == CallbackStall::None);
    CHECK(classifyCallback(kDeadline * 0.5, kDeadline * 0.5, kDeadline) == CallbackStall::None);
    // Right up to the threshold, still fine.
    CHECK(classifyCallback(kDeadline * 0.74, kDeadline * 0.7, kDeadline) == CallbackStall::None);
}

TEST_CASE("callback timing: burning the deadline on a core is a compute stall") {
    // Wall and CPU nearly equal: the thread was running the whole time. Too
    // many stems, too much DSP, or a clock that has been throttled down --
    // all of which are ours to fix.
    CHECK(classifyCallback(kDeadline * 0.95, kDeadline * 0.93, kDeadline)
          == CallbackStall::Compute);
    CHECK(classifyCallback(kDeadline * 1.4, kDeadline * 1.35, kDeadline)
          == CallbackStall::Compute);
}

TEST_CASE("callback timing: a callback that barely ran was preempted, not busy") {
    // The case that reads as "low CPU and audio breaking up anyway". Four
    // milliseconds of wall time, a third of a millisecond of it running: this
    // block was waiting on a lock, on the disk, or for a core.
    CHECK(classifyCallback(kDeadline * 1.2, 0.3, kDeadline) == CallbackStall::Preempted);
    CHECK(classifyCallback(kDeadline * 0.8, kDeadline * 0.1, kDeadline)
          == CallbackStall::Preempted);
}

TEST_CASE("callback timing: an unknown CPU clock does not fabricate a preemption") {
    // A platform that cannot report thread CPU time returns 0. Calling that
    // "preempted" would blame the scheduler on every slow callback for the
    // whole of that platform's life.
    CHECK(classifyCallback(kDeadline * 1.5, 0.0, kDeadline) == CallbackStall::Compute);
}

TEST_CASE("callback timing: nonsense inputs are answered, not classified") {
    CHECK(classifyCallback(5.0, 1.0, 0.0) == CallbackStall::None);
    CHECK(classifyCallback(5.0, 1.0, -1.0) == CallbackStall::None);
    CHECK(classifyCallback(0.0, 0.0, kDeadline) == CallbackStall::None);
}

TEST_CASE("callback timing: buckets get finer as they approach the deadline") {
    // An average is worthless for this: a rig at 70% forever sounds perfect
    // and a rig that touches 105% twice an hour sounds broken. Only the shape
    // of the tail is worth keeping.
    CHECK(callbackBucketFor(kDeadline * 0.1, kDeadline) == CallbackBucket::UpTo25);
    CHECK(callbackBucketFor(kDeadline * 0.4, kDeadline) == CallbackBucket::UpTo50);
    CHECK(callbackBucketFor(kDeadline * 0.6, kDeadline) == CallbackBucket::UpTo75);
    CHECK(callbackBucketFor(kDeadline * 0.85, kDeadline) == CallbackBucket::UpTo90);
    CHECK(callbackBucketFor(kDeadline * 0.97, kDeadline) == CallbackBucket::UpTo100);
    CHECK(callbackBucketFor(kDeadline * 1.01, kDeadline) == CallbackBucket::Over100);
    // Boundaries land on the lower bucket, so a callback exactly on its
    // deadline is not yet counted as an overrun.
    CHECK(callbackBucketFor(kDeadline, kDeadline) == CallbackBucket::UpTo100);
}

TEST_CASE("callback timing: the histogram keeps the tail and the reason") {
    CallbackTimingHistogram h;

    // A normal run: a thousand comfortable callbacks...
    for (int i = 0; i < 1000; ++i)
        h.record(kDeadline * 0.3, kDeadline * 0.28, kDeadline);
    // ...one that overran because it was starved...
    h.record(kDeadline * 1.6, 0.4, kDeadline);
    // ...and one that overran because it was working.
    h.record(kDeadline * 1.1, kDeadline * 1.05, kDeadline);

    const auto s = h.snapshot();
    CHECK(s.total == 1002);
    CHECK(s.buckets[static_cast<size_t>(CallbackBucket::UpTo25)] == 0);
    CHECK(s.buckets[static_cast<size_t>(CallbackBucket::UpTo50)] == 1000);
    CHECK(s.buckets[static_cast<size_t>(CallbackBucket::Over100)] == 2);
    CHECK(s.preemptedStalls == 1);
    CHECK(s.computeStalls == 1);

    // The worst case is kept in full, because that is the one that was
    // audible -- and it is the starved one, not the busy one.
    CHECK(s.worstRatio == doctest::Approx(1.6));
    CHECK(s.worstWallMs == doctest::Approx(kDeadline * 1.6));
    CHECK(s.worstCpuShare < 0.5);
}

TEST_CASE("callback timing: a thousand good callbacks do not hide one bad one") {
    // The failure mode of every average-based metric: 99.9% healthy reads as
    // healthy. Here the tail bucket is still exactly 1.
    CallbackTimingHistogram h;
    for (int i = 0; i < 100000; ++i)
        h.record(kDeadline * 0.2, kDeadline * 0.19, kDeadline);
    h.record(kDeadline * 2.0, 0.1, kDeadline);

    const auto s = h.snapshot();
    CHECK(s.buckets[static_cast<size_t>(CallbackBucket::Over100)] == 1);
    CHECK(s.worstRatio == doctest::Approx(2.0));
    CHECK(s.preemptedStalls == 1);
}

TEST_CASE("callback timing: reset starts a clean window") {
    // For deliberate boundaries -- a new project, a device change -- where
    // carrying the previous rig's worst case forward would be a lie.
    CallbackTimingHistogram h;
    h.record(kDeadline * 1.9, 0.2, kDeadline);
    REQUIRE(h.snapshot().worstRatio > 1.0);

    h.reset();
    const auto s = h.snapshot();
    CHECK(s.total == 0);
    CHECK(s.worstRatio == doctest::Approx(0.0));
    CHECK(s.preemptedStalls == 0);
    CHECK(s.computeStalls == 0);
    for (size_t i = 0; i < kCallbackBucketCount; ++i)
        CHECK(s.buckets[i] == 0);
}

TEST_CASE("callback timing: the deadline scales with the buffer, so the ratio is comparable") {
    // 512 frames and 4096 frames have very different budgets. Recording the
    // ratio rather than the duration is what lets one number mean the same
    // thing at both -- which is the only way "is this rig healthy" survives a
    // buffer-size change.
    CallbackTimingHistogram small;
    CallbackTimingHistogram big;
    const double smallDeadline = 512.0 / 48.0;
    const double bigDeadline = 4096.0 / 48.0;

    small.record(smallDeadline * 0.6, smallDeadline * 0.55, smallDeadline);
    big.record(bigDeadline * 0.6, bigDeadline * 0.55, bigDeadline);

    CHECK(small.snapshot().worstRatio == doctest::Approx(big.snapshot().worstRatio));
    CHECK(small.snapshot().buckets[static_cast<size_t>(CallbackBucket::UpTo75)]
          == big.snapshot().buckets[static_cast<size_t>(CallbackBucket::UpTo75)]);
}
