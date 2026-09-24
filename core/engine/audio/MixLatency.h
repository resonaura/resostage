#pragma once

#include "MixGraph.h"

#include <cstdint>
#include <vector>

namespace resostage {

/**
 * Immutable latency map for one MixGraph/processor layout.
 *
 * `edgeDelaySamples` delays the faster inputs of every summing strip to the
 * slowest input. `stripOutputLatencySamples` then describes the compensated
 * post-strip tap. The calculation is pure and allocation is confined to the
 * caller's non-realtime setup path.
 */
struct MixLatencyPlan {
    std::vector<uint32_t> edgeDelaySamples;
    std::vector<uint32_t> stripOutputLatencySamples;
    uint32_t maximumOutputLatencySamples = 0;
};

MixLatencyPlan buildMixLatencyPlan(
    const MixGraph& graph,
    const std::vector<uint32_t>& stripProcessorLatencySamples);

} // namespace resostage
