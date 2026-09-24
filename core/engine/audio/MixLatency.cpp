#include "MixLatency.h"

#include <algorithm>
#include <limits>

namespace resostage {
namespace {

uint32_t saturatingAdd(uint32_t left, uint32_t right) {
    const uint64_t sum = static_cast<uint64_t>(left) + right;
    return static_cast<uint32_t>(
        std::min<uint64_t>(sum, std::numeric_limits<uint32_t>::max()));
}

} // namespace

MixLatencyPlan buildMixLatencyPlan(
    const MixGraph& graph,
    const std::vector<uint32_t>& stripProcessorLatencySamples) {
    MixLatencyPlan plan;
    plan.edgeDelaySamples.assign(graph.edges.size(), 0);
    plan.stripOutputLatencySamples.assign(graph.strips.size(), 0);
    std::vector<uint32_t> stripInputLatencySamples(graph.strips.size(), 0);

    // The graph is topologically ordered. By the time a destination is
    // visited, every source path latency is final.
    size_t edgeCursor = 0;
    for (uint32_t strip = 0; strip < graph.strips.size(); ++strip) {
        uint32_t inputLatency = 0;
        while (edgeCursor < graph.edges.size()
               && graph.edges[edgeCursor].to == strip) {
            const auto& edge = graph.edges[edgeCursor++];
            if (edge.from < plan.stripOutputLatencySamples.size()) {
                inputLatency = std::max(
                    inputLatency,
                    plan.stripOutputLatencySamples[edge.from]);
            }
        }
        stripInputLatencySamples[strip] = inputLatency;
        const uint32_t processorLatency =
            strip < stripProcessorLatencySamples.size()
                ? stripProcessorLatencySamples[strip]
                : 0;
        plan.stripOutputLatencySamples[strip] =
            saturatingAdd(inputLatency, processorLatency);
        plan.maximumOutputLatencySamples = std::max(
            plan.maximumOutputLatencySamples,
            plan.stripOutputLatencySamples[strip]);
    }

    for (size_t edgeIndex = 0; edgeIndex < graph.edges.size(); ++edgeIndex) {
        const auto& edge = graph.edges[edgeIndex];
        if (edge.from >= plan.stripOutputLatencySamples.size()
            || edge.to >= stripInputLatencySamples.size()) {
            continue;
        }
        const uint32_t sourceLatency =
            plan.stripOutputLatencySamples[edge.from];
        const uint32_t destinationLatency =
            stripInputLatencySamples[edge.to];
        plan.edgeDelaySamples[edgeIndex] =
            destinationLatency > sourceLatency
                ? destinationLatency - sourceLatency
                : 0;
    }
    return plan;
}

} // namespace resostage
