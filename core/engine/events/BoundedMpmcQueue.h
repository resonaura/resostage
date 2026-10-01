/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace resostage {

/**
 * Fixed-capacity lock-free queue for trivially-copyable messages.
 *
 * Producers reserve independent slots with a fixed retry budget, so a MIDI
 * device callback and the WebServer thread may safely publish concurrently.
 * The consumer never waits for a producer; if a producer has reserved the
 * head slot but not published it yet, tryPop() returns false and the consumer
 * retries on its next bounded drain. Full/contention-exhausted queues reject
 * the newest message.
 */
template <typename T, size_t Capacity>
class BoundedMpmcQueue {
    static_assert(Capacity >= 2 && (Capacity & (Capacity - 1)) == 0,
                  "BoundedMpmcQueue capacity must be a power of two");
    static_assert(std::is_trivially_copyable_v<T>,
                  "BoundedMpmcQueue stores trivially-copyable messages");

    struct Slot {
        std::atomic<size_t> sequence{0};
        T value{};
    };

public:
    static constexpr unsigned kMaxCasAttempts = 32;

    BoundedMpmcQueue() noexcept {
        for (size_t i = 0; i < Capacity; ++i)
            slots_[i].sequence.store(i, std::memory_order_relaxed);
    }

    BoundedMpmcQueue(const BoundedMpmcQueue&) = delete;
    BoundedMpmcQueue& operator=(const BoundedMpmcQueue&) = delete;

    /** Returns false when full or after exhausting the fixed CAS retry budget. */
    bool tryPush(const T& value) noexcept {
        size_t position = enqueuePosition_.load(std::memory_order_relaxed);
        Slot* slot = nullptr;
        bool reserved = false;
        for (unsigned attempt = 0; attempt < kMaxCasAttempts; ++attempt) {
            slot = &slots_[position & (Capacity - 1)];
            const size_t sequence = slot->sequence.load(std::memory_order_acquire);
            const auto difference = static_cast<std::intptr_t>(sequence)
                - static_cast<std::intptr_t>(position);
            if (difference == 0) {
                if (enqueuePosition_.compare_exchange_weak(
                        position, position + 1, std::memory_order_relaxed,
                        std::memory_order_relaxed)) {
                    reserved = true;
                    break;
                }
            } else if (difference < 0) {
                return false;
            } else {
                position = enqueuePosition_.load(std::memory_order_relaxed);
            }
        }
        // Reaching the retry budget means this producer never owns a slot.
        if (!reserved) return false;

        slot->value = value;
        slot->sequence.store(position + 1, std::memory_order_release);
        return true;
    }

    /** Returns false immediately when the queue is empty or its head is not published yet. */
    bool tryPop(T& value) noexcept {
        size_t position = dequeuePosition_.load(std::memory_order_relaxed);
        Slot* slot = nullptr;
        bool reserved = false;
        for (unsigned attempt = 0; attempt < kMaxCasAttempts; ++attempt) {
            slot = &slots_[position & (Capacity - 1)];
            const size_t sequence = slot->sequence.load(std::memory_order_acquire);
            const auto difference = static_cast<std::intptr_t>(sequence)
                - static_cast<std::intptr_t>(position + 1);
            if (difference == 0) {
                if (dequeuePosition_.compare_exchange_weak(
                        position, position + 1, std::memory_order_relaxed,
                        std::memory_order_relaxed)) {
                    reserved = true;
                    break;
                }
            } else if (difference < 0) {
                return false;
            } else {
                position = dequeuePosition_.load(std::memory_order_relaxed);
            }
        }
        if (!reserved) return false;

        value = slot->value;
        slot->sequence.store(position + Capacity, std::memory_order_release);
        return true;
    }

private:
    std::array<Slot, Capacity> slots_{};
    alignas(64) std::atomic<size_t> enqueuePosition_{0};
    alignas(64) std::atomic<size_t> dequeuePosition_{0};
};

} // namespace resostage
