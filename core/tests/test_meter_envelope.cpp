#include "doctest.h"

#include "audio/MeterEnvelope.h"

#include <cmath>
#include <vector>

using namespace resostage;

namespace {

constexpr double kSr = 48000.0;

/** dB below full scale, for readable expectations. */
double db(float linear) {
    return linear > 0.0f ? 20.0 * std::log10(static_cast<double>(linear)) : -144.0;
}

/** One channel of constant level. */
std::vector<float> flat(int n, float level) { return std::vector<float>(static_cast<size_t>(n), level); }

/** Silence with a single full-scale sample at `at` -- a transient. */
std::vector<float> impulseAt(int n, int at, float level = 1.0f) {
    std::vector<float> v(static_cast<size_t>(n), 0.0f);
    if (at >= 0 && at < n)
        v[static_cast<size_t>(at)] = level;
    return v;
}

std::vector<MeterEnvelopePoint> run(MeterEnvelopeTracker& t, const std::vector<float>& mono) {
    const float* chans[1] = {mono.data()};
    std::vector<MeterEnvelopePoint> out;
    t.process(chans, 1, static_cast<int>(mono.size()), [&](const MeterEnvelopePoint& p) {
        out.push_back(p);
    });
    return out;
}

} // namespace

TEST_CASE("meter envelope: one block yields a trajectory, not a single number") {
    // The whole point: a 4096-frame callback at 48kHz is 85ms of audio, and a
    // UI polling at 60Hz wants to know what happened THROUGH it, not one peak
    // for the lot.
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    const auto points = run(t, flat(4096, 0.5f));
    CHECK(points.size() == 4096 / kMeterSubBlock);
    CHECK(points.size() == 64);
}

TEST_CASE("meter envelope: a transient inside a big block is placed, not smeared") {
    // With one peak per callback, a hit at the start and a hit at the end of
    // an 85ms block are indistinguishable. Here they land in different points.
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    auto indexOfPeak = [](const std::vector<MeterEnvelopePoint>& pts) {
        for (size_t i = 0; i < pts.size(); ++i)
            if (pts[i].peak() > 0.5f)
                return static_cast<int>(i);
        return -1;
    };

    const auto early = run(t, impulseAt(4096, 10));
    t.reset();
    const auto late = run(t, impulseAt(4096, 4000));

    // Each lands in the sub-block that actually contains it.
    CHECK(indexOfPeak(early) == 10 / kMeterSubBlock);
    CHECK(indexOfPeak(late) == 4000 / kMeterSubBlock);
    CHECK(indexOfPeak(early) != indexOfPeak(late));
    // ...and nowhere else: one hit is one point.
    CHECK(early.back().peak() == doctest::Approx(0.0f));
    CHECK(late.front().peak() == doctest::Approx(0.0f));
}

TEST_CASE("meter envelope: peak attacks instantly and never under-reads") {
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    const auto points = run(t, impulseAt(512, 0));
    CHECK(points.front().ppm() == doctest::Approx(1.0f));
}

TEST_CASE("meter envelope: PPM falls at the standard's rate") {
    // IEC 60268-10 Type II: 20dB in 1.7 seconds. Hit it once, then feed
    // silence for exactly that long and check where the needle got to.
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    (void)run(t, impulseAt(kMeterSubBlock, 0));

    const int silentSamples = static_cast<int>(1.7 * kSr);
    const auto tail = run(t, flat(silentSamples, 0.0f));
    REQUIRE(!tail.empty());
    CHECK(db(tail.back().ppm()) == doctest::Approx(-20.0).epsilon(0.05));
}

TEST_CASE("meter envelope: ballistics survive the block boundary") {
    // The release is a filter, so it must not restart with each callback --
    // that discontinuity is the thing this replaces.
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    (void)run(t, impulseAt(kMeterSubBlock, 0));

    const int half = static_cast<int>(0.85 * kSr);
    const auto first = run(t, flat(half, 0.0f));
    const auto second = run(t, flat(half, 0.0f));
    // Split across two calls, the total fall is still the 1.7s figure.
    CHECK(db(second.back().ppm()) == doctest::Approx(-20.0).epsilon(0.05));
    CHECK(second.back().ppm() < first.back().ppm());
}

TEST_CASE("meter envelope: rms describes level where peak describes crest") {
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    // A steady half-scale tone: rms of a constant equals the constant.
    const auto steady = run(t, flat(kMeterSubBlock * 4, 0.5f));
    CHECK(steady.back().rms == doctest::Approx(0.5f).epsilon(0.001));

    // One full-scale sample in an otherwise silent sub-block: peak is 1, and
    // rms is tiny -- which is exactly the distinction a single number loses.
    t.reset();
    const auto spike = run(t, impulseAt(kMeterSubBlock, 0));
    CHECK(spike.front().peak() == doctest::Approx(1.0f));
    CHECK(spike.front().rms < 0.13f);
}

TEST_CASE("meter envelope: silence reads as silence immediately") {
    // No invented decay on the way in: a block of digital silence reports a
    // peak of zero on the spot. Only the PPM needle falls gradually.
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    (void)run(t, flat(kMeterSubBlock, 1.0f));
    const auto quiet = run(t, flat(kMeterSubBlock, 0.0f));
    CHECK(quiet.front().peak() == doctest::Approx(0.0f));
    CHECK(quiet.front().ppm() > 0.0f);
}

TEST_CASE("meter envelope ring: the consumer gets every point in order") {
    MeterEnvelopeRing<64> ring;
    for (int i = 0; i < 10; ++i)
        ring.push({static_cast<float>(i), static_cast<float>(i), 0.0f, 0.0f, 0.0f});

    CHECK(ring.available() == 10);
    MeterEnvelopePoint out[16];
    CHECK(ring.drain(out, 16) == 10);
    for (int i = 0; i < 10; ++i)
        CHECK(out[i].peakL == doctest::Approx(static_cast<float>(i)));
    CHECK(ring.available() == 0);
}

TEST_CASE("meter envelope ring: a display that fell behind gets the recent past") {
    // Overflow drops the OLDEST. A UI that stalled wants what just happened,
    // not a backlog starting from whenever it stopped reading.
    MeterEnvelopeRing<8> ring;
    for (int i = 0; i < 20; ++i)
        ring.push({static_cast<float>(i), static_cast<float>(i), 0.0f, 0.0f, 0.0f});

    CHECK(ring.available() == 8);
    MeterEnvelopePoint out[8];
    CHECK(ring.drain(out, 8) == 8);
    // The last eight pushed, 12..19.
    CHECK(out[0].peakL == doctest::Approx(12.0f));
    CHECK(out[7].peakL == doctest::Approx(19.0f));
}

TEST_CASE("meter envelope ring: draining in UI-sized bites loses nothing") {
    // 4096 frames produce 64 points; a 60Hz consumer takes them a few at a
    // time. Every point must arrive exactly once.
    MeterEnvelopeRing<256> ring;
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    const auto mono = flat(4096, 0.25f);
    const float* chans[1] = {mono.data()};
    t.process(chans, 1, static_cast<int>(mono.size()),
              [&](const MeterEnvelopePoint& p) { ring.push(p); });

    size_t total = 0;
    MeterEnvelopePoint out[7];
    while (const size_t n = ring.drain(out, 7))
        total += n;
    CHECK(total == 64);
}

TEST_CASE("meter envelope: a poll that lands between callbacks has nothing new, not silence") {
    // The failure this replaces, verified against a running engine at a 4096-
    // frame buffer: the UI polls three times per callback, and two of those
    // polls found an empty latch and reported the floor -- so the needle
    // slammed down twelve times a second on steady audio.
    //
    // A drain must distinguish "no audio" from "no measurement since you last
    // asked". Empty means the latter, and the caller holds.
    MeterEnvelopeRing<256> ring;
    MeterEnvelopeTracker t;
    t.prepare(kSr);

    const auto block = flat(4096, 0.5f);
    const float* chans[1] = {block.data()};
    t.process(chans, 1, static_cast<int>(block.size()),
              [&](const MeterEnvelopePoint& p) { ring.push(p); });

    MeterEnvelopePoint out[256];
    const size_t first = ring.drain(out, 256);
    CHECK(first == 64);
    const float held = out[first - 1].ppm();
    CHECK(held == doctest::Approx(0.5f));

    // Two more polls before the next callback. Both come back empty -- which
    // is the signal to keep `held`, NOT a reading of zero.
    CHECK(ring.drain(out, 256) == 0);
    CHECK(ring.drain(out, 256) == 0);
}

TEST_CASE("meter envelope: the needle reads the same at 512 frames and at 4096") {
    // The property the whole trajectory exists for. Same audio, same wall
    // clock, different callback sizes -- and the ballistics must not care,
    // because they are stepped per sample rather than per block.
    const int totalSamples = 48000; // one second
    const float level = 0.25f;

    auto needleAfterOneSecond = [&](int blockSize) {
        MeterEnvelopeTracker t;
        t.prepare(kSr);
        float last = 0.0f;
        const auto block = flat(blockSize, level);
        const float* chans[1] = {block.data()};
        for (int done = 0; done < totalSamples; done += blockSize) {
            t.process(chans, 1, blockSize,
                      [&](const MeterEnvelopePoint& p) { last = p.ppm(); });
        }
        return last;
    };

    CHECK(needleAfterOneSecond(512) == doctest::Approx(needleAfterOneSecond(4096)));
    CHECK(needleAfterOneSecond(512) == doctest::Approx(level));
}

TEST_CASE("meter envelope: a release measured across 4096-frame callbacks is still the standard's") {
    // Same test as the 1.7s fall above, but fed in the block size that used to
    // break the old per-callback meter. The ballistics are per SAMPLE, so the
    // callback size must be invisible to them.
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    (void)run(t, impulseAt(kMeterSubBlock, 0));

    float last = 1.0f;
    const auto silence = flat(4096, 0.0f);
    const float* chans[1] = {silence.data()};
    const int blocks = static_cast<int>(std::lround(1.7 * kSr / 4096.0));
    for (int i = 0; i < blocks; ++i)
        t.process(chans, 1, 4096, [&](const MeterEnvelopePoint& p) { last = p.ppm(); });

    CHECK(db(last) == doctest::Approx(-20.0).epsilon(0.05));
}

TEST_CASE("meter envelope: a hard-panned strip does not put the same reading on both needles") {
    // Two channels, two independent ballistics. Collapsing them to one number
    // in the ring would be invisible on mono material and wrong on everything
    // else.
    MeterEnvelopeTracker t;
    t.prepare(kSr);

    const auto loud = flat(kMeterSubBlock, 0.8f);
    const auto quiet = flat(kMeterSubBlock, 0.0f);
    const float* chans[2] = {loud.data(), quiet.data()};

    MeterEnvelopePoint point;
    t.process(chans, 2, kMeterSubBlock, [&](const MeterEnvelopePoint& p) { point = p; });

    CHECK(point.peakL == doctest::Approx(0.8f));
    CHECK(point.peakR == doctest::Approx(0.0f));
    CHECK(point.ppmL == doctest::Approx(0.8f));
    CHECK(point.ppmR == doctest::Approx(0.0f));
    // And the mono view is the louder side, which is what a single-bar meter
    // and the peak readout both want.
    CHECK(point.ppm() == doctest::Approx(0.8f));
}

TEST_CASE("meter envelope: a mono source drives both needles rather than leaving one dead") {
    MeterEnvelopeTracker t;
    t.prepare(kSr);
    const auto points = run(t, flat(kMeterSubBlock, 0.4f));
    REQUIRE(!points.empty());
    CHECK(points.front().ppmL == doctest::Approx(0.4f));
    CHECK(points.front().ppmR == doctest::Approx(0.4f));
}

TEST_CASE("meter envelope: a producer that stops must say so, or the needle freezes") {
    // The bug this pins, reported from a real Stop: the needles parked at
    // whatever was playing and stayed there.
    //
    // Holding the last value across an empty drain is deliberate -- it is what
    // keeps a needle steady through the polls that land between callbacks at a
    // big buffer. But "hold until there is news" only works while there is
    // going to BE news. Once the engine stops publishing entirely, the hold
    // becomes permanent, and a consumer cannot tell the two cases apart.
    //
    // So silence has to be PUSHED, not inferred.
    MeterEnvelopeRing<256> ring;
    MeterEnvelopeTracker t;
    t.prepare(kSr);

    const auto loud = flat(1024, 0.7f);
    const float* chans[1] = {loud.data()};
    t.process(chans, 1, 1024, [&](const MeterEnvelopePoint& p) { ring.push(p); });

    MeterEnvelopePoint out[256];
    float held = 0.0f;
    const auto drain = [&] {
        const size_t n = ring.drain(out, 256);
        if (n > 0)
            held = out[n - 1].ppm();
        return held;
    };

    CHECK(drain() == doctest::Approx(0.7f));
    // Polls between callbacks: nothing new, so the needle stays put.
    CHECK(drain() == doctest::Approx(0.7f));

    // Transport stops. One zero point from the producer is all it takes.
    t.reset();
    ring.push(MeterEnvelopePoint{});
    CHECK(drain() == doctest::Approx(0.0f));
    // ...and it stays at silence however long nobody publishes again.
    CHECK(drain() == doctest::Approx(0.0f));
}

TEST_CASE("meter envelope: silence pushed after a late block still wins") {
    // The race that made the freeze intermittent. The message thread clears
    // the ring on Stop, but a block already in flight lands its points AFTER
    // that clear -- and with nothing following them, the next poll drains
    // them and holds a playing-state value forever.
    //
    // The fix is ordering, not locking: the producer is a single thread, so
    // its own silence point is guaranteed to come after its own late block,
    // and the drain takes the LAST point rather than the loudest.
    MeterEnvelopeRing<256> ring;
    MeterEnvelopeTracker t;
    t.prepare(kSr);

    // Consumer clears (Stop, on the message thread)...
    ring.clear();
    float held = 0.0f;

    // ...then the in-flight block lands anyway.
    const auto loud = flat(512, 0.9f);
    const float* chans[1] = {loud.data()};
    t.process(chans, 1, 512, [&](const MeterEnvelopePoint& p) { ring.push(p); });

    // ...and the producer's own silence follows it.
    t.reset();
    ring.push(MeterEnvelopePoint{});

    MeterEnvelopePoint out[256];
    const size_t n = ring.drain(out, 256);
    REQUIRE(n > 0);
    held = out[n - 1].ppm();
    CHECK(held == doctest::Approx(0.0f));
    // The late block IS in there -- this is not passing because it was lost.
    bool sawLoud = false;
    for (size_t i = 0; i < n; ++i)
        if (out[i].ppm() > 0.5f)
            sawLoud = true;
    CHECK(sawLoud);
}
