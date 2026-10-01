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
#include <new>

namespace resostage {
namespace {
// A broken or malicious latency report can request arbitrary delay memory,
// multiplied by every faster edge in a dense graph. Above either bound,
// disable compensation as one plan rather than partially aligning the mix.
constexpr uint64_t kMaximumDelayMemoryBytes = 128ull * 1024ull * 1024ull;
constexpr double kMaximumCompensatedSeconds = 10.0;
} // namespace

struct PluginDelayBank::EdgeDelayLine {
    explicit EdgeDelayLine(uint32_t delaySamples)
        : left(delaySamples, 0.0f), right(delaySamples, 0.0f) {}

    std::vector<float> left;
    std::vector<float> right;
    std::atomic<uint32_t> cursor{0};
};

void PluginDelayBank::applyTo(MixProcessorView& view) const noexcept {
    view.edgeDelays = edgeDelayEntries.data();
    view.edgeDelayCount = edgeDelayEntries.size();
    view.stripOutputLatencySamples = stripOutputLatencySamples.data();
    view.stripOutputLatencyCount = stripOutputLatencySamples.size();
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

std::shared_ptr<PluginDelayBank> PluginDelayBank::build(
    const MixGraph& graph,
    const std::vector<uint32_t>& stripProcessorLatencySamples,
    double sampleRate,
    std::vector<std::string>& warnings,
    const PluginDelayBank* previousDelayBank) {
    auto bank = std::shared_ptr<PluginDelayBank>(new PluginDelayBank());
    const MixLatencyPlan latencyPlan =
        buildMixLatencyPlan(graph, stripProcessorLatencySamples);
    bank->routingLayoutKey = graph.routingLayoutKey;
    bank->preparedSampleRate = sampleRate;
    bank->maximumLatencySamples = static_cast<int>(std::min<uint32_t>(
        latencyPlan.maximumOutputLatencySamples,
        static_cast<uint32_t>(INT_MAX)));
    bank->stripOutputLatencySamples = latencyPlan.stripOutputLatencySamples;
    bank->edgeDelayLines.resize(graph.edges.size());
    bank->edgeDelayEntries.resize(graph.edges.size());

    uint64_t delayMemoryBytes = 0;
    for (const uint32_t delaySamples : latencyPlan.edgeDelaySamples) {
        delayMemoryBytes += static_cast<uint64_t>(delaySamples)
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
        for (size_t edgeIndex = 0;
             edgeIndex < latencyPlan.edgeDelaySamples.size(); ++edgeIndex) {
            const uint32_t delaySamples =
                latencyPlan.edgeDelaySamples[edgeIndex];
            if (delaySamples == 0)
                continue;
            // Only the audio owner touches ring samples/cursor. Sharing an
            // unchanged ring preserves exact history while the worker builds
            // a replacement publication; reading live floats here would race.
            std::shared_ptr<EdgeDelayLine> delay;
            if (previousDelayBank != nullptr
                && previousDelayBank->routingLayoutKey == graph.routingLayoutKey
                && previousDelayBank->preparedSampleRate == sampleRate
                && edgeIndex < previousDelayBank->edgeDelayLines.size()) {
                const auto& previous = previousDelayBank->edgeDelayLines[edgeIndex];
                if (previous != nullptr && previous->left.size() == delaySamples)
                    delay = previous;
            }
            // Changed lengths deliberately start with zero history. A bounded
            // refill transient is preferable to copying a concurrently written
            // ring or adding locks/work to the device callback.
            if (delay == nullptr)
                delay = std::make_shared<EdgeDelayLine>(delaySamples);
            bank->edgeDelayEntries[edgeIndex] =
                {delay.get(), processEdgeDelay};
            bank->edgeDelayLines[edgeIndex] = std::move(delay);
        }
    } catch (const std::bad_alloc&) {
        bank->edgeDelayEntries.assign(graph.edges.size(), MixEdgeDelay{});
        bank->edgeDelayLines.clear();
        bank->stripOutputLatencySamples.assign(graph.strips.size(), 0);
        bank->maximumLatencySamples = 0;
        warnings.push_back(
            "Plug-in delay compensation could not allocate its bounded buffers");
    }
    return bank;
}

} // namespace resostage
