#pragma once

#include "audio/MixGraph.h"
#include "audio/MixRenderer.h"
#include "project/ProjectLoader.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <memory>
#include <string>
#include <vector>

namespace resostage {

struct PluginTransportState {
    int64_t sample = 0;
    double sampleRate = 48000.0;
    double bpm = 120.0;
    int numerator = 4;
    int denominator = 4;
    bool playing = false;
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
class PluginProcessorBank final {
public:
    struct BuildResult {
        std::shared_ptr<PluginProcessorBank> bank;
        std::vector<std::string> warnings;
    };

    static BuildResult build(const Project& project, const MixGraph& graph,
                             const ProjectLoader* resources,
                             const juce::File& registryFile,
                             double sampleRate, int maximumBlockSize,
                             bool nonRealtime);

    ~PluginProcessorBank();
    PluginProcessorBank(const PluginProcessorBank&) = delete;
    PluginProcessorBank& operator=(const PluginProcessorBank&) = delete;

    MixProcessorView processorView() const noexcept {
        return {processorEntries.data(), processorEntries.size()};
    }
    void publishTransport(const PluginTransportState& state) noexcept {
        playHead.publish(state);
    }
    int latencySamples() const noexcept { return maximumLatencySamples; }
    double tailSeconds() const noexcept { return maximumTailSeconds; }

private:
    struct Node;
    struct StripChain;

    PluginProcessorBank() = default;
    static void processChain(void* context, float* left, float* right,
                             int numSamples) noexcept;

    PluginPlayHead playHead;
    std::vector<std::unique_ptr<StripChain>> chains;
    std::vector<MixStripProcessor> processorEntries;
    int maximumLatencySamples = 0;
    double maximumTailSeconds = 0.0;
};

} // namespace resostage
