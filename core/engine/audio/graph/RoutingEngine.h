/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "MixGraph.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

namespace resostage {

class RoutingEngine {
public:
    RoutingEngine();
    ~RoutingEngine();

    RoutingEngine(const RoutingEngine&) = delete;
    RoutingEngine& operator=(const RoutingEngine&) = delete;

    // Called from the message/UI thread. Takes ownership of the graph.
    // Retires previous graphs and reclaims any whose audio-thread reference
    // has completed (use_count == 1).
    void publish(std::shared_ptr<const MixGraph> next);

    // Called from the audio thread. Returns a shared_ptr keeping the
    // snapshot alive for the duration of the callback.
    // Guaranteed non-deallocating: the retirement queue retains a reference
    // so the audio thread's local shared_ptr NEVER drops the refcount to 0.
    std::shared_ptr<const MixGraph> acquireForRender();

    // Reclaims retired graphs whose audio-thread references have finished.
    // Runs exclusively on the message thread.
    void reclaim() noexcept;

private:
    void reclaimRetired() noexcept;

    std::shared_ptr<const MixGraph> active;
    std::vector<std::shared_ptr<const MixGraph>> retiredGraphs;
};

} // namespace resostage
