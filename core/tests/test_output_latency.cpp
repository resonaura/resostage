// Getting the light to land on the downbeat.
//
// Control events are generated next to the audio they belong with, but the
// audio then waits in the device for tens of milliseconds while the MIDI note
// or DMX frame leaves immediately. The error scales with the buffer size,
// which is what makes it so confusing in the room: raise the buffer to stop a
// dropout and the lights start firing early.

#include "doctest.h"

#include "timing/OutputLatency.h"

#include <cstdlib>
#include <limits>

using namespace resostage;

constexpr double kSr = 48000.0;

TEST_CASE("output latency: a device's reading becomes seconds") {
    // A 512-frame buffer plus the driver's own margins is a few milliseconds;
    // 4096 frames is most of a tenth of a second, which is a visible offset
    // on a light cue and an audible one on a MIDI note.
    CHECK(outputLatencySeconds(512, kSr) == doctest::Approx(512.0 / kSr));
    CHECK(outputLatencySeconds(4096 + 704, kSr) == doctest::Approx(0.1));
}

TEST_CASE("output latency: an implausible reading cannot stall the show") {
    // Drivers do report nonsense, particularly aggregate devices caught
    // mid-reconfiguration. Whatever they say, no trigger may be pushed
    // seconds into the future.
    CHECK(outputLatencySeconds(48000 * 10, kSr)
          == doctest::Approx(kMaxPlausibleOutputLatencySeconds));
    // Unknown is treated as none, not as a guess: a wrong guess shows up as a
    // timing offset nobody can account for.
    CHECK(outputLatencySeconds(0, kSr) == doctest::Approx(0.0));
    CHECK(outputLatencySeconds(-100, kSr) == doctest::Approx(0.0));
    CHECK(outputLatencySeconds(512, 0.0) == doctest::Approx(0.0));
    CHECK(outputLatencySeconds(512, -1.0) == doctest::Approx(0.0));
}

TEST_CASE("output latency: an event is scheduled for when its audio is heard") {
    // The whole point. Sample offset inside the block, plus the device's
    // latency, from the host time the block started rendering.
    const uint64_t blockStart = 1'000'000'000ull; // 1s, arbitrary origin
    const double latency = 0.020;                 // 20 ms

    // An event at the very start of the block still waits out the latency.
    CHECK(heardHostNanos(blockStart, 0.0, latency) == blockStart + 20'000'000ull);
    // One 5 ms into the block waits 25 ms.
    CHECK(heardHostNanos(blockStart, 0.005, latency) == blockStart + 25'000'000ull);
    // With no latency reported it fires where it always did, so a device that
    // says nothing behaves exactly as before this existed.
    CHECK(heardHostNanos(blockStart, 0.005, 0.0) == blockStart + 5'000'000ull);
}

TEST_CASE("output latency: scheduling never moves an event backwards") {
    // A negative offset would mean sending into the past, which for a
    // scheduled MIDI packet means "immediately" and for an unsigned host time
    // means an enormous number. Both are worse than firing now.
    const uint64_t blockStart = 1'000'000'000ull;
    CHECK(heardHostNanos(blockStart, -1.0, 0.0) == blockStart);
    CHECK(heardHostNanos(blockStart, std::numeric_limits<double>::quiet_NaN(), 0.02)
          == blockStart);
}

TEST_CASE("output latency: the heard position trails the rendered one") {
    const int64_t latency = 4096;
    CHECK(heardSample(100000, latency) == 100000 - 4096);
    // At the very top of a song the render position is smaller than the
    // latency; the honest answer is the first sample, not a position before
    // the song began.
    CHECK(heardSample(1000, latency) == 0);
    CHECK(heardSample(0, latency) == 0);
    // No latency, no change.
    CHECK(heardSample(100000, 0) == 100000);
    CHECK(heardSample(100000, -5) == 100000);
}

TEST_CASE("output latency: the correction is what a buffer change does to timing") {
    // This is the number that made the error look like the show drifting
    // rather than like a setting. At 48 kHz the buffer alone moves control
    // timing by 74 ms between the two ends of the range we support -- roughly
    // a sixteenth note at 120 bpm, which on a light cue is unmistakable.
    const double at512 = outputLatencySeconds(512, kSr);
    const double at4096 = outputLatencySeconds(4096, kSr);
    CHECK(at4096 - at512 == doctest::Approx(3584.0 / kSr));
    CHECK((at4096 - at512) * 1000.0 == doctest::Approx(74.67).epsilon(0.01));

    // Compensated, an event at the same song position is scheduled for the
    // same distance ahead of its own block in both cases -- so changing the
    // buffer stops moving the show.
    const uint64_t blockStart = 5'000'000'000ull;
    const uint64_t small = heardHostNanos(blockStart, 0.0, at512);
    const uint64_t big = heardHostNanos(blockStart, 0.0, at4096);
    // Within a nanosecond: the host time is truncated from a double, and one
    // nanosecond of scheduling error is eleven orders of magnitude below
    // anything a listener or a light can resolve.
    const int64_t expected = static_cast<int64_t>((at4096 - at512) * 1.0e9);
    CHECK(std::llabs(static_cast<int64_t>(big - small) - expected) <= 1);
}
