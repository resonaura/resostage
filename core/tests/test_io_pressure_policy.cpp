// Who gets the disk when there is not enough of it.
//
// The fault this governs is the one that reads as "the machine is fine and the
// audio is breaking up anyway": CPU low, driver reporting no underruns, and
// the render callback nonetheless handed a ring with nothing in it. It happens
// when the resident promoter -- which reads a WHOLE stem so later playback is
// free -- gets in front of the refill workers, which are reading audio that is
// coming out of the speakers in the next few hundred milliseconds.
//
// The thresholds below are the only place that trade-off is decided, so they
// are stated here rather than left implicit in a thread loop.

#include "doctest.h"

#include <limits>
#include "audio/IoPressurePolicy.h"

#include <limits>

using namespace resostage;

TEST_CASE("io pressure: full rings mean everyone may read") {
    CHECK(ioPressureFor(1.0) == IoPressureLevel::Healthy);
    CHECK(ioPressureFor(0.75) == IoPressureLevel::Healthy);
    CHECK(residentPromoterMayStart(ioPressureFor(1.0)));
    CHECK_FALSE(residentLoadShouldAbort(ioPressureFor(1.0)));
}

TEST_CASE("io pressure: draining rings stop new bulk reads before they start") {
    // Deciding at the START matters more than it looks: a resident load is a
    // whole stem, so by the time it is in flight the disk is already committed
    // to it.
    const auto tight = ioPressureFor(0.20);
    CHECK(tight == IoPressureLevel::Tight);
    CHECK_FALSE(residentPromoterMayStart(tight));
    // ...but one already going is allowed to finish. Abandoning it throws away
    // everything read so far, and a dip is not yet an emergency.
    CHECK_FALSE(residentLoadShouldAbort(tight));
}

TEST_CASE("io pressure: nearly empty rings abandon whatever is in flight") {
    const auto critical = ioPressureFor(0.05);
    CHECK(critical == IoPressureLevel::Critical);
    CHECK_FALSE(residentPromoterMayStart(critical));
    CHECK(residentLoadShouldAbort(critical));
}

TEST_CASE("io pressure: the thresholds are where they are documented to be") {
    // Exactly at a boundary counts as the healthier side, so a ring sitting
    // precisely on 30% does not flap between two policies.
    CHECK(ioPressureFor(kIoTightFraction) == IoPressureLevel::Healthy);
    CHECK(ioPressureFor(kIoTightFraction - 1e-9) == IoPressureLevel::Tight);
    CHECK(ioPressureFor(kIoCriticalFraction) == IoPressureLevel::Tight);
    CHECK(ioPressureFor(kIoCriticalFraction - 1e-9) == IoPressureLevel::Critical);
}

TEST_CASE("io pressure: an unknown reading is not an alarm") {
    // No song staged, or a figure that never got written. Treating that as
    // Critical would permanently freeze residency on a project that is simply
    // not playing yet -- and residency is what makes speed and reverse work at
    // all.
    CHECK(ioPressureFor(std::numeric_limits<double>::quiet_NaN()) == IoPressureLevel::Healthy);
    CHECK(ioPressureFor(-1.0) == IoPressureLevel::Healthy);
}

TEST_CASE("io pressure: refill visits get bigger as the rings get emptier") {
    // Each refill is a read against a device whose QUEUE is the contended
    // resource, so under pressure the worker stays on one buffer and drains
    // its backlog instead of round-robining a chunk at a time.
    const int healthy = refillBurstFor(IoPressureLevel::Healthy, 2);
    const int tight = refillBurstFor(IoPressureLevel::Tight, 2);
    const int critical = refillBurstFor(IoPressureLevel::Critical, 2);

    CHECK(healthy == 2);
    CHECK(tight > healthy);
    CHECK(critical > tight);

    // Never zero, whatever it is handed -- a burst of none would stall the
    // feeder completely at exactly the moment it is needed most.
    CHECK(refillBurstFor(IoPressureLevel::Healthy, 0) >= 1);
    CHECK(refillBurstFor(IoPressureLevel::Critical, -5) >= 1);
}

TEST_CASE("io pressure: the promoter yields strictly before it abandons") {
    // Walking the whole range: there must be no fraction at which the engine
    // would abort a load it would also have been willing to start.
    for (int i = 0; i <= 100; ++i) {
        const double fraction = static_cast<double>(i) / 100.0;
        const auto level = ioPressureFor(fraction);
        if (residentLoadShouldAbort(level))
            CHECK_FALSE(residentPromoterMayStart(level));
    }
}
