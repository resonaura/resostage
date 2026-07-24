#include "doctest.h"

#include "audio/RoutingEngine.h"

#include <atomic>
#include <memory>
#include <thread>

using namespace resoset;

TEST_CASE("RoutingEngine starts empty and round-trips a single published snapshot") {
    RoutingEngine engine;
    CHECK(engine.acquireForRender() == nullptr);

    auto snap = std::make_unique<RoutingSnapshot>();
    snap->routes.push_back(TrackRoute{0, 0, 1.0f, 0.0f, false});
    snap->outputs.push_back(BusOutput{0, 0, 2, 1.0f, false});
    snap->busCount = 1;

    engine.publish(std::move(snap));

    const RoutingSnapshot* acquired = engine.acquireForRender();
    REQUIRE(acquired != nullptr);
    REQUIRE(acquired->routes.size() == 1);
    CHECK(acquired->routes[0].trackIndex == 0);
    CHECK(acquired->busCount == 1);
}

TEST_CASE("RoutingEngine survives concurrent publish/acquire without torn reads") {
    // Simulates the real usage pattern: one writer thread (message/UI thread)
    // publishing new routing configs while a reader thread (standing in for
    // the audio thread) repeatedly acquires and reads the active snapshot.
    // Each published snapshot is internally tagged so any inconsistency (a
    // route not matching its snapshot's generation) would indicate a torn or
    // use-after-free read -- worth running under ThreadSanitizer.
    RoutingEngine engine;
    std::atomic<bool> corruptionDetected{false};
    std::atomic<int> readsChecked{0};

    constexpr uint32_t kGenerations = 20000;

    std::thread writer([&] {
        for (uint32_t generation = 1; generation <= kGenerations; ++generation) {
            auto snap = std::make_unique<RoutingSnapshot>();
            const int numRoutes = static_cast<int>((generation % 5) + 1);
            for (int i = 0; i < numRoutes; ++i)
                snap->routes.push_back(TrackRoute{generation, 0, 1.0f, 0.0f, false});
            snap->busCount = generation;
            engine.publish(std::move(snap));
        }
    });

    std::thread reader([&] {
        uint32_t lastSeenGeneration = 0;
        while (lastSeenGeneration < kGenerations) {
            const RoutingSnapshot* snap = engine.acquireForRender();
            if (snap != nullptr) {
                for (const auto& route : snap->routes) {
                    if (route.trackIndex != snap->busCount)
                        corruptionDetected.store(true, std::memory_order_relaxed);
                }
                lastSeenGeneration = snap->busCount;
                readsChecked.fetch_add(1, std::memory_order_relaxed);
            }
        }
    });

    writer.join();
    reader.join();

    CHECK_FALSE(corruptionDetected.load());
    CHECK(readsChecked.load() > 0);
}
