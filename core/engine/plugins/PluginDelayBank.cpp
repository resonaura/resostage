/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "PluginDelayBank.h"

#include "audio/graph/MixLatency.h"

#include <algorithm>
#include <atomic>
#include <climits>
#include <map>
#include <new>
#include <tuple>
#include <type_traits>

namespace resostage {
namespace {
// A broken or malicious latency report can request arbitrary delay memory,
// multiplied by every faster input in a dense graph. Above either bound,
// disable compensation as one plan rather than partially aligning the mix.
constexpr uint64_t kMaximumDelayMemoryBytes = 128ull * 1024ull * 1024ull;
constexpr double kMaximumCompensatedSeconds = 10.0;

std::string stripIdentity(const MixGraph& graph, uint32_t index) {
    if (index < graph.strips.size() && !graph.strips[index].id.empty())
        return graph.strips[index].id;
    return "#strip:" + std::to_string(index);
}

} // namespace

struct PluginDelayBank::EdgeDelayLine {
    explicit EdgeDelayLine(uint32_t delaySamples)
        : left(delaySamples, 0.0f), right(delaySamples, 0.0f) {}

    std::vector<float> left;
    std::vector<float> right;
    std::atomic<uint32_t> cursor{0};
};

struct PluginDelayBank::SidechainDelayLine {
    SidechainDelayLine(uint32_t delaySamples, uint32_t maximumBlockSize)
        : left(delaySamples, 0.0f), right(delaySamples, 0.0f),
          outputLeft(maximumBlockSize, 0.0f),
          outputRight(maximumBlockSize, 0.0f) {}

    std::vector<float> left;
    std::vector<float> right;
    // Each auxiliary feed must remain available until its target slot is
    // reached later in the destination chain, so its delayed block is owned
    // by the prepared line rather than shared renderer scratch.
    std::vector<float> outputLeft;
    std::vector<float> outputRight;
    std::atomic<uint32_t> cursor{0};
};

bool PluginDelayBank::StripInputIdentity::operator<(
    const StripInputIdentity& other) const noexcept {
    return stripId < other.stripId;
}

bool PluginDelayBank::EdgeIdentity::operator<(
    const EdgeIdentity& other) const noexcept {
    return std::tie(fromStripId, toStripId, sendIndex, tap, sourceChannel,
                    preFader)
        < std::tie(other.fromStripId, other.toStripId, other.sendIndex,
                   other.tap, other.sourceChannel, other.preFader);
}

bool PluginDelayBank::SidechainIdentity::operator<(
    const SidechainIdentity& other) const noexcept {
    return std::tie(fromStripId, toStripId, pluginSlotId, pluginSlotIndex,
                    inputBusIndex, channelMode)
        < std::tie(other.fromStripId, other.toStripId, other.pluginSlotId,
                   other.pluginSlotIndex, other.inputBusIndex,
                   other.channelMode);
}

void PluginDelayBank::applyTo(MixProcessorView& view) const noexcept {
    view.edgeDelays = edgeDelayEntries.data();
    view.edgeDelayCount = edgeDelayEntries.size();
    view.stripOutputLatencySamples = stripOutputLatencySamples.data();
    view.stripOutputLatencyCount = stripOutputLatencySamples.size();
    view.stripInputDelays = stripInputDelayEntries.data();
    view.stripInputDelayCount = stripInputDelayEntries.size();
    view.sidechainEdgeDelays = sidechainDelayEntries.data();
    view.sidechainEdgeDelayCount = sidechainDelayEntries.size();
}

void PluginDelayBank::processEdgeDelay(
    void* context, const float* inputLeft, const float* inputRight,
    float* outputLeft, float* outputRight, int numSamples,
    bool inputEnabled) noexcept {
    auto& delay = *static_cast<EdgeDelayLine*>(context);
    const uint32_t length = static_cast<uint32_t>(delay.left.size());
    if (length == 0)
        return;
    uint32_t cursor = delay.cursor.load(std::memory_order_relaxed);
    for (int sample = 0; sample < numSamples; ++sample) {
        outputLeft[sample] = delay.left[cursor];
        outputRight[sample] = delay.right[cursor];
        delay.left[cursor] = inputEnabled ? inputLeft[sample] : 0.0f;
        delay.right[cursor] = inputEnabled ? inputRight[sample] : 0.0f;
        if (++cursor == length)
            cursor = 0;
    }
    delay.cursor.store(cursor, std::memory_order_relaxed);
}

void PluginDelayBank::processSidechainDelay(
    void* context, const float* inputLeft, const float* inputRight,
    int numSamples, bool inputEnabled, const float** outputLeft,
    const float** outputRight) noexcept {
    auto& delay = *static_cast<SidechainDelayLine*>(context);
    const uint32_t length = static_cast<uint32_t>(delay.left.size());
    uint32_t cursor = delay.cursor.load(std::memory_order_relaxed);
    for (int sample = 0; sample < numSamples; ++sample) {
        delay.outputLeft[static_cast<size_t>(sample)] = delay.left[cursor];
        delay.outputRight[static_cast<size_t>(sample)] = delay.right[cursor];
        delay.left[cursor] = inputEnabled ? inputLeft[sample] : 0.0f;
        delay.right[cursor] = inputEnabled ? inputRight[sample] : 0.0f;
        if (++cursor == length)
            cursor = 0;
    }
    delay.cursor.store(cursor, std::memory_order_relaxed);
    *outputLeft = delay.outputLeft.data();
    *outputRight = delay.outputRight.data();
}

std::shared_ptr<PluginDelayBank> PluginDelayBank::build(
    const MixGraph& graph,
    const std::vector<uint32_t>& stripProcessorLatencySamples,
    double sampleRate,
    std::vector<std::string>& warnings,
    const PluginDelayBank* previousDelayBank,
    const std::vector<std::vector<uint32_t>>& stripPluginSlotLatencySamples,
    uint32_t maximumBlockSize) {
    auto bank = std::shared_ptr<PluginDelayBank>(new PluginDelayBank());
    const MixLatencyPlan latencyPlan = buildMixLatencyPlan(
        graph, stripProcessorLatencySamples, stripPluginSlotLatencySamples);
    if (std::find(latencyPlan.sidechainAlignmentUnavailable.begin(),
                  latencyPlan.sidechainAlignmentUnavailable.end(), true)
        != latencyPlan.sidechainAlignmentUnavailable.end()) {
        warnings.push_back(
            "Sidechain PDC cannot delay generated instrument audio between inserts; a late source remains uncompensated");
    }
    bank->preparedSampleRate = sampleRate;
    bank->maximumLatencySamples = static_cast<int>(std::min<uint32_t>(
        latencyPlan.maximumOutputLatencySamples,
        static_cast<uint32_t>(INT_MAX)));
    bank->stripOutputLatencySamples = latencyPlan.stripOutputLatencySamples;
    bank->edgeDelayLines.resize(graph.edges.size());
    bank->edgeDelayEntries.resize(graph.edges.size());
    bank->edgeIdentities.reserve(graph.edges.size());
    bank->stripInputDelayLines.resize(graph.strips.size());
    bank->stripInputDelayEntries.resize(graph.strips.size());
    bank->stripInputIdentities.reserve(graph.strips.size());
    bank->sidechainDelayLines.resize(graph.sidechainEdges.size());
    bank->sidechainDelayEntries.resize(graph.sidechainEdges.size());
    bank->sidechainIdentities.reserve(graph.sidechainEdges.size());

    uint64_t delayMemoryBytes = 0;
    const auto addRingBytes = [&delayMemoryBytes](uint32_t delaySamples) {
        delayMemoryBytes += static_cast<uint64_t>(delaySamples)
                            * 2ull * sizeof(float);
    };
    for (const uint32_t delaySamples : latencyPlan.stripInputDelaySamples)
        addRingBytes(delaySamples);
    for (const uint32_t delaySamples : latencyPlan.edgeDelaySamples)
        addRingBytes(delaySamples);
    const uint32_t blockCapacity = std::max(1u, maximumBlockSize);
    for (const uint32_t delaySamples : latencyPlan.sidechainEdgeDelaySamples) {
        addRingBytes(delaySamples);
        if (delaySamples > 0)
            delayMemoryBytes += static_cast<uint64_t>(blockCapacity)
                                * 2ull * sizeof(float);
    }

    const uint64_t maximumLatencySamples = static_cast<uint64_t>(
        std::max(1.0, sampleRate) * kMaximumCompensatedSeconds);
    const bool latencyInRange =
        latencyPlan.maximumOutputLatencySamples <= maximumLatencySamples;
    const bool memoryInRange = delayMemoryBytes <= kMaximumDelayMemoryBytes;
    if (!latencyInRange || !memoryInRange) {
        warnings.push_back(
            !latencyInRange
                ? "Plug-in delay compensation exceeds the 10 second safety bound"
                : "Plug-in delay compensation exceeds the 128 MiB memory budget");
        bank->stripOutputLatencySamples.assign(graph.strips.size(), 0);
        bank->maximumLatencySamples = 0;
        return bank;
    }

    try {
        std::map<StripInputIdentity, size_t> previousStripInputs;
        std::map<EdgeIdentity, size_t> previousEdges;
        std::map<SidechainIdentity, size_t> previousSidechains;
        const bool sameSessionRate = previousDelayBank != nullptr
            && previousDelayBank->preparedSampleRate == sampleRate;
        if (sameSessionRate) {
            for (size_t index = 0;
                 index < previousDelayBank->stripInputIdentities.size(); ++index)
                previousStripInputs.emplace(
                    previousDelayBank->stripInputIdentities[index], index);
            for (size_t index = 0;
                 index < previousDelayBank->edgeIdentities.size(); ++index)
                previousEdges.emplace(previousDelayBank->edgeIdentities[index],
                                      index);
            for (size_t index = 0;
                 index < previousDelayBank->sidechainIdentities.size(); ++index)
                previousSidechains.emplace(
                    previousDelayBank->sidechainIdentities[index], index);
        }

        const auto shareUnchanged = [](const auto& previousLines,
                                       const auto& previousIndex,
                                       const auto& identity,
                                       uint32_t delaySamples) {
            using LinePointer = typename std::decay_t<decltype(previousLines)>::value_type;
            LinePointer line;
            const auto match = previousIndex.find(identity);
            if (match != previousIndex.end()
                && match->second < previousLines.size()) {
                const auto& previous = previousLines[match->second];
                if (previous != nullptr
                    && previous->left.size() == delaySamples)
                    line = previous;
            }
            return line;
        };

        bank->stripInputIdentities.reserve(graph.strips.size());
        for (size_t strip = 0; strip < graph.strips.size(); ++strip) {
            StripInputIdentity identity{stripIdentity(
                graph, static_cast<uint32_t>(strip))};
            bank->stripInputIdentities.push_back(identity);
            const uint32_t delaySamples =
                latencyPlan.stripInputDelaySamples[strip];
            if (delaySamples == 0)
                continue;
            std::shared_ptr<EdgeDelayLine> delay;
            if (sameSessionRate)
                delay = shareUnchanged(previousDelayBank->stripInputDelayLines,
                                       previousStripInputs, identity,
                                       delaySamples);
            if (delay == nullptr)
                delay = std::make_shared<EdgeDelayLine>(delaySamples);
            bank->stripInputDelayEntries[strip] =
                {delay.get(), processEdgeDelay};
            bank->stripInputDelayLines[strip] = std::move(delay);
        }

        for (size_t edgeIndex = 0; edgeIndex < graph.edges.size(); ++edgeIndex) {
            const auto& edge = graph.edges[edgeIndex];
            EdgeIdentity identity{
                stripIdentity(graph, edge.from),
                stripIdentity(graph, edge.to),
                edge.sendIndex,
                static_cast<uint8_t>(edge.tap),
                edge.sourceChannel,
                edge.preFader};
            bank->edgeIdentities.push_back(identity);
            const uint32_t delaySamples =
                latencyPlan.edgeDelaySamples[edgeIndex];
            if (delaySamples == 0)
                continue;
            std::shared_ptr<EdgeDelayLine> delay;
            if (sameSessionRate)
                delay = shareUnchanged(previousDelayBank->edgeDelayLines,
                                       previousEdges, identity, delaySamples);
            if (delay == nullptr)
                delay = std::make_shared<EdgeDelayLine>(delaySamples);
            bank->edgeDelayEntries[edgeIndex] =
                {delay.get(), processEdgeDelay};
            bank->edgeDelayLines[edgeIndex] = std::move(delay);
        }

        for (size_t edgeIndex = 0;
             edgeIndex < graph.sidechainEdges.size(); ++edgeIndex) {
            const auto& edge = graph.sidechainEdges[edgeIndex];
            SidechainIdentity identity{
                stripIdentity(graph, edge.from),
                stripIdentity(graph, edge.to),
                edge.pluginSlotId,
                edge.pluginSlotId.empty() ? edge.pluginSlotIndex : 0,
                edge.inputBusIndex,
                static_cast<uint8_t>(edge.channelMode)};
            bank->sidechainIdentities.push_back(identity);
            const uint32_t delaySamples =
                latencyPlan.sidechainEdgeDelaySamples[edgeIndex];
            if (delaySamples == 0)
                continue;
            std::shared_ptr<SidechainDelayLine> delay;
            if (sameSessionRate) {
                const auto match = previousSidechains.find(identity);
                if (match != previousSidechains.end()
                    && match->second
                        < previousDelayBank->sidechainDelayLines.size()) {
                    const auto& previous =
                        previousDelayBank->sidechainDelayLines[match->second];
                    if (previous != nullptr
                        && previous->left.size() == delaySamples
                        && previous->outputLeft.size() >= blockCapacity)
                        delay = previous;
                }
            }
            if (delay == nullptr)
                delay = std::make_shared<SidechainDelayLine>(
                    delaySamples, blockCapacity);
            bank->sidechainDelayEntries[edgeIndex] =
                {delay.get(), processSidechainDelay};
            bank->sidechainDelayLines[edgeIndex] = std::move(delay);
        }
    } catch (const std::bad_alloc&) {
        bank->edgeDelayEntries.assign(graph.edges.size(), MixEdgeDelay{});
        bank->edgeDelayLines.clear();
        bank->stripInputDelayEntries.assign(graph.strips.size(), MixEdgeDelay{});
        bank->stripInputDelayLines.clear();
        bank->sidechainDelayEntries.assign(
            graph.sidechainEdges.size(), MixSidechainEdgeDelay{});
        bank->sidechainDelayLines.clear();
        bank->stripOutputLatencySamples.assign(graph.strips.size(), 0);
        bank->maximumLatencySamples = 0;
        warnings.push_back(
            "Plug-in delay compensation could not allocate its bounded buffers");
    }
    return bank;
}

} // namespace resostage
