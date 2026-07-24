#include "doctest.h"

#include "timing/MasterClock.h"

using namespace resoset;

namespace {
class FakeClock final : public MonotonicClockSource {
public:
    uint64_t nowNanos() const override { return current; }
    void advance(uint64_t deltaNanos) { current += deltaNanos; }

private:
    uint64_t current = 0;
};
} // namespace

TEST_CASE("MasterClock advances purely from wall clock with zero audio callbacks") {
    // This is the core fail-safe property the whole architecture rests on:
    // the playhead must not depend on the audio callback ever firing.
    FakeClock clock;
    MasterClock mc(&clock);
    mc.start(48000.0);
    CHECK(mc.currentSamplePosition() == 0);

    clock.advance(1'000'000'000ull); // +1s, no onAudioCallback() ever called
    CHECK(mc.currentSamplePosition() == 48000);

    clock.advance(500'000'000ull); // +0.5s
    CHECK(mc.currentSamplePosition() == 72000);
}

TEST_CASE("MasterClock keeps advancing through a simulated audio stall") {
    FakeClock clock;
    MasterClock mc(&clock);
    mc.start(48000.0);

    // A few normal callbacks establishing a steady rate (10ms blocks @ 48kHz = 480 samples).
    for (int i = 1; i <= 5; ++i) {
        clock.advance(10'000'000ull);
        mc.onAudioCallback(clock.nowNanos(), static_cast<int64_t>(i) * 480);
    }
    const int64_t posBeforeStall = mc.currentSamplePosition();

    // Simulate a 500ms stall: wall clock keeps moving, but the audio callback
    // never fires again during the stall (device glitch / hot-unplug / overload).
    clock.advance(500'000'000ull);
    const int64_t posDuringStall = mc.currentSamplePosition();

    CHECK(posDuringStall > posBeforeStall);
    // ~500ms worth of samples should have accrued (~24000 @ 48kHz), with
    // generous tolerance for the drift-correction factor's influence.
    CHECK(posDuringStall - posBeforeStall > 20000);
    CHECK(posDuringStall - posBeforeStall < 28000);
}

TEST_CASE("MasterClock onAudioCallback pulls the projection toward the hardware-reported position") {
    FakeClock clock;
    MasterClock mc(&clock);
    mc.start(48000.0);

    clock.advance(100'000'000ull); // +100ms
    // Hardware reports it's actually further along than the free-running
    // projection would expect (simulating the driver having briefly run hot).
    mc.onAudioCallback(clock.nowNanos(), 4800 + 500);

    CHECK(mc.currentSamplePosition() == 4800 + 500);
    CHECK(mc.driftFactor() > 1.0); // correcting to catch up
}

TEST_CASE("MasterClock stop() freezes the reported position") {
    FakeClock clock;
    MasterClock mc(&clock);
    mc.start(48000.0);
    clock.advance(1'000'000'000ull);
    mc.stop();

    const int64_t frozen = mc.currentSamplePosition();
    clock.advance(1'000'000'000ull);
    CHECK(mc.currentSamplePosition() == frozen);
    CHECK_FALSE(mc.isRunning());
}
