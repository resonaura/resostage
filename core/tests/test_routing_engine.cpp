/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "audio/graph/RoutingEngine.h"

#include <atomic>
#include <thread>
#include <vector>

using namespace resostage;

namespace {

// A graph small enough to build in a tight loop, distinctive enough that a
// torn or freed read is detectable.
std::shared_ptr<const MixGraph> makeGraph(uint32_t marker) {
    auto graph = std::make_shared<MixGraph>();
    MixStrip strip;
    strip.id = "audio::main";
    strip.kind = StripKind::Main;
    strip.projectIndex = marker;
    graph->strips.push_back(strip);

    MixStrip lane;
    lane.id = "audio::out:1";
    lane.kind = StripKind::OutputLane;
    lane.channels = 1;
    lane.physicalChannel = 0;
    lane.projectIndex = marker;
    graph->strips.push_back(lane);

    graph->indexById["audio::main"] = 0;
    graph->indexById["audio::out:1"] = 1;
    graph->firstLaneStrip = 1;

    MixEdge edge;
    edge.from = 0;
    edge.to = 1;
    graph->edges.push_back(edge);
    return graph;
}

} // namespace

TEST_CASE("RoutingEngine: no publish yet reads as null rather than a stale graph") {
    RoutingEngine engine;
    CHECK(engine.acquireForRender().get() == nullptr);
}

TEST_CASE("RoutingEngine: acquireForRender sees the most recent publish") {
    RoutingEngine engine;
    engine.publish(makeGraph(1));
    {
        auto held = engine.acquireForRender();
        REQUIRE(held.get() != nullptr);
        CHECK(held->strips[0].projectIndex == 1);
    }
    engine.publish(makeGraph(2));
    auto held = engine.acquireForRender();
    REQUIRE(held.get() != nullptr);
    CHECK(held->strips[0].projectIndex == 2);
}

TEST_CASE("RoutingEngine: a reader's graph stays alive across later publishes") {
    RoutingEngine engine;
    engine.publish(makeGraph(7));

    // The audio thread holds its snapshot for the whole block; the message
    // thread may republish several times meanwhile. The held graph must keep
    // reading back as itself -- this is the use-after-free the hand-rolled
    // hazard-pointer versions kept getting wrong.
    auto held = engine.acquireForRender();
    REQUIRE(held.get() != nullptr);
    for (uint32_t i = 0; i < 100; ++i)
        engine.publish(makeGraph(i));

    CHECK(held->strips[0].projectIndex == 7);
    CHECK(held->strips.size() == 2);
    CHECK(held->edges.size() == 1);
}

TEST_CASE("RoutingEngine: concurrent publish and render never tear or free early") {
    RoutingEngine engine;
    engine.publish(makeGraph(0));

    std::atomic<bool> stop{false};
    std::atomic<int> mismatches{0};

    std::thread writer([&] {
        for (uint32_t i = 1; i < 20000 && !stop.load(); ++i)
            engine.publish(makeGraph(i));
        stop.store(true);
    });

    std::thread reader([&] {
        while (!stop.load()) {
            auto held = engine.acquireForRender();
            if (held.get() == nullptr)
                continue;
            // Every strip in a given graph carries the same marker, so a torn
            // read shows up as two strips disagreeing.
            if (held->strips.size() != 2
                || held->strips[0].projectIndex != held->strips[1].projectIndex
                || held->edges.size() != 1) {
                mismatches.fetch_add(1);
            }
        }
    });

    writer.join();
    reader.join();
    CHECK(mismatches.load() == 0);
}

TEST_CASE("RoutingEngine: reclaim cleans up retired graphs on the message thread after audio drops reference") {
    RoutingEngine engine;
    auto g1 = makeGraph(1);
    std::weak_ptr<const MixGraph> weakG1 = g1;
    engine.publish(g1);
    g1.reset();

    // Acquire for render on simulated audio thread
    auto audioHeld = engine.acquireForRender();
    REQUIRE(audioHeld != nullptr);
    CHECK(audioHeld->strips[0].projectIndex == 1);
    CHECK(weakG1.use_count() == 2); // 1 in engine.active, 1 in audioHeld

    // Message thread publishes graph 2
    auto g2 = makeGraph(2);
    engine.publish(g2);
    g2.reset();

    // Now g1 is in retiredGraphs, but still referenced by audioHeld
    CHECK_FALSE(weakG1.expired());
    CHECK(weakG1.use_count() == 2); // 1 in retiredGraphs, 1 in audioHeld

    // Reclaim while audio thread still holds it: should NOT reclaim g1
    engine.reclaim();
    CHECK_FALSE(weakG1.expired());
    CHECK(weakG1.use_count() == 2);

    // Audio thread finishes and drops its reference
    audioHeld.reset();
    CHECK(weakG1.use_count() == 1); // Only held by retiredGraphs

    // Now message thread calls reclaim(): g1 is safely erased and destroyed
    engine.reclaim();
    CHECK(weakG1.expired());
}
