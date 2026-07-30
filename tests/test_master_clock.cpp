#include "doctest.h"

#include "timing/MasterClock.h"

using namespace resostage;

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

// Regression test for a real bug: JUCE's CoreAudio backend hands back
// AudioIODeviceCallbackContext::hostTimeNs pointing at AudioTimeStamp's raw
// mach_absolute_time() ticks, not actual nanoseconds, despite the name.
// Feeding that straight into MasterClock (which anchors against
// SystemMonotonicClock::nowNanos(), which *does* apply the timebase
// conversion) made the elapsed-time math wildly wrong -- the fix is to run
// any such raw host-time value through ticksToNanos() first. This only
// asserts ticksToNanos()'s basic mathematical sanity (exact numer/denom
// values are a system property, not something to hardcode in a test).
TEST_CASE("SystemMonotonicClock::ticksToNanos scales linearly and maps zero to zero") {
    CHECK(SystemMonotonicClock::ticksToNanos(0) == 0);

    const uint64_t oneTick = SystemMonotonicClock::ticksToNanos(1'000'000);
    const uint64_t tenTicks = SystemMonotonicClock::ticksToNanos(10'000'000);
    // Should scale ~10x (exact ratio depends on the platform's timebase, but
    // it must be a consistent linear conversion, not a passthrough that
    // silently disagrees with nowNanos()'s own conversion).
    CHECK(tenTicks > oneTick * 9);
    CHECK(tenTicks < oneTick * 11);
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

// Regression test for AudioEngine::handleSampleRateChanged (a live device
// sample-rate change mid-playback): re-start()ing at a new rate with the
// equivalent sample position must resume from ~the same wall-clock position,
// not jump back to 0 -- otherwise a rate change would silently rewind the
// playhead every time it happens.
TEST_CASE("MasterClock re-start() at a new sample rate preserves the equivalent timeline position") {
    FakeClock clock;
    MasterClock mc(&clock);
    mc.start(44100.0);

    clock.advance(2'000'000'000ull); // +2s of wall-clock running at 44.1kHz
    const double secondsBeforeRateChange = mc.currentSeconds();
    CHECK(secondsBeforeRateChange == doctest::Approx(2.0).epsilon(0.01));

    // Simulate the device restarting at 48kHz: re-derive the equivalent
    // sample position at the new rate and re-start() with it, exactly like
    // AudioEngine::handleSampleRateChanged does.
    const int64_t newStartSample = static_cast<int64_t>(secondsBeforeRateChange * 48000.0);
    mc.start(48000.0, newStartSample);

    CHECK(mc.currentSeconds() == doctest::Approx(secondsBeforeRateChange).epsilon(0.01));
    CHECK(mc.sampleRate() == 48000.0);

    // And it keeps advancing correctly at the new rate afterward.
    clock.advance(1'000'000'000ull); // +1s more
    CHECK(mc.currentSeconds() == doctest::Approx(secondsBeforeRateChange + 1.0).epsilon(0.01));
}

TEST_CASE("MasterClock re-start() at a new sample rate while stopped stays stopped") {
    // Mirrors the "clock.start(...); clock.stop();" idiom used elsewhere in
    // AudioEngine.cpp to update the clock's cached rate without resuming
    // playback -- handleSampleRateChanged uses the same pattern when the
    // transport wasn't running at the time of the rate change.
    FakeClock clock;
    MasterClock mc(&clock);
    mc.start(44100.0, 0);
    mc.stop();
    CHECK_FALSE(mc.isRunning());

    mc.start(48000.0, 12345);
    mc.stop();

    CHECK_FALSE(mc.isRunning());
    const int64_t frozen = mc.currentSamplePosition();
    clock.advance(1'000'000'000ull);
    CHECK(mc.currentSamplePosition() == frozen);
}
