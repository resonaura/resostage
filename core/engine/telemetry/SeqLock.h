#pragma once

#include <atomic>
#include <cstddef>
#include <cstring>
#include <type_traits>

namespace resostage {

// Wait-free single-writer / multi-reader state exchange for POD-ish structs that
// are too large to update with a single atomic store (e.g. multi-field metering
// telemetry). The writer (real-time audio thread) never blocks. Readers (web
// server thread, UI thread) retry a bounded number of times if they observe a
// write in progress; they never block the writer either.
//
// T must be trivially copyable. Only one thread may call write() (single writer);
// any number of threads may call read() concurrently.
template <typename T>
class SeqLock {
    static_assert(std::is_trivially_copyable_v<T>, "SeqLock<T> requires a trivially copyable T");

public:
    SeqLock() : sequence(0) {}

    // Called exclusively by the single writer thread.
    void write(const T& value) {
        const uint32_t seq = sequence.load(std::memory_order_relaxed);
        // Odd => write in progress. The marker needs a relaxed store followed
        // by a release FENCE, not a release store: a release store only stops
        // earlier writes from sinking below it, and the hazard here is the
        // exact opposite -- the memcpy being hoisted ABOVE the marker, so a
        // reader sees an even (clean-looking) sequence while the payload is
        // half replaced. The fence is what actually pins the marker ahead of
        // the payload. This is not theoretical: the concurrency stress test in
        // test_seqlock.cpp starts failing the moment this file is compiled
        // with optimisation, because that is when the compiler takes the
        // reordering the old release store never forbade.
        sequence.store(seq + 1, std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_release);
        std::memcpy(&storage, &value, sizeof(T));
        sequence.store(seq + 2, std::memory_order_release); // even => write complete
    }

    // Called from any reader thread. Returns false if a consistent snapshot could
    // not be obtained within maxRetries (writer was mid-update every time); callers
    // should simply keep the previous value they had in that case.
    bool read(T& out, int maxRetries = 4) const {
        for (int attempt = 0; attempt < maxRetries; ++attempt) {
            const uint32_t seqBefore = sequence.load(std::memory_order_acquire);
            if (seqBefore & 1u)
                continue; // writer mid-update, retry

            T local;
            std::memcpy(&local, &storage, sizeof(T));

            // Mirror of the writer's fence, and needed for the same asymmetry:
            // an acquire LOAD only stops later reads from being hoisted above
            // it, so on its own it would let the memcpy sink past the
            // validating load -- i.e. read bytes the writer put down after
            // this reader had already "confirmed" the sequence was unchanged.
            std::atomic_thread_fence(std::memory_order_acquire);
            const uint32_t seqAfter = sequence.load(std::memory_order_relaxed);
            if (seqBefore == seqAfter) {
                out = local;
                return true;
            }
        }
        return false;
    }

private:
    alignas(64) std::atomic<uint32_t> sequence;
    alignas(64) T storage{};
};

} // namespace resostage
