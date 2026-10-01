/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "audio/graph/MixGraph.h"
#include "audio/graph/MixLatency.h"
#include "audio/graph/MixRenderer.h"
#include "plugins/PluginPowerManager.h"
#include "project/ProjectLoader.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <memory>
#include <string>
#include <vector>

namespace resostage {

/** Immutable, graph-topology-specific PDC state with no vendor processors. */
class PluginDelayBank final {
public:
    static std::shared_ptr<PluginDelayBank> build(
        const MixGraph& graph,
        const std::vector<uint32_t>& stripProcessorLatencySamples,
        double sampleRate,
        std::vector<std::string>& warnings);

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

    std::vector<std::unique_ptr<EdgeDelayLine>> edgeDelayLines;
    std::vector<MixEdgeDelay> edgeDelayEntries;
    std::vector<uint32_t> stripOutputLatencySamples;
    int maximumLatencySamples = 0;
};

struct PluginTransportState {
    int64_t sample = 0;
    double sampleRate = 48000.0;
    double bpm = 120.0;
    int numerator = 4;
    int denominator = 4;
    bool playing = false;
    bool recording = false;
    bool looping = false;
    int64_t loopStartSample = 0;
    int64_t loopEndSample = 0;
    uint64_t hostTimeNanos = 0;
};

/** Lock-free scalar transport projection read by tempo-aware plug-ins. */
class PluginPlayHead final : public juce::AudioPlayHead {
public:
    void publish(const PluginTransportState& state) noexcept;
    juce::Optional<PositionInfo> getPosition() const override;

private:
    std::atomic<int64_t> sample{0};
    std::atomic<double> sampleRate{48000.0};
    std::atomic<double> bpm{120.0};
    std::atomic<int> numerator{4};
    std::atomic<int> denominator{4};
    std::atomic<bool> playing{false};
    std::atomic<bool> recording{false};
    std::atomic<bool> looping{false};
    std::atomic<int64_t> loopStartSample{0};
    std::atomic<int64_t> loopEndSample{0};
    std::atomic<uint64_t> hostTimeNanos{0};
};

/**
 * Immutable strip-indexed bank of graph-facing processors. Live mode uses an
 * isolated helper per chain; offline mode owns the JUCE processors directly.
 *
 * Build and destroy this object away from the audio callback. process() is
 * reached only through MixProcessorView's pre-bound function/context pairs;
 * it performs no lookup, resizing, state serialization, or filesystem work.
 */
class PluginProcessorBank final : private juce::AudioProcessorListener {
public:
    enum class ExecutionMode : uint8_t {
        InProcess,
        IsolatedProcess,
    };

    struct StateBlob {
        std::string slotId;
        std::vector<uint8_t> data;
    };

    struct StateSnapshot {
        std::vector<StateBlob> blobs;
        std::vector<std::string> warnings;
    };

    struct ParameterInfo {
        uint32_t index = 0;
        std::string name;
        std::string label;
        float defaultValue = 0.0f;
        uint32_t steps = 0;
    };

    struct BuildResult {
        std::shared_ptr<PluginProcessorBank> bank;
        std::shared_ptr<PluginDelayBank> delayBank;
        std::vector<std::string> warnings;
    };

    static BuildResult build(const Project& project, const MixGraph& graph,
                             const ProjectLoader* resources,
                             const juce::File& registryFile,
                             double sampleRate, int maximumBlockSize,
                             bool nonRealtime,
                             const PluginProcessorBank* previousBank = nullptr,
                             const std::vector<StateBlob>* transientStates = nullptr,
                             ExecutionMode executionMode = ExecutionMode::InProcess,
                             int hostedPipelineLatencySamples = 0);

    ~PluginProcessorBank() override;
    PluginProcessorBank(const PluginProcessorBank&) = delete;
    PluginProcessorBank& operator=(const PluginProcessorBank&) = delete;

    MixProcessorView processorView(
        const PluginDelayBank* delayBank = nullptr) const noexcept {
        MixProcessorView view{processorEntries.data(), processorEntries.size()};
        if (delayBank != nullptr)
            delayBank->applyTo(view);
        return view;
    }
    void publishTransport(const PluginTransportState& state) noexcept;
    void setActivePluginIndexTelemetry(std::atomic<uint32_t>* activeIndex) noexcept;
    int latencySamples() const noexcept { return maximumLatencySamples; }
    double tailSeconds() const noexcept { return maximumTailSeconds; }
    bool hasPlugins() const noexcept { return hasAnyPlugins; }
    /** Worker-thread refresh used after a JUCE latency-change notification. */
    std::vector<uint32_t> snapshotStripLatencies() const;
    /** Allocation-free latency refresh for the single-chain helper host. */
    int snapshotMaximumProcessorLatency() const noexcept;
    /** Message-thread health query; never used by the audio callback. */
    std::vector<std::string> failedHostStripIds() const;
    bool consumeLatencyChange() noexcept;
    bool consumeStateChange() noexcept;
    /**
     * Captures opaque vendor state away from the audio thread. Each processor
     * is bypassed independently while its blob is read; the callback never
     * waits for the snapshot worker.
     */
    StateSnapshot snapshotStates();
    /** Creates a vendor editor on the JUCE message thread for one live slot. */
    std::unique_ptr<juce::AudioProcessorEditor> createEditor(
        const std::string& slotId);
    bool openHostedEditor(const std::string& slotId);
    bool closeHostedEditor(const std::string& slotId);
    bool closeAllHostedEditors();

    /** Audio-thread hooks for routing block MIDI messages to instrument strips. */
    bool stripHasInstrument(size_t stripIndex) const noexcept;
    void addStripMidiEvent(size_t stripIndex, const juce::MidiMessage& message,
                           int samplePosition) noexcept;
    /** Raw bounded ingress for the host adapter; never constructs an owning MIDI message. */
    void addStripMidiEvent(size_t stripIndex, const uint8_t* data, int numBytes,
                           int samplePosition) noexcept;
    void clearStripMidi(size_t stripIndex) noexcept;
    /** Non-realtime diagnostics for malformed/oversized/capacity-rejected MIDI events. */
    uint64_t rejectedMidiEvents() const noexcept;

    void requestAllNotesOff() noexcept {
        allNotesOffPending.store(true, std::memory_order_release);
    }
    bool consumeAllNotesOff() noexcept {
        return allNotesOffPending.exchange(false, std::memory_order_acq_rel);
    }
    void injectAllNotesOff() noexcept;
    /** Deliberate transport panic only: kill held voices and reset controllers. */
    void injectAllSoundOff() noexcept;

    /** Real-time parameter automation methods (zero-allocation, non-blocking). */
    void setPluginParameter(size_t stripIndex, size_t slotIndex, int paramIndex, float value) noexcept;
    bool setPluginParameterBySlotId(const std::string& slotId, int paramIndex, float value) noexcept;
    /** Message-thread bypass update; preserves the live vendor instance. */
    bool setSlotBypassed(const std::string& slotId, bool bypassed) noexcept;

    /** Power management inspection and control (Phase 5). */
    PluginPowerState getSlotPowerState(const std::string& slotId) const noexcept;
    std::string getSlotLoadState(const std::string& slotId) const;
    std::string getSlotLoadError(const std::string& slotId) const;
    /** Non-realtime discovery from a hosted chain's startup snapshot. */
    std::vector<ParameterInfo> parametersForSlot(const std::string& slotId) const;
    void setSlotKeepAwake(const std::string& slotId, bool keepAwake) noexcept;
    void prewarmStrip(size_t stripIndex) noexcept;
    void prewarmSlot(const std::string& slotId) noexcept;
    void parkSlot(const std::string& slotId) noexcept;
    void unparkSlot(const std::string& slotId) noexcept;
    PluginPowerStats powerStats() const noexcept;

private:
    std::atomic<bool> allNotesOffPending{false};
    struct Node;
    struct StripChain;

    PluginProcessorBank() = default;
    static void processChain(void* context, float* left, float* right,
                             int numSamples) noexcept;
    void audioProcessorParameterChanged(juce::AudioProcessor*, int,
                                        float) override;
    void audioProcessorChanged(
        juce::AudioProcessor*,
        const juce::AudioProcessorListener::ChangeDetails& details) override;

    // Reused nodes retain JUCE's raw AudioPlayHead pointer. Banks sharing a
    // node must therefore share this playhead's lifetime as well.
    std::shared_ptr<PluginPlayHead> playHead = std::make_shared<PluginPlayHead>();
    std::vector<std::unique_ptr<StripChain>> chains;
    std::vector<MixStripProcessor> processorEntries;
    std::vector<uint32_t> stripProcessorLatencySamples;
    int maximumLatencySamples = 0;
    double maximumTailSeconds = 0.0;
    bool hasAnyPlugins = false;
    std::atomic<bool> latencyChangePending{false};
    std::atomic<bool> stateChangePending{false};
    // Timeline/MIDI-learn automation must not make the project look edited.
    // JUCE parameter notifications are normally synchronous with setValue().
    std::atomic<uint32_t> hostParameterWrites{0};
    std::atomic<bool> stateSerializationInProgress{false};
    std::atomic<uint32_t>* activePluginIndexTelemetry = nullptr;
};

} // namespace resostage
