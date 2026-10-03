/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "PluginHostSharedMemory.h"

#include <juce_core/juce_core.h>

#include <array>
#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace resostage {

/**
 * Core-side controller for one isolated serial plug-in chain process.
 * start()/stop() and readiness supervision are non-realtime only. The audio
 * callback uses processBlock(), which performs fixed-size copies, lock-free
 * slot transitions, and a non-waiting OS wake; it never polls process liveness
 * or waits for a vendor processor.
 */
class PluginHostProcess final {
public:
    struct ParameterValue {
        uint32_t index = 0;
        float value = 0.0f;
    };

    PluginHostProcess();
    ~PluginHostProcess();
    PluginHostProcess(const PluginHostProcess&) = delete;
    PluginHostProcess& operator=(const PluginHostProcess&) = delete;

    bool start(const juce::File& executable, uint64_t generation,
               uint32_t maximumBlockSamples, std::string& error,
               double sampleRate = 48000.0,
               const juce::File& projectDirectory = {},
               const juce::File& registryFile = {},
               const std::function<void(uint32_t)>& startupProgress = {});
    void stop() noexcept;
    bool isRunning() const noexcept;
    bool isReady() const noexcept;
    uint32_t maximumBlockSamples() const noexcept { return maximumBlockSize; }
    uint64_t generation() const noexcept { return hostGeneration; }
    uint32_t processorLatencySamples() const noexcept {
        const auto* area = sharedMemory.area();
        return area != nullptr
            ? area->processorLatencySamples.load(std::memory_order_acquire) : 0;
    }
    uint64_t latencyChangeCounter() const noexcept {
        const auto* area = sharedMemory.area();
        return area != nullptr
            ? area->latencyChangeCounter.load(std::memory_order_acquire) : 0;
    }
    plugin_host::PluginSlotStatus pluginSlotStatus(size_t index) const noexcept {
        const auto* area = sharedMemory.area();
        return area != nullptr && index < area->pluginSlotCount
            ? static_cast<plugin_host::PluginSlotStatus>(area->pluginSlotStatuses[index])
            : plugin_host::PluginSlotStatus::Unknown;
    }
    /** Startup-only diagnostics published by the helper before it becomes Ready. */
    std::string pluginSlotLoadError(size_t index) const;
    /** Startup-only immutable metadata; query from a non-realtime thread. */
    std::vector<plugin_host::ParameterDescriptor> parameterDescriptorsForSlot(
        size_t slotIndex, std::vector<float>* currentValues = nullptr) const;
    /** Lightweight latest-value read; descriptor identity stays in the cached list. */
    std::vector<ParameterValue> parameterValuesForSlot(size_t slotIndex) const;
    bool parameterMetadataTruncated() const noexcept;
    double processorTailSeconds() const noexcept {
        const auto* area = sharedMemory.area();
        return area != nullptr ? area->processorTailSeconds : 0.0;
    }

    /**
     * Non-blocking two-callback pipeline. It returns the corresponding older
     * request's result or the configured miss fallback, then submits this
     * input block. `left/right` are replaced with the returned audio.
     */
    bool processBlock(float* left, float* right, uint32_t numSamples,
                      const plugin_host::MidiEvent* midiEvents,
                      uint32_t midiEventCount,
                      const plugin_host::ParameterEvent* parameterEvents,
                      uint32_t parameterEventCount,
                      const plugin_host::TransportSnapshot& transport,
                      bool muteOnMiss = true) noexcept;
    /** Bounded shared-memory MPMC control ingress; never waits for the helper. */
    bool enqueueParameterEvent(
        const plugin_host::ParameterEvent& event) noexcept;
    /** Latest-wins bounded power mailbox; consumed on the next helper DSP block. */
    bool requestPowerControl(uint32_t slotIndex, PluginPowerControl control) noexcept;
    /** O(1) coalesced prewarm for the whole serial chain; no parameter queue/wake. */
    void requestChainPrewarm() noexcept;
    /** Atomic helper-produced power state, not the Core proxy's tracker. */
    PluginPowerState pluginSlotPowerState(size_t slotIndex) const noexcept;
    /** Bounded non-RT request used by the project save worker. */
    bool requestStateSnapshot() noexcept;
    bool requestOpenEditor(uint32_t slotIndex) noexcept;
    bool requestCloseEditor(uint32_t slotIndex) noexcept;
    bool requestCloseAllEditors() noexcept;

    uint64_t missedOutputBlocks() const noexcept {
        return missedOutputBlockCount.load(std::memory_order_relaxed);
    }
    uint64_t missedInputBlocks() const noexcept {
        return missedInputBlockCount.load(std::memory_order_relaxed);
    }
    uint64_t missedControlEvents() const noexcept {
        const auto* area = sharedMemory.area();
        return area != nullptr
            ? area->missedControlEvents.load(std::memory_order_relaxed) : 0;
    }
    uint64_t completedBlocks() const noexcept {
        const auto* area = sharedMemory.area();
        return area != nullptr
            ? area->heartbeat.load(std::memory_order_acquire) : 0;
    }
    uint64_t stateChangeCounter() const noexcept {
        const auto* area = sharedMemory.area();
        return area != nullptr
            ? area->stateChangeCounter.load(std::memory_order_acquire) : 0;
    }

private:
    void supervise() noexcept;
    bool requestCommand(plugin_host::HostCommand command,
                        uint32_t slotIndex,
                        std::chrono::milliseconds timeout) noexcept;
    void drainCompletedOutputs(plugin_host::SharedArea& area,
                               uint64_t beforeSequence) noexcept;

    PluginHostSharedMemory sharedMemory;
    std::unique_ptr<juce::ChildProcess> process;
    std::atomic<uint64_t> missedOutputBlockCount{0};
    std::atomic<uint64_t> missedInputBlockCount{0};
    uint64_t hostGeneration = 0;
    uint64_t nextSequence = 0;
    uint64_t nextOutputSequence = 0;
    uint32_t maximumBlockSize = 0;
    double configuredSampleRate = 48000.0;
    static constexpr size_t outputFifoCapacity =
        plugin_host::kSlotCount * plugin_host::kMaximumBlockSamples;
    std::array<float, outputFifoCapacity> outputFifoLeft{};
    std::array<float, outputFifoCapacity> outputFifoRight{};
    size_t outputFifoRead = 0;
    size_t outputFifoWrite = 0;
    size_t outputFifoSize = 0;
    std::atomic<bool> stopSupervisor{true};
    std::atomic<bool> processAlive{false};
    std::thread supervisorThread;
    std::mutex commandMutex;
};

} // namespace resostage
