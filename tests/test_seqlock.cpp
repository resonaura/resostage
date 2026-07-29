#include "doctest.h"

#include "telemetry/SeqLock.h"

#include <atomic>
#include <thread>

using namespace resostage;

namespace {

// Multi-field POD tagged with a generation counter: every field is derived
// from `generation` by a fixed relationship, so a reader observing a
// consistent snapshot can verify all fields belong to the same write (a torn
// read would very likely violate one of the relationships).
struct TaggedFrame {
    uint32_t generation = 0;
    float a = 0.0f;
    float b = 0.0f;
    float c = 0.0f;
};
static_assert(std::is_trivially_copyable_v<TaggedFrame>);

} // namespace

TEST_CASE("SeqLock default-constructs and round-trips a single write") {
    SeqLock<TaggedFrame> lock;

    TaggedFrame out;
    // Never written: sequence starts at 0 (even), so read() must still
    // succeed and return the default-constructed value.
    REQUIRE(lock.read(out));
    CHECK(out.generation == 0);
    CHECK(out.a == 0.0f);

    TaggedFrame in;
    in.generation = 7;
    in.a = 7.0f;
    in.b = 14.0f;
    in.c = 21.0f;
    lock.write(in);

    REQUIRE(lock.read(out));
    CHECK(out.generation == 7);
    CHECK(out.a == 7.0f);
    CHECK(out.b == 14.0f);
    CHECK(out.c == 21.0f);
}

TEST_CASE("SeqLock survives a single writer hammered by concurrent readers without torn reads") {
    // Mirrors the concurrency-stress pattern already used for RoutingEngine
    // and AudioRingBuffer: one writer thread (standing in for the real-time
    // audio thread) continuously publishing new frames while several reader
    // threads (standing in for the web server / UI threads) poll. A read()
    // that succeeds must never observe a mix of fields from two different
    // writes; a read() that can't get a consistent snapshot within its
    // retry budget must report failure rather than return torn data.
    SeqLock<TaggedFrame> lock;
    std::atomic<bool> stop{false};
    std::atomic<bool> corruptionDetected{false};
    std::atomic<uint64_t> successfulReads{0};
    std::atomic<uint64_t> failedReads{0};

    constexpr uint32_t kGenerations = 200000;

    std::thread writer([&] {
        for (uint32_t generation = 1; generation <= kGenerations; ++generation) {
            TaggedFrame frame;
            frame.generation = generation;
            frame.a = static_cast<float>(generation);
            frame.b = static_cast<float>(generation) * 2.0f;
            frame.c = static_cast<float>(generation) * 3.0f;
            lock.write(frame);
        }
        stop.store(true, std::memory_order_release);
    });

    auto readerFn = [&] {
        while (!stop.load(std::memory_order_acquire)) {
            TaggedFrame out;
            if (lock.read(out)) {
                successfulReads.fetch_add(1, std::memory_order_relaxed);
                const float g = static_cast<float>(out.generation);
                if (out.a != g || out.b != g * 2.0f || out.c != g * 3.0f)
                    corruptionDetected.store(true, std::memory_order_relaxed);
            } else {
                failedReads.fetch_add(1, std::memory_order_relaxed);
            }
        }
        // Drain a few more reads after the writer stops to exercise the
        // final-value path too.
        for (int i = 0; i < 8; ++i) {
            TaggedFrame out;
            if (lock.read(out)) {
                successfulReads.fetch_add(1, std::memory_order_relaxed);
                const float g = static_cast<float>(out.generation);
                if (out.a != g || out.b != g * 2.0f || out.c != g * 3.0f)
                    corruptionDetected.store(true, std::memory_order_relaxed);
            }
        }
    };

    std::thread readerA(readerFn);
    std::thread readerB(readerFn);

    writer.join();
    readerA.join();
    readerB.join();

    CHECK_FALSE(corruptionDetected.load());
    CHECK(successfulReads.load() > 0);
    // Bounded-retry reads under heavy write contention are expected to fail
    // occasionally by design (the writer never blocks for them) -- that's
    // not itself a bug, just confirming the "give up rather than block" path
    // is actually exercised by this stress level.
}
