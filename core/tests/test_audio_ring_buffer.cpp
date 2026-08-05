#include "doctest.h"

#include "audio/AudioRingBuffer.h"

#include <atomic>
#include <thread>
#include <vector>

using namespace resostage;

TEST_CASE("AudioRingBuffer push/pop round-trips within capacity") {
    AudioRingBuffer ring;
    ring.prepare(2, 16);

    std::vector<float> l = {1, 2, 3, 4}, r = {10, 20, 30, 40};
    const float* in[2] = {l.data(), r.data()};
    CHECK(ring.push(in, 4) == 4);
    CHECK(ring.framesAvailable() == 4);

    std::vector<float> outL(4), outR(4);
    float* out[2] = {outL.data(), outR.data()};
    CHECK(ring.pop(out, 4) == 4);
    CHECK(outL == l);
    CHECK(outR == r);
    CHECK(ring.framesAvailable() == 0);
}

TEST_CASE("AudioRingBuffer push saturates at capacity, pop underruns to fewer frames") {
    AudioRingBuffer ring;
    ring.prepare(1, 4);

    std::vector<float> data = {1, 2, 3, 4, 5, 6};
    const float* in[1] = {data.data()};
    CHECK(ring.push(in, 6) == 4); // only 4 fit

    std::vector<float> out(10, -999.0f);
    float* outp[1] = {out.data()};
    CHECK(ring.pop(outp, 10) == 4); // only 4 were available
    CHECK(out[0] == 1);
    CHECK(out[3] == 4);
}

TEST_CASE("AudioRingBuffer discard drops buffered frames without copying") {
    AudioRingBuffer ring;
    ring.prepare(1, 8);
    std::vector<float> data = {1, 2, 3, 4, 5};
    const float* in[1] = {data.data()};
    ring.push(in, 5);

    CHECK(ring.discard(3) == 3);
    CHECK(ring.framesAvailable() == 2);

    std::vector<float> out(2);
    float* outp[1] = {out.data()};
    CHECK(ring.pop(outp, 2) == 2);
    CHECK(out[0] == 4);
    CHECK(out[1] == 5);
}

TEST_CASE("AudioRingBuffer wraps around correctly across many push/pop cycles") {
    AudioRingBuffer ring;
    ring.prepare(1, 5);

    int64_t nextPush = 0;
    int64_t nextExpectedPop = 0;
    for (int cycle = 0; cycle < 1000; ++cycle) {
        std::vector<float> data;
        for (int i = 0; i < 3; ++i)
            data.push_back(static_cast<float>(nextPush++));
        const float* in[1] = {data.data()};
        ring.push(in, 3);

        std::vector<float> out(3, -1.0f);
        float* outp[1] = {out.data()};
        const int64_t got = ring.pop(outp, 3);
        for (int64_t i = 0; i < got; ++i)
            CHECK(out[static_cast<size_t>(i)] == static_cast<float>(nextExpectedPop++));
    }
}

TEST_CASE("AudioRingBuffer survives concurrent producer/consumer without data loss or corruption") {
    AudioRingBuffer ring;
    ring.prepare(1, 256);

    constexpr int64_t kTotalFrames = 2'000'000;
    std::atomic<bool> corruption{false};

    std::thread producer([&] {
        int64_t written = 0;
        std::vector<float> chunk(64);
        while (written < kTotalFrames) {
            const int64_t n = std::min<int64_t>(64, kTotalFrames - written);
            for (int64_t i = 0; i < n; ++i)
                chunk[static_cast<size_t>(i)] = static_cast<float>(written + i);
            int64_t pushed = 0;
            while (pushed < n) {
                const float* inOffset[1] = {chunk.data() + pushed};
                const int64_t got = ring.push(inOffset, n - pushed);
                pushed += got;
                // busy-wait/backoff is fine for a test; production refill loop polls similarly
            }
            written += n;
        }
    });

    std::thread consumer([&] {
        int64_t expectedNext = 0;
        std::vector<float> chunk(64);
        while (expectedNext < kTotalFrames) {
            float* outp[1] = {chunk.data()};
            const int64_t got = ring.pop(outp, 64);
            for (int64_t i = 0; i < got; ++i) {
                if (chunk[static_cast<size_t>(i)] != static_cast<float>(expectedNext + i))
                    corruption.store(true, std::memory_order_relaxed);
            }
            expectedNext += got;
        }
    });

    producer.join();
    consumer.join();

    CHECK_FALSE(corruption.load());
}
