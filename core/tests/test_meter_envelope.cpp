// Measuring what the signal did, at a resolution the display can use.
//
// The problem being solved is one of SAMPLING, not of ballistics. A meter
// published once per audio callback is one number per 85ms at a 4096-frame
// buffer, against a UI asking three times as often -- so most polls had
// nothing and the needles slammed to the floor on steady audio.
//
// The problem deliberately NOT solved here is how a needle falls. That used to
// live in this file as a PPM release running on the audio thread, and it was
// wrong: its fall was slower than the display's own, so it quietly took the
// decay over. Muting the only track feeding a bus then left the meter gliding
// down for seconds after the audio was measurably gone. These tests pin the
// measurement, and pin the absence of any decay in it.

#include "doctest.h"

#include "audio/MeterEnvelope.h"

#include <algorithm>
#include <cmath>
#include <vector>

using namespace resostage;

namespace {

/** One channel of constant level. */
std::vector<float> flat(int n, float level) {
    return std::vector<float>(static_cast<size_t>(n), level);
}

/** Silence with a single full-scale sample at `at` -- a transient. */
std::vector<float> impulseAt(int n, int at, float level = 1.0f) {
    std::vector<float> v(static_cast<size_t>(n), 0.0f);
    if (at >= 0 && at < n)
        v[static_cast<size_t>(at)] = level;
    return v;
}

std::vector<MeterEnvelopePoint> run(const std::vector<float>& mono) {
    const float* chans[1] = {mono.data()};
    std::vector<MeterEnvelopePoint> out;
    measureSubBlockPeaks(chans, 1, static_cast<int>(mono.size()),
                         [&](const MeterEnvelopePoint& p) { out.push_back(p); });
    return out;
}

/** What a consumer does with a drain: the loudest of everything that arrived. */
float loudest(const MeterEnvelopePoint* points, size_t n) {
    float m = 0.0f;
    for (size_t i = 0; i < n; ++i)
        m = std::max(m, points[i].peak());
    return m;
}

} // namespace

TEST_CASE("meter envelope: one block yields many measurements, not a single number") {
    // The whole point: a 4096-frame callback at 48kHz is 85ms of audio, and a
    // UI polling at 60Hz wants to know what happened THROUGH it.
    const auto points = run(flat(4096, 0.5f));
    CHECK(points.size() == 4096 / kMeterSubBlock);
    CHECK(points.size() == 64);
}

TEST_CASE("meter envelope: a transient inside a big block is placed, not smeared") {
    // With one peak per callback, a hit at the start and a hit at the end of
    // an 85ms block are indistinguishable. Here they land in different points.
    auto indexOfPeak = [](const std::vector<MeterEnvelopePoint>& pts) {
        for (size_t i = 0; i < pts.size(); ++i)
            if (pts[i].peak() > 0.5f)
                return static_cast<int>(i);
        return -1;
    };

    const auto early = run(impulseAt(4096, 10));
    const auto late = run(impulseAt(4096, 4000));

    CHECK(indexOfPeak(early) == 10 / kMeterSubBlock);
    CHECK(indexOfPeak(late) == 4000 / kMeterSubBlock);
    CHECK(indexOfPeak(early) != indexOfPeak(late));
    // ...and nowhere else: one hit is one point.
    CHECK(early.back().peak() == doctest::Approx(0.0f));
    CHECK(late.front().peak() == doctest::Approx(0.0f));
}

TEST_CASE("meter envelope: the measurement is the true sample peak") {
    const auto points = run(impulseAt(512, 0, 0.75f));
    REQUIRE(!points.empty());
    CHECK(points.front().peak() == doctest::Approx(0.75f));
    // Negative excursions count: a meter reads magnitude.
    const auto negative = run(impulseAt(512, 0, -0.9f));
    CHECK(negative.front().peak() == doctest::Approx(0.9f));
}

TEST_CASE("meter envelope: silence reads as silence on the spot") {
    // No decay, no tail, no memory of how loud it was a moment ago. This is
    // the property that was lost when the engine ran its own release: a
    // rendered block of silence must measure zero and say so, because that is
    // exactly what happens when the operator mutes the only track feeding a
    // bus.
    const auto loud = run(flat(kMeterSubBlock * 4, 1.0f));
    CHECK(loud.back().peak() == doctest::Approx(1.0f));

    const auto quiet = run(flat(kMeterSubBlock * 4, 0.0f));
    for (const auto& p : quiet)
        CHECK(p.peak() == doctest::Approx(0.0f));
}

TEST_CASE("meter envelope: nothing carries between blocks") {
    // Stateless by construction -- no tracker to get out of step with the
    // audio, and no sample rate to prepare against. A full-scale block
    // followed by a silent one leaves nothing behind.
    (void)run(flat(4096, 1.0f));
    const auto after = run(flat(4096, 0.0f));
    CHECK(loudest(after.data(), after.size()) == doctest::Approx(0.0f));
}

TEST_CASE("meter envelope: a hard-panned strip does not put one reading on both needles") {
    const auto loud = flat(kMeterSubBlock, 0.8f);
    const auto quiet = flat(kMeterSubBlock, 0.0f);
    const float* chans[2] = {loud.data(), quiet.data()};

    MeterEnvelopePoint point;
    measureSubBlockPeaks(chans, 2, kMeterSubBlock,
                         [&](const MeterEnvelopePoint& p) { point = p; });

    CHECK(point.peakL == doctest::Approx(0.8f));
    CHECK(point.peakR == doctest::Approx(0.0f));
    CHECK(point.peak() == doctest::Approx(0.8f));
}

TEST_CASE("meter envelope: a mono source drives both needles rather than leaving one dead") {
    const auto points = run(flat(kMeterSubBlock, 0.4f));
    REQUIRE(!points.empty());
    CHECK(points.front().peakL == doctest::Approx(0.4f));
    CHECK(points.front().peakR == doctest::Approx(0.4f));
}

TEST_CASE("meter envelope: a ragged last sub-block is measured, not dropped") {
    // Buffer sizes divide by 64 in practice, but a partial tail must still be
    // measured -- losing it would silently drop a transient at a block edge.
    const int odd = kMeterSubBlock * 3 + 17;
    auto signal = flat(odd, 0.0f);
    signal[static_cast<size_t>(odd - 1)] = 1.0f;
    const auto points = run(signal);
    CHECK(points.size() == 4);
    CHECK(points.back().peak() == doctest::Approx(1.0f));
}

TEST_CASE("meter envelope: nonsense inputs are answered, not crashed on") {
    int calls = 0;
    const auto emit = [&](const MeterEnvelopePoint&) { ++calls; };
    measureSubBlockPeaks(nullptr, 2, 512, emit);
    const float* nullChans[1] = {nullptr};
    measureSubBlockPeaks(nullChans, 1, 512, emit);
    const auto mono = flat(512, 1.0f);
    const float* chans[1] = {mono.data()};
    measureSubBlockPeaks(chans, 0, 512, emit);
    measureSubBlockPeaks(chans, 1, 0, emit);
    measureSubBlockPeaks(chans, 1, -5, emit);
    CHECK(calls == 0);
}

TEST_CASE("meter envelope: the interval peak reads the same at 512 frames and at 4096") {
    // The property the whole thing exists for. One second of audio with a
    // single transient in it: what a consumer sees over that second must not
    // depend on how the driver chopped it into callbacks.
    const int total = 48000;
    const int transientAt = 30000;

    auto measureOverSecond = [&](int blockSize) {
        std::vector<float> whole(static_cast<size_t>(total), 0.1f);
        whole[static_cast<size_t>(transientAt)] = 0.9f;

        float seen = 0.0f;
        for (int done = 0; done + blockSize <= total; done += blockSize) {
            const float* chans[1] = {whole.data() + done};
            measureSubBlockPeaks(chans, 1, blockSize, [&](const MeterEnvelopePoint& p) {
                seen = std::max(seen, p.peak());
            });
        }
        return seen;
    };

    CHECK(measureOverSecond(512) == doctest::Approx(0.9f));
    CHECK(measureOverSecond(4096) == doctest::Approx(0.9f));
    CHECK(measureOverSecond(512) == doctest::Approx(measureOverSecond(4096)));
}

TEST_CASE("meter envelope: a poll that lands between callbacks has nothing new, not silence") {
    // The failure this replaces, verified against a running engine at a
    // 4096-frame buffer: the UI polls three times per callback, and two of
    // those found an empty latch and reported the floor -- so the needle
    // slammed down twelve times a second on steady audio.
    //
    // A drain must distinguish "no audio" from "no measurement since you last
    // asked". Empty means the latter, and the caller holds.
    MeterEnvelopeRing<256> ring;
    const auto block = flat(4096, 0.5f);
    const float* chans[1] = {block.data()};
    measureSubBlockPeaks(chans, 1, 4096, [&](const MeterEnvelopePoint& p) { ring.push(p); });

    MeterEnvelopePoint out[256];
    CHECK(ring.drain(out, 256) == 64);
    // Two more polls before the next callback. Both come back empty -- the
    // signal to keep the held value, NOT a reading of zero.
    CHECK(ring.drain(out, 256) == 0);
    CHECK(ring.drain(out, 256) == 0);
}

TEST_CASE("meter envelope: a producer that stops must say so, or the needle freezes") {
    // Holding the last value across an empty drain is what keeps a needle
    // steady between callbacks. But "hold until there is news" only works
    // while there is going to BE news: once the engine stops publishing
    // entirely, the hold becomes permanent and the consumer cannot tell the
    // two apart. So silence is PUSHED.
    MeterEnvelopeRing<256> ring;
    const auto loud = flat(1024, 0.7f);
    const float* chans[1] = {loud.data()};
    measureSubBlockPeaks(chans, 1, 1024, [&](const MeterEnvelopePoint& p) { ring.push(p); });

    MeterEnvelopePoint out[256];
    float held = 0.0f;
    const auto drain = [&] {
        const size_t n = ring.drain(out, 256);
        if (n > 0)
            held = loudest(out, n);
        return held;
    };

    CHECK(drain() == doctest::Approx(0.7f));
    CHECK(drain() == doctest::Approx(0.7f)); // nothing new: hold

    ring.push(MeterEnvelopePoint{}); // transport stopped
    CHECK(drain() == doctest::Approx(0.0f));
    CHECK(drain() == doctest::Approx(0.0f));
}

TEST_CASE("meter envelope: muting the last source drops the meter within one drain") {
    // The reported bug, as arithmetic. A bus fed by one track, then muted: the
    // very next block the engine renders is silence, and the drain that
    // follows must read silence. Not a glide, not a tail.
    MeterEnvelopeRing<256> ring;
    const auto playing = flat(512, 0.6f);
    const float* loudChans[1] = {playing.data()};
    measureSubBlockPeaks(loudChans, 1, 512, [&](const MeterEnvelopePoint& p) { ring.push(p); });

    MeterEnvelopePoint out[256];
    size_t n = ring.drain(out, 256);
    REQUIRE(n > 0);
    CHECK(loudest(out, n) == doctest::Approx(0.6f));

    // Mute. The bus still renders -- it renders nothing.
    const auto muted = flat(512, 0.0f);
    const float* quietChans[1] = {muted.data()};
    measureSubBlockPeaks(quietChans, 1, 512, [&](const MeterEnvelopePoint& p) { ring.push(p); });

    n = ring.drain(out, 256);
    REQUIRE(n > 0);
    CHECK(loudest(out, n) == doctest::Approx(0.0f));
}

TEST_CASE("meter envelope ring: the consumer gets every point in order") {
    MeterEnvelopeRing<64> ring;
    for (int i = 0; i < 10; ++i)
        ring.push({static_cast<float>(i), static_cast<float>(i)});

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
        ring.push({static_cast<float>(i), static_cast<float>(i)});

    CHECK(ring.available() == 8);
    MeterEnvelopePoint out[8];
    CHECK(ring.drain(out, 8) == 8);
    CHECK(out[0].peakL == doctest::Approx(12.0f));
    CHECK(out[7].peakL == doctest::Approx(19.0f));
}

TEST_CASE("meter envelope ring: draining in UI-sized bites loses nothing") {
    // 4096 frames produce 64 points; a 60Hz consumer takes them a few at a
    // time. Every point must arrive exactly once.
    MeterEnvelopeRing<256> ring;
    const auto mono = flat(4096, 0.25f);
    const float* chans[1] = {mono.data()};
    measureSubBlockPeaks(chans, 1, 4096, [&](const MeterEnvelopePoint& p) { ring.push(p); });

    size_t total = 0;
    MeterEnvelopePoint out[7];
    while (const size_t n = ring.drain(out, 7))
        total += n;
    CHECK(total == 64);
}

TEST_CASE("meter envelope: a late block cannot outvote the silence that follows it") {
    // The stop race, with the drain rule that actually ships. A drain reports
    // the LOUDEST of what it finds, so pushing a zero after a late block is
    // not enough on its own -- both land in the same window and the loud one
    // wins. The producer disowns what is queued first.
    MeterEnvelopeRing<256> ring;

    const auto loud = flat(512, 0.9f);
    const float* chans[1] = {loud.data()};
    measureSubBlockPeaks(chans, 1, 512, [&](const MeterEnvelopePoint& p) { ring.push(p); });

    // Transport stops: disown, then say silence.
    ring.discardQueued();
    ring.push(MeterEnvelopePoint{});

    MeterEnvelopePoint out[256];
    const size_t n = ring.drain(out, 256);
    REQUIRE(n == 1);
    CHECK(loudest(out, n) == doctest::Approx(0.0f));
}

TEST_CASE("meter envelope: discarding does not lose anything pushed afterwards") {
    MeterEnvelopeRing<64> ring;
    for (int i = 0; i < 5; ++i)
        ring.push({1.0f, 1.0f});
    ring.discardQueued();
    for (int i = 0; i < 3; ++i)
        ring.push({0.25f, 0.25f});

    MeterEnvelopePoint out[64];
    const size_t n = ring.drain(out, 64);
    CHECK(n == 3);
    CHECK(loudest(out, n) == doctest::Approx(0.25f));
}

TEST_CASE("meter envelope: discarding an empty ring is harmless") {
    MeterEnvelopeRing<64> ring;
    ring.discardQueued();
    MeterEnvelopePoint out[64];
    CHECK(ring.drain(out, 64) == 0);
    ring.push({0.5f, 0.5f});
    CHECK(ring.drain(out, 64) == 1);
    CHECK(out[0].peak() == doctest::Approx(0.5f));
}
