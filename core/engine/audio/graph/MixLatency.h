/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "MixGraph.h"

#include <cstdint>
#include <vector>

namespace resostage {

/**
 * Immutable latency map for one MixGraph/processor layout.
 *
 * `stripInputDelaySamples`, `edgeDelaySamples`, and
 * `sidechainEdgeDelaySamples` align streamed/direct sources, routed inputs,
 * and plug-in auxiliary inputs at the point they meet. A MIDI instrument's
 * generated audio cannot be shifted by a pre-chain pad; a late sidechain for
 * that path is marked unavailable instead of reporting false alignment.
 * `stripOutputLatencySamples` describes the resulting post-strip tap. The
 * calculation is pure and allocation is confined to non-realtime setup.
 */
struct MixLatencyPlan {
    std::vector<uint32_t> stripInputDelaySamples;
    std::vector<uint32_t> edgeDelaySamples;
    std::vector<uint32_t> sidechainEdgeDelaySamples;
    // True when a late sidechain source would require delaying audio generated
    // by a MIDI instrument between insert slots, which this plan cannot do.
    std::vector<bool> sidechainAlignmentUnavailable;
    std::vector<uint32_t> stripOutputLatencySamples;
    uint32_t maximumOutputLatencySamples = 0;
};

MixLatencyPlan buildMixLatencyPlan(
    const MixGraph& graph,
    const std::vector<uint32_t>& stripProcessorLatencySamples,
    const std::vector<std::vector<uint32_t>>& stripPluginSlotLatencySamples = {});

} // namespace resostage
