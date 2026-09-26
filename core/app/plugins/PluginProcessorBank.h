#pragma once

#include "audio/MixGraph.h"
#include "audio/MixLatency.h"
#include "audio/MixRenderer.h"
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
 * Immutable strip-indexed bank of stateful JUCE processors.
 *
 * Build and destroy this object away from the audio callback. process() is
 * reached only through MixProcessorView's pre-bound function/context pairs;
 * it performs no lookup, resizing, state serialization, or filesystem work.
 */
class PluginProcessorBank final : private juce::AudioProcessorListener {
public:
    struct BuildResult {
        std::shared_ptr<PluginProcessorBank> bank;
        std::shared_ptr<PluginDelayBank> delayBank;
        std::vector<std::string> warnings;
    };

    static BuildResult build(const Project& project, const MixGraph& graph,
                             const ProjectLoader* resources,
                             const juce::File& registryFile,
                             double sampleRate, int maximumBlockSize,
                             bool nonRealtime);

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
    void publishTransport(const PluginTransportState& state) noexcept {
        playHead.publish(state);
    }
    int latencySamples() const noexcept { return maximumLatencySamples; }
    double tailSeconds() const noexcept { return maximumTailSeconds; }
    bool hasPlugins() const noexcept { return hasAnyPlugins; }
    /** Worker-thread refresh used after a JUCE latency-change notification. */
    std::vector<uint32_t> snapshotStripLatencies() const;
    bool consumeLatencyChange() noexcept {
        return latencyChangePending.exchange(false, std::memory_order_acq_rel);
    }
    /** Creates a vendor editor on the JUCE message thread for one live slot. */
    std::unique_ptr<juce::AudioProcessorEditor> createEditor(
        const std::string& slotId);

    /** Audio-thread hooks for routing block MIDI messages to instrument strips. */
    bool stripHasInstrument(size_t stripIndex) const noexcept;
    void addStripMidiEvent(size_t stripIndex, const juce::MidiMessage& message,
                           int samplePosition) noexcept;
    void clearStripMidi(size_t stripIndex) noexcept;

    void requestAllNotesOff() noexcept {
        allNotesOffPending.store(true, std::memory_order_release);
    }
    bool consumeAllNotesOff() noexcept {
        return allNotesOffPending.exchange(false, std::memory_order_acq_rel);
    }
    void injectAllNotesOff() noexcept;

    /** Real-time parameter automation methods (zero-allocation, non-blocking). */
    void setPluginParameter(size_t stripIndex, size_t slotIndex, int paramIndex, float value) noexcept;
    bool setPluginParameterBySlotId(const std::string& slotId, int paramIndex, float value) noexcept;

    /** Power management inspection and control (Phase 5). */
    PluginPowerState getSlotPowerState(const std::string& slotId) const noexcept;
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
                                        float) override {}
    void audioProcessorChanged(
        juce::AudioProcessor*,
        const juce::AudioProcessorListener::ChangeDetails& details) override;

    PluginPlayHead playHead;
    std::vector<std::unique_ptr<StripChain>> chains;
    std::vector<MixStripProcessor> processorEntries;
    std::vector<uint32_t> stripProcessorLatencySamples;
    int maximumLatencySamples = 0;
    double maximumTailSeconds = 0.0;
    bool hasAnyPlugins = false;
    std::atomic<bool> latencyChangePending{false};
};

} // namespace resostage
