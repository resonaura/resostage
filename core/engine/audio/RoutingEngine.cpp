#include "RoutingEngine.h"

namespace resostage {

RoutingEngine::RoutingEngine() = default;
RoutingEngine::~RoutingEngine() = default;

void RoutingEngine::publish(std::unique_ptr<RoutingSnapshot> next) {
    std::atomic_store_explicit(&active, std::shared_ptr<const RoutingSnapshot>(std::move(next)),
                                std::memory_order_release);
}

std::shared_ptr<const RoutingSnapshot> RoutingEngine::acquireForRender() {
    return std::atomic_load_explicit(&active, std::memory_order_acquire);
}

} // namespace resostage
