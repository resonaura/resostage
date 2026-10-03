/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <atomic>
#include <cstddef>
#include <string_view>

namespace resostage::command_body {

// Note/point edits contain whole bounded collections, unlike scalar controls.
// Media/project bytes are streamed separately and never enter this accumulator.
inline constexpr std::size_t kScalarLimit = 64 * 1024;
inline constexpr std::size_t kMidiLimit = 16 * 1024 * 1024;
inline constexpr std::size_t kAutomationLimit = 4 * 1024 * 1024;
inline constexpr std::size_t kQueueLimit = 32 * 1024 * 1024;
inline constexpr std::size_t kMaximumQueuedCommands = 1024;

constexpr std::size_t limitForPath(std::string_view path) noexcept {
    if (path == "/api/v1/builder/midi-region/add"
        || path == "/api/v1/builder/midi-region/update") return kMidiLimit;
    if (path == "/api/v1/builder/automation-lane/add"
        || path == "/api/v1/builder/automation-points/replace"
        || path == "/api/v1/builder/automation/record-gesture") return kAutomationLimit;
    return kScalarLimit;
}

constexpr bool canAppend(std::size_t held, std::size_t incoming,
                         std::size_t limit) noexcept {
    return held <= limit && incoming <= limit - held;
}

/** Admission accounting, shared by network producer and message-thread consumer.
 * No project mutation or realtime work happens here. A large editor command
 * cannot multiply into an unbounded queue, and rejection leaves the budget intact.
 */
class ByteBudget {
public:
    bool reserve(std::size_t size) noexcept {
        auto current = bytes.load(std::memory_order_relaxed);
        do {
            if (!canAppend(current, size, kQueueLimit)) return false;
        } while (!bytes.compare_exchange_weak(current, current + size,
                                              std::memory_order_relaxed));
        return true;
    }
    void release(std::size_t size) noexcept { bytes.fetch_sub(size, std::memory_order_relaxed); }
    std::size_t used() const noexcept { return bytes.load(std::memory_order_relaxed); }
private:
    std::atomic<std::size_t> bytes{0};
};

/** Reserves both bounded payload bytes and a fixed command slot before queueing. */
class CommandAdmissionBudget {
public:
    bool reserve(std::size_t size) noexcept {
        auto current = commands.load(std::memory_order_relaxed);
        do {
            if (current >= kMaximumQueuedCommands)
                return false;
        } while (!commands.compare_exchange_weak(current, current + 1,
                                                  std::memory_order_relaxed));

        if (bytes.reserve(size))
            return true;

        commands.fetch_sub(1, std::memory_order_relaxed);
        return false;
    }

    void release(std::size_t size) noexcept {
        bytes.release(size);
        commands.fetch_sub(1, std::memory_order_relaxed);
    }

    std::size_t usedBytes() const noexcept { return bytes.used(); }
    std::size_t usedCommands() const noexcept {
        return commands.load(std::memory_order_relaxed);
    }

private:
    ByteBudget bytes;
    std::atomic<std::size_t> commands{0};
};

} // namespace resostage::command_body
