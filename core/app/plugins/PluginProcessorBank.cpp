#include "PluginProcessorBank.h"

#include <algorithm>
#include <cmath>

namespace resostage {
namespace {

constexpr size_t kMaximumSlotsPerBank = 128;
constexpr size_t kMaximumStateBytesPerSlot = 64 * 1024 * 1024;
constexpr size_t kMaximumStateBytesPerBank = 256 * 1024 * 1024;

const std::vector<PluginSlot>* slotsForStrip(const Project& project,
                                             const MixStrip& strip) {
    switch (strip.kind) {
        case StripKind::Track:
            return strip.projectIndex < project.tracks.size()
                ? &project.tracks[strip.projectIndex].plugins : nullptr;
        case StripKind::Click: return &project.click.plugins;
        case StripKind::Send:
            return strip.projectIndex < project.sends.size()
                ? &project.sends[strip.projectIndex].plugins : nullptr;
        case StripKind::Main: return &project.main.plugins;
        case StripKind::OutputLane: return nullptr;
    }
    return nullptr;
}

const juce::PluginDescription* findDescription(
    const juce::Array<juce::PluginDescription>& descriptions,
    const std::string& identifier) {
    for (const auto& description : descriptions)
        if (description.createIdentifierString().toStdString() == identifier)
            return &description;
    return nullptr;
}

} // namespace

void PluginPlayHead::publish(const PluginTransportState& state) noexcept {
    sample.store(state.sample, std::memory_order_relaxed);
    sampleRate.store(std::max(1.0, state.sampleRate), std::memory_order_relaxed);
    bpm.store(std::max(1.0, state.bpm), std::memory_order_relaxed);
    numerator.store(std::max(1, state.numerator), std::memory_order_relaxed);
    denominator.store(std::max(1, state.denominator), std::memory_order_relaxed);
    playing.store(state.playing, std::memory_order_relaxed);
    looping.store(state.looping, std::memory_order_relaxed);
    loopStartSample.store(state.loopStartSample, std::memory_order_relaxed);
    loopEndSample.store(state.loopEndSample, std::memory_order_relaxed);
    hostTimeNanos.store(state.hostTimeNanos, std::memory_order_relaxed);
}

juce::Optional<juce::AudioPlayHead::PositionInfo>
PluginPlayHead::getPosition() const {
    const double rate = sampleRate.load(std::memory_order_relaxed);
    const double tempo = bpm.load(std::memory_order_relaxed);
    const int64_t frame = sample.load(std::memory_order_relaxed);
    const int num = numerator.load(std::memory_order_relaxed);
    const int den = denominator.load(std::memory_order_relaxed);
    const double seconds = static_cast<double>(frame) / rate;
    const double ppq = seconds * tempo / 60.0;
    const double quartersPerBar = static_cast<double>(num) * 4.0 / den;

    PositionInfo position;
    position.setTimeInSamples(frame);
    position.setTimeInSeconds(seconds);
    position.setBpm(tempo);
    position.setTimeSignature(TimeSignature{num, den});
    position.setPpqPosition(ppq);
    position.setPpqPositionOfLastBarStart(
        quartersPerBar > 0.0 ? std::floor(ppq / quartersPerBar) * quartersPerBar : 0.0);
    position.setIsPlaying(playing.load(std::memory_order_relaxed));
    position.setIsRecording(false);
    const bool isLooping = looping.load(std::memory_order_relaxed);
    position.setIsLooping(isLooping);
    if (isLooping) {
        const auto loopStart = loopStartSample.load(std::memory_order_relaxed);
        const auto loopEnd = loopEndSample.load(std::memory_order_relaxed);
        position.setLoopPoints(LoopPoints{
            static_cast<double>(loopStart) / rate * tempo / 60.0,
            static_cast<double>(loopEnd) / rate * tempo / 60.0});
    }
    const uint64_t host = hostTimeNanos.load(std::memory_order_relaxed);
    if (host != 0) position.setHostTimeNs(host);
    return position;
}

struct PluginProcessorBank::Node {
    std::unique_ptr<juce::AudioPluginInstance> instance;
    bool bypassed = false;
    bool instrument = false;
    bool missingInstrument = false;
    std::atomic<bool> faulted{false};
};

struct PluginProcessorBank::StripChain {
    explicit StripChain(int maximumBlockSize)
        : audio(2, std::max(1, maximumBlockSize)) {
        midi.ensureSize(4096);
    }

    std::vector<std::unique_ptr<Node>> nodes;
    juce::AudioBuffer<float> audio;
    juce::MidiBuffer midi;
    int latencySamples = 0;
    double tailSeconds = 0.0;
};

PluginProcessorBank::~PluginProcessorBank() {
    for (auto& chain : chains)
        if (chain != nullptr)
            for (auto& node : chain->nodes)
                if (node->instance != nullptr)
                    node->instance->releaseResources();
}

void PluginProcessorBank::processChain(void* context, float* left, float* right,
                                       int numSamples) noexcept {
    auto& chain = *static_cast<StripChain*>(context);
    float* channels[] = {left, right};
    chain.audio.setDataToReferTo(channels, 2, numSamples);
    chain.midi.clear();
    for (auto& node : chain.nodes) {
        if (node->missingInstrument
            || (node->instrument && node->faulted.load(std::memory_order_relaxed))) {
            chain.audio.clear();
            continue;
        }
        if (node->instance == nullptr || node->faulted.load(std::memory_order_relaxed))
            continue;
        try {
            if (node->bypassed)
                node->instance->processBlockBypassed(chain.audio, chain.midi);
            else
                node->instance->processBlock(chain.audio, chain.midi);
        } catch (...) {
            node->faulted.store(true, std::memory_order_relaxed);
        }
    }
}

PluginProcessorBank::BuildResult PluginProcessorBank::build(
    const Project& project, const MixGraph& graph, const ProjectLoader* resources,
    const juce::File& registryFile, double sampleRate, int maximumBlockSize,
    bool nonRealtime) {
    BuildResult result;
    auto bank = std::shared_ptr<PluginProcessorBank>(new PluginProcessorBank());
    bank->chains.resize(graph.strips.size());
    bank->processorEntries.resize(graph.strips.size());

    juce::KnownPluginList known;
    if (registryFile.existsAsFile())
        if (auto xml = juce::parseXML(registryFile)) known.recreateFromXml(*xml);
    const auto descriptions = known.getTypes();
    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager(formats);

    size_t slotCount = 0;
    size_t loadedStateBytes = 0;
    for (size_t stripIndex = 0; stripIndex < graph.strips.size(); ++stripIndex) {
        const auto* slots = slotsForStrip(project, graph.strips[stripIndex]);
        if (slots == nullptr || slots->empty()) continue;
        auto chain = std::make_unique<StripChain>(maximumBlockSize);
        for (const auto& slot : *slots) {
            if (++slotCount > kMaximumSlotsPerBank) {
                result.warnings.push_back("Plug-in bank exceeds 128 slots; remaining inserts were skipped");
                break;
            }
            auto node = std::make_unique<Node>();
            node->bypassed = slot.bypassed;
            node->instrument = slot.plugin.instrument;
            const auto* description = findDescription(descriptions, slot.plugin.identifier);
            if (description == nullptr) {
                node->missingInstrument = slot.plugin.instrument;
                result.warnings.push_back("Missing plug-in: " + slot.plugin.name);
                chain->nodes.push_back(std::move(node));
                continue;
            }

            juce::String error;
            node->instance = formats.createPluginInstance(
                *description, sampleRate, maximumBlockSize, error);
            if (node->instance == nullptr) {
                node->missingInstrument = slot.plugin.instrument;
                result.warnings.push_back("Could not create " + slot.plugin.name + ": "
                                          + error.toStdString());
                chain->nodes.push_back(std::move(node));
                continue;
            }
            node->instance->setPlayHead(&bank->playHead);
            node->instance->setNonRealtime(nonRealtime);
            node->instance->setPlayConfigDetails(slot.plugin.instrument ? 0 : 2, 2,
                                                  sampleRate, maximumBlockSize);
            node->instance->prepareToPlay(sampleRate, maximumBlockSize);

            if (resources != nullptr && slot.stateResource.has_value()) {
                std::vector<uint8_t> state;
                std::string stateError;
                if (resources->extractFile(*slot.stateResource, state, stateError)) {
                    if (state.size() <= kMaximumStateBytesPerSlot
                        && loadedStateBytes + state.size() <= kMaximumStateBytesPerBank) {
                        node->instance->setStateInformation(
                            state.data(), static_cast<int>(state.size()));
                        loadedStateBytes += state.size();
                    } else {
                        result.warnings.push_back("Plug-in state limit exceeded: " + slot.plugin.name);
                    }
                } else {
                    result.warnings.push_back("Missing plug-in state: " + slot.plugin.name);
                }
            }
            chain->latencySamples += std::max(0, node->instance->getLatencySamples());
            chain->tailSeconds += std::max(0.0, node->instance->getTailLengthSeconds());
            chain->nodes.push_back(std::move(node));
        }
        bank->maximumLatencySamples = std::max(bank->maximumLatencySamples,
                                               chain->latencySamples);
        bank->maximumTailSeconds = std::max(bank->maximumTailSeconds,
                                            chain->tailSeconds);
        bank->processorEntries[stripIndex] = {chain.get(), processChain};
        bank->chains[stripIndex] = std::move(chain);
    }
    result.bank = std::move(bank);
    return result;
}

} // namespace resostage
