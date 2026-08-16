#include "doctest.h"

#include "audio/RoutingEngine.h"

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
    REQUIRE(held != nullptr);
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
            if (held == nullptr)
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
