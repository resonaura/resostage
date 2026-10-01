/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "audio/graph/MixGraph.h"
#include "audio/graph/MixRenderer.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace resostage {


/**
 * Immutable graph-topology-specific PDC plan. Mutable rings have exactly one
 * audio owner across compatible publications. Build/destroy off audio; pass a
 * previous plan only from that same render session, never another renderer.
 * Unchanged delays share history; changed delays refill from zero without
 * reading the audio owner's mutable samples.
 */
class PluginDelayBank final {
public:
    static std::shared_ptr<PluginDelayBank> build(
        const MixGraph& graph,
        const std::vector<uint32_t>& stripProcessorLatencySamples,
        double sampleRate,
        std::vector<std::string>& warnings,
        const PluginDelayBank* previousDelayBank = nullptr);

    PluginDelayBank(const PluginDelayBank&) = delete;
    PluginDelayBank& operator=(const PluginDelayBank&) = delete;

    void applyTo(MixProcessorView& view) const noexcept;
    int latencySamples() const noexcept { return maximumLatencySamples; }

private:
    struct EdgeDelayLine;

    PluginDelayBank() = default;
    static void processEdgeDelay(void* context,
                                 const float* inputLeft,
                                 const float* inputRight,
                                 float* outputLeft,
                                 float* outputRight,
                                 int numSamples,
                                 bool inputEnabled) noexcept;

    std::vector<std::shared_ptr<EdgeDelayLine>> edgeDelayLines;
    std::vector<MixEdgeDelay> edgeDelayEntries;
    std::vector<uint32_t> stripOutputLatencySamples;
    int maximumLatencySamples = 0;
    uint64_t routingLayoutKey = 0;
    double preparedSampleRate = 48000.0;
};

} // namespace resostage
