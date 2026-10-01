/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "events/BoundedMpmcQueue.h"

#include <algorithm>
#include <atomic>
#include <thread>
#include <vector>

using namespace resostage;

namespace {
struct Message {
    uint32_t producer = 0;
    uint32_t sequence = 0;
};
}

TEST_CASE("BoundedMpmcQueue rejects writes when full and recovers after reads") {
    BoundedMpmcQueue<Message, 4> queue;
    for (uint32_t i = 0; i < 4; ++i)
        CHECK(queue.tryPush({0, i}));
    CHECK_FALSE(queue.tryPush({0, 4}));

    Message item;
    for (uint32_t i = 0; i < 4; ++i) {
        REQUIRE(queue.tryPop(item));
        CHECK(item.sequence == i);
    }
    CHECK_FALSE(queue.tryPop(item));
    CHECK(queue.tryPush({1, 0}));
}

TEST_CASE("BoundedMpmcQueue preserves concurrent producer messages") {
    constexpr uint32_t producerCount = 4;
    constexpr uint32_t messagesPerProducer = 20'000;
    constexpr uint32_t totalMessages = producerCount * messagesPerProducer;
    BoundedMpmcQueue<Message, 256> queue;
    std::vector<uint8_t> seen(static_cast<size_t>(producerCount) * messagesPerProducer, 0);
    std::atomic<uint32_t> completedProducers{0};
    std::atomic<bool> corrupt{false};
    std::vector<std::thread> producers;
    producers.reserve(producerCount);

    for (uint32_t producer = 0; producer < producerCount; ++producer) {
        producers.emplace_back([&, producer] {
            for (uint32_t sequence = 0; sequence < messagesPerProducer; ++sequence) {
                const Message message{producer, sequence};
                while (!queue.tryPush(message))
                    std::this_thread::yield();
            }
            completedProducers.fetch_add(1, std::memory_order_release);
        });
    }

    uint32_t consumed = 0;
    while (consumed < totalMessages) {
        Message message;
        if (!queue.tryPop(message)) {
            if (completedProducers.load(std::memory_order_acquire) == producerCount
                && consumed < totalMessages) {
                std::this_thread::yield();
            }
            continue;
        }

        if (message.producer >= producerCount || message.sequence >= messagesPerProducer) {
            corrupt.store(true, std::memory_order_relaxed);
        } else {
            const size_t index = static_cast<size_t>(message.producer) * messagesPerProducer
                + message.sequence;
            if (seen[index] != 0)
                corrupt.store(true, std::memory_order_relaxed);
            seen[index] = 1;
        }
        ++consumed;
    }

    for (auto& producer : producers)
        producer.join();

    CHECK_FALSE(corrupt.load(std::memory_order_relaxed));
    CHECK(std::all_of(seen.begin(), seen.end(), [](uint8_t value) { return value == 1; }));
}
