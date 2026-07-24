#pragma once

#include <atomic>
#include <cstddef>
#include <cstring>
#include <type_traits>

namespace resoset {

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
        sequence.store(seq + 1, std::memory_order_release); // odd => write in progress
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

            const uint32_t seqAfter = sequence.load(std::memory_order_acquire);
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

} // namespace resoset
