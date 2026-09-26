#include "RoutingEngine.h"

namespace resostage {

RoutingEngine::RoutingEngine() = default;
RoutingEngine::~RoutingEngine() = default;

void RoutingEngine::publish(std::shared_ptr<const MixGraph> next) {
    std::atomic_store_explicit(&active, std::move(next), std::memory_order_release);
}

std::shared_ptr<const MixGraph> RoutingEngine::acquireForRender() {
    return std::atomic_load_explicit(&active, std::memory_order_acquire);
}

} // namespace resostage
