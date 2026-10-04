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
 * Immutable endpoint-specific PDC plan. Mutable rings have exactly one
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
        const PluginDelayBank* previousDelayBank = nullptr,
        const std::vector<std::vector<uint32_t>>& stripPluginSlotLatencySamples = {},
        uint32_t maximumBlockSize = 512);

    PluginDelayBank(const PluginDelayBank&) = delete;
    PluginDelayBank& operator=(const PluginDelayBank&) = delete;

    void applyTo(MixProcessorView& view) const noexcept;
    int latencySamples() const noexcept { return maximumLatencySamples; }

private:
    struct EdgeDelayLine;
    struct SidechainDelayLine;
    struct StripInputIdentity {
        std::string stripId;
        bool operator<(const StripInputIdentity& other) const noexcept;
    };
    struct EdgeIdentity {
        std::string fromStripId;
        std::string toStripId;
        uint32_t sendIndex = MixEdge::kNoSend;
        uint8_t tap = 0;
        int8_t sourceChannel = -1;
        bool preFader = false;
        bool operator<(const EdgeIdentity& other) const noexcept;
    };
    struct SidechainIdentity {
        std::string fromStripId;
        std::string toStripId;
        std::string pluginSlotId;
        uint32_t pluginSlotIndex = 0;
        uint32_t inputBusIndex = 1;
        uint8_t channelMode = 0;
        bool operator<(const SidechainIdentity& other) const noexcept;
    };

    PluginDelayBank() = default;
    static void processEdgeDelay(void* context,
                                 const float* inputLeft,
                                 const float* inputRight,
                                 float* outputLeft,
                                 float* outputRight,
                                 int numSamples,
                                 bool inputEnabled) noexcept;
    static void processSidechainDelay(
        void* context, const float* inputLeft, const float* inputRight,
        int numSamples, bool inputEnabled, const float** outputLeft,
        const float** outputRight) noexcept;

    std::vector<std::shared_ptr<EdgeDelayLine>> edgeDelayLines;
    std::vector<MixEdgeDelay> edgeDelayEntries;
    std::vector<EdgeIdentity> edgeIdentities;
    std::vector<std::shared_ptr<EdgeDelayLine>> stripInputDelayLines;
    std::vector<MixEdgeDelay> stripInputDelayEntries;
    std::vector<StripInputIdentity> stripInputIdentities;
    std::vector<std::shared_ptr<SidechainDelayLine>> sidechainDelayLines;
    std::vector<MixSidechainEdgeDelay> sidechainDelayEntries;
    std::vector<SidechainIdentity> sidechainIdentities;
    std::vector<uint32_t> stripOutputLatencySamples;
    int maximumLatencySamples = 0;
    double preparedSampleRate = 48000.0;
};

} // namespace resostage
