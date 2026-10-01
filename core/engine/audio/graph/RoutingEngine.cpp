/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "RoutingEngine.h"

namespace resostage {

RoutingEngine::RoutingEngine() = default;

RoutingEngine::~RoutingEngine() {
    active.reset();
    retiredGraphs.clear();
}

void RoutingEngine::publish(std::shared_ptr<const MixGraph> next) {
    auto previous = std::atomic_exchange_explicit(&active, std::move(next), std::memory_order_acq_rel);
    if (previous != nullptr) {
        retiredGraphs.push_back(std::move(previous));
    }
    reclaimRetired();
}

std::shared_ptr<const MixGraph> RoutingEngine::acquireForRender() {
    return std::atomic_load_explicit(&active, std::memory_order_acquire);
}

void RoutingEngine::reclaim() noexcept {
    reclaimRetired();
}

void RoutingEngine::reclaimRetired() noexcept {
    std::erase_if(retiredGraphs, [](const auto& retired) { return retired.use_count() == 1; });
}

} // namespace resostage
