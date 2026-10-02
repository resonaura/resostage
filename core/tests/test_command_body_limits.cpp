/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"
#include "server/CommandBodyLimits.h"
#include <limits>
#include <thread>

using namespace resostage::command_body;

TEST_CASE("HTTP editor bodies accept substantial note and automation collections") {
    CHECK(limitForPath("/api/v1/builder/midi-region/add") == kMidiLimit);
    CHECK(limitForPath("/api/v1/builder/midi-region/update") == kMidiLimit);
    CHECK(limitForPath("/api/v1/builder/automation-points/replace") == kAutomationLimit);
    CHECK(limitForPath("/api/v1/transport/play") == kScalarLimit);
    CHECK(canAppend(4096, 8192, kMidiLimit));
    CHECK(canAppend(kAutomationLimit - 1, 1, kAutomationLimit));
    CHECK_FALSE(canAppend(kAutomationLimit, 1, kAutomationLimit));
    CHECK_FALSE(canAppend(10, std::numeric_limits<std::size_t>::max(), kMidiLimit));
    CHECK_FALSE(canAppend(kMidiLimit + 1, 0, kMidiLimit));
}

TEST_CASE("Command byte admission is bounded and recovers after dequeue or rejection") {
    ByteBudget budget;
    REQUIRE(budget.reserve(kMidiLimit));
    REQUIRE(budget.reserve(kMidiLimit));
    CHECK_FALSE(budget.reserve(1));
    CHECK(budget.used() == kQueueLimit);
    budget.release(kMidiLimit);
    CHECK_FALSE(budget.reserve(std::numeric_limits<std::size_t>::max()));
    REQUIRE(budget.reserve(1024));
    budget.release(1024);
    budget.release(kMidiLimit);
    CHECK(budget.used() == 0);
    std::thread producer([&] {
        for (int i = 0; i < 10000; ++i) {
            if (budget.reserve(1024)) budget.release(1024);
        }
    });
    for (int i = 0; i < 10000; ++i) {
        if (budget.reserve(1024)) budget.release(1024);
    }
    producer.join();
    CHECK(budget.used() == 0);
}
