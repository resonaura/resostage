#include "PluginProcessorBank.h"

#include <algorithm>
#include <climits>
#include <cmath>
#include <limits>
#include <new>

namespace resostage {
namespace {

constexpr size_t kMaximumSlotsPerBank = 128;
constexpr size_t kMaximumStateBytesPerSlot = 64 * 1024 * 1024;
constexpr size_t kMaximumStateBytesPerBank = 256 * 1024 * 1024;
// Delay compensation is intentionally bounded. A malicious or broken plug-in
// can report an arbitrary latency and a dense routing graph multiplies that
// by every faster incoming edge. Above this budget the bank still processes
// audio, but publishes no partial compensation plan.
constexpr uint64_t kMaximumDelayMemoryBytes = 128ull * 1024ull * 1024ull;
constexpr double kMaximumCompensatedSeconds = 10.0;

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
    std::string slotId;
    std::unique_ptr<juce::AudioPluginInstance> instance;
    bool bypassed = false;
    bool instrument = false;
    bool missingInstrument = false;
    std::atomic<bool> faulted{false};
    int requiredChannels = 2;
    juce::AudioBuffer<float> buffer;
    PluginSlotPowerTracker powerTracker;
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

struct PluginDelayBank::EdgeDelayLine {
    explicit EdgeDelayLine(uint32_t delaySamples)
        : left(delaySamples, 0.0f), right(delaySamples, 0.0f) {}

    std::vector<float> left;
    std::vector<float> right;
    uint32_t cursor = 0;
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
    uint32_t cursor = delay.cursor;
    for (int sample = 0; sample < numSamples; ++sample) {
        outputLeft[sample] = delay.left[cursor];
        outputRight[sample] = delay.right[cursor];
        delay.left[cursor] = inputEnabled ? inputLeft[sample] : 0.0f;
        delay.right[cursor] = inputEnabled ? inputRight[sample] : 0.0f;
        if (++cursor == length)
            cursor = 0;
    }
    delay.cursor = cursor;
}

std::shared_ptr<PluginDelayBank> PluginDelayBank::build(
    const MixGraph& graph,
    const std::vector<uint32_t>& stripProcessorLatencySamples,
    double sampleRate,
    std::vector<std::string>& warnings) {
    auto bank = std::shared_ptr<PluginDelayBank>(new PluginDelayBank());
    const MixLatencyPlan latencyPlan =
        buildMixLatencyPlan(graph, stripProcessorLatencySamples);
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
            auto delay = std::make_unique<EdgeDelayLine>(delaySamples);
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

PluginProcessorBank::~PluginProcessorBank() {
    for (auto& chain : chains)
        if (chain != nullptr)
            for (auto& node : chain->nodes)
                if (node->instance != nullptr) {
                    node->instance->removeListener(this);
                    node->instance->releaseResources();
                }
}

void PluginProcessorBank::audioProcessorChanged(
    juce::AudioProcessor*,
    const juce::AudioProcessorListener::ChangeDetails& details) {
    if (details.latencyChanged)
        latencyChangePending.store(true, std::memory_order_release);
}

std::vector<uint32_t> PluginProcessorBank::snapshotStripLatencies() const {
    std::vector<uint32_t> latencies(chains.size(), 0);
    for (size_t strip = 0; strip < chains.size(); ++strip) {
        const auto& chain = chains[strip];
        if (chain == nullptr)
            continue;
        uint64_t total = 0;
        for (const auto& node : chain->nodes)
            if (node->instance != nullptr)
                total += static_cast<uint32_t>(
                    std::max(0, node->instance->getLatencySamples()));
        latencies[strip] = static_cast<uint32_t>(std::min<uint64_t>(
            total, std::numeric_limits<uint32_t>::max()));
    }
    return latencies;
}

bool PluginProcessorBank::stripHasInstrument(size_t stripIndex) const noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return false;
    for (const auto& node : chains[stripIndex]->nodes) {
        if (node != nullptr && node->instrument)
            return true;
    }
    return false;
}

void PluginProcessorBank::addStripMidiEvent(size_t stripIndex, const juce::MidiMessage& message,
                                            int samplePosition) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    chains[stripIndex]->midi.addEvent(message, samplePosition);
}

void PluginProcessorBank::clearStripMidi(size_t stripIndex) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    chains[stripIndex]->midi.clear();
}

void PluginProcessorBank::injectAllNotesOff() noexcept {
    for (auto& chain : chains) {
        if (chain != nullptr) {
            for (int ch = 1; ch <= 16; ++ch) {
                chain->midi.addEvent(juce::MidiMessage::allNotesOff(ch), 0);
                chain->midi.addEvent(juce::MidiMessage::allSoundOff(ch), 0);
                chain->midi.addEvent(juce::MidiMessage::controllerEvent(ch, 64, 0), 0);
            }
        }
    }
}

void PluginProcessorBank::processChain(void* context, float* left, float* right,
                                       int numSamples) noexcept {
    auto& chain = *static_cast<StripChain*>(context);
    float* stereoChannels[] = {left, right};

    const bool hasMidi = !chain.midi.isEmpty();
    bool hasAudioInput = false;
    for (int i = 0; i < numSamples; ++i) {
        if (std::abs(left[i]) > 1.0e-5f || std::abs(right[i]) > 1.0e-5f) {
            hasAudioInput = true;
            break;
        }
    }

    for (auto& node : chain.nodes) {
        if (node->missingInstrument
            || (node->instrument && node->faulted.load(std::memory_order_relaxed))) {
            chain.audio.setDataToReferTo(stereoChannels, 2, numSamples);
            chain.audio.clear();
            continue;
        }
        if (node->instance == nullptr || node->faulted.load(std::memory_order_relaxed))
            continue;

        const bool hasInput = (node->instrument ? hasMidi : (hasAudioInput || hasMidi));
        if (hasInput) {
            // Immediate instantaneous wake-up (< 0.05 ms) if incoming signal enters
            if (!node->powerTracker.isProcessingNeeded()) {
                node->powerTracker.forceAwake();
            }
        } else if (!node->powerTracker.isProcessingNeeded()) {
            // Suspended or parked: skip execution completely (O(1))
            continue;
        }

        try {
            const int inChannels = node->instance->getTotalNumInputChannels();
            const int outChannels = node->instance->getTotalNumOutputChannels();

            // Mono-in folding: if plugin accepts 1 channel and input is stereo, sum L+R
            if (inChannels == 1 && node->requiredChannels <= 2) {
                for (int i = 0; i < numSamples; ++i)
                    left[i] = 0.5f * (left[i] + right[i]);
            }

            if (node->requiredChannels > 2) {
                const int samplesToProcess = std::min(numSamples, node->buffer.getNumSamples());
                if (samplesToProcess <= 0)
                    continue;

                const size_t bytesToCopy = sizeof(float) * static_cast<size_t>(samplesToProcess);
                std::memcpy(node->buffer.getWritePointer(0), left, bytesToCopy);
                std::memcpy(node->buffer.getWritePointer(1), right, bytesToCopy);
                for (int ch = 2; ch < node->requiredChannels; ++ch) {
                    std::memset(node->buffer.getWritePointer(ch), 0, bytesToCopy);
                }

                juce::AudioBuffer<float> activeBuf(node->buffer.getArrayOfWritePointers(),
                                                   node->requiredChannels, samplesToProcess);

                if (node->bypassed)
                    node->instance->processBlockBypassed(activeBuf, chain.midi);
                else
                    node->instance->processBlock(activeBuf, chain.midi);

                std::memcpy(left, node->buffer.getReadPointer(0), bytesToCopy);
                std::memcpy(right, node->buffer.getReadPointer(1), bytesToCopy);
            } else {
                chain.audio.setDataToReferTo(stereoChannels, 2, numSamples);
                if (node->bypassed)
                    node->instance->processBlockBypassed(chain.audio, chain.midi);
                else
                    node->instance->processBlock(chain.audio, chain.midi);

                if (outChannels == 1) {
                    std::memcpy(right, left, sizeof(float) * static_cast<size_t>(numSamples));
                }
            }

            // Sanitize against non-finite values (NaN / Inf) produced by unstable plugins
            for (int i = 0; i < numSamples; ++i) {
                if (!std::isfinite(left[i])) left[i] = 0.0f;
                if (!std::isfinite(right[i])) right[i] = 0.0f;
            }

            // Real-time power tracking: monitor tail decay and evaluate Quiescent/Suspended
            node->powerTracker.processBlockRealtime(left, right, numSamples, hasInput);
        } catch (...) {
            node->faulted.store(true, std::memory_order_relaxed);
        }
    }
    // Clear strip MIDI buffer after all nodes in the strip have processed the block
    chain.midi.clear();
}

PluginProcessorBank::BuildResult PluginProcessorBank::build(
    const Project& project, const MixGraph& graph, const ProjectLoader* resources,
    const juce::File& registryFile, double sampleRate, int maximumBlockSize,
    bool nonRealtime) {
    BuildResult result;
    auto bank = std::shared_ptr<PluginProcessorBank>(new PluginProcessorBank());
    bank->chains.resize(graph.strips.size());
    bank->processorEntries.resize(graph.strips.size());
    std::vector<uint32_t> stripProcessorLatencies(graph.strips.size(), 0);
    std::vector<double> stripProcessorTails(graph.strips.size(), 0.0);

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
            node->slotId = slot.id;
            node->bypassed = slot.bypassed;
            node->instrument = slot.plugin.instrument;
            PluginPowerFlags pflags;
            pflags.keepAwake = slot.keepAwake;
            pflags.isInstrument = slot.plugin.instrument;

            const auto* description = findDescription(descriptions, slot.plugin.identifier);
            if (description == nullptr) {
                node->missingInstrument = slot.plugin.instrument;
                node->powerTracker.prepare(slot.id, sampleRate, 0.0, pflags);
                result.warnings.push_back("Missing plug-in: " + slot.plugin.name);
                chain->nodes.push_back(std::move(node));
                continue;
            }

            juce::String error;
            node->instance = formats.createPluginInstance(
                *description, sampleRate, maximumBlockSize, error);
            if (node->instance == nullptr) {
                node->missingInstrument = slot.plugin.instrument;
                node->powerTracker.prepare(slot.id, sampleRate, 0.0, pflags);
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

            const int ins = node->instance->getTotalNumInputChannels();
            const int outs = node->instance->getTotalNumOutputChannels();
            node->requiredChannels = std::max(2, std::max(ins, outs));
            if (node->requiredChannels > 2) {
                node->buffer.setSize(node->requiredChannels, std::max(512, maximumBlockSize));
                node->buffer.clear();
            }

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
            const int reportedLatency =
                std::max(0, node->instance->getLatencySamples());
            const uint64_t accumulatedLatency =
                static_cast<uint64_t>(chain->latencySamples)
                + static_cast<uint32_t>(reportedLatency);
            chain->latencySamples = static_cast<int>(std::min<uint64_t>(
                accumulatedLatency, static_cast<uint64_t>(INT_MAX)));
            const double reportedTail = node->instance->getTailLengthSeconds();
            if (std::isfinite(reportedTail) && reportedTail > 0.0)
                chain->tailSeconds += reportedTail;

            node->powerTracker.prepare(slot.id, sampleRate, reportedTail, pflags);

            chain->nodes.push_back(std::move(node));
        }
        if (!chain->nodes.empty())
            bank->hasAnyPlugins = true;
        bank->maximumLatencySamples = std::max(bank->maximumLatencySamples,
                                               chain->latencySamples);
        bank->processorEntries[stripIndex] = {chain.get(), processChain};
        stripProcessorLatencies[stripIndex] =
            static_cast<uint32_t>(chain->latencySamples);
        stripProcessorTails[stripIndex] = chain->tailSeconds;
        bank->chains[stripIndex] = std::move(chain);
    }

    // Serial downstream chains extend a source's decay; parallel branches
    // take the longest path. This conservative bound prevents a sparse echo
    // from being mistaken for finished silence between repeats.
    std::vector<double> stripOutputTails(graph.strips.size(), 0.0);
    size_t tailEdgeCursor = 0;
    for (uint32_t strip = 0; strip < graph.strips.size(); ++strip) {
        double inputTail = 0.0;
        while (tailEdgeCursor < graph.edges.size()
               && graph.edges[tailEdgeCursor].to == strip) {
            const auto& edge = graph.edges[tailEdgeCursor++];
            if (edge.from < stripOutputTails.size())
                inputTail = std::max(inputTail, stripOutputTails[edge.from]);
        }
        stripOutputTails[strip] = inputTail + stripProcessorTails[strip];
        bank->maximumTailSeconds = std::max(
            bank->maximumTailSeconds, stripOutputTails[strip]);
    }

    bank->stripProcessorLatencySamples = std::move(stripProcessorLatencies);
    result.delayBank = PluginDelayBank::build(
        graph, bank->stripProcessorLatencySamples, sampleRate,
        result.warnings);
    // Subscribe only after preparation and state restore. Notifications from
    // those setup calls describe the latency already measured above and must
    // not trigger a rebuild loop immediately after publication.
    for (auto& chain : bank->chains)
        if (chain != nullptr)
            for (auto& node : chain->nodes)
                if (node->instance != nullptr)
                    node->instance->addListener(bank.get());
    result.bank = std::move(bank);
    return result;
}

std::unique_ptr<juce::AudioProcessorEditor>
PluginProcessorBank::createEditor(const std::string& slotId) {
    jassert(juce::MessageManager::getInstance()->isThisTheMessageThread());
    for (auto& chain : chains)
        if (chain != nullptr)
            for (auto& node : chain->nodes)
                if (node->slotId == slotId && node->instance != nullptr
                    && node->instance->hasEditor()) {
                    return std::unique_ptr<juce::AudioProcessorEditor>(
                        node->instance->createEditorIfNeeded());
                }
    return {};
}

void PluginProcessorBank::setPluginParameter(size_t stripIndex, size_t slotIndex,
                                             int paramIndex, float value) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    auto& nodes = chains[stripIndex]->nodes;
    if (slotIndex >= nodes.size() || nodes[slotIndex] == nullptr)
        return;
    auto* instance = nodes[slotIndex]->instance.get();
    if (instance == nullptr)
        return;
    const auto& params = instance->getParameters();
    if (paramIndex >= 0 && paramIndex < params.size()) {
        if (auto* param = params[paramIndex])
            param->setValue(std::clamp(value, 0.0f, 1.0f));
    }
}

bool PluginProcessorBank::setPluginParameterBySlotId(const std::string& slotId,
                                                    int paramIndex, float value) noexcept {
    for (const auto& chain : chains) {
        if (chain == nullptr)
            continue;
        for (const auto& node : chain->nodes) {
            if (node != nullptr && node->slotId == slotId) {
                if (node->instance != nullptr) {
                    const auto& params = node->instance->getParameters();
                    if (paramIndex >= 0 && paramIndex < params.size()) {
                        if (auto* param = params[paramIndex])
                            param->setValue(std::clamp(value, 0.0f, 1.0f));
                    }
                    return true;
                }
            }
        }
    }
    return false;
}

PluginPowerState PluginProcessorBank::getSlotPowerState(const std::string& slotId) const noexcept {
    for (const auto& chain : chains) {
        if (chain == nullptr) continue;
        for (const auto& node : chain->nodes) {
            if (node != nullptr && node->slotId == slotId) {
                return node->powerTracker.state();
            }
        }
    }
    return PluginPowerState::Active;
}

void PluginProcessorBank::setSlotKeepAwake(const std::string& slotId, bool keepAwake) noexcept {
    for (const auto& chain : chains) {
        if (chain == nullptr) continue;
        for (const auto& node : chain->nodes) {
            if (node != nullptr && node->slotId == slotId) {
                node->powerTracker.setKeepAwake(keepAwake);
                return;
            }
        }
    }
}

void PluginProcessorBank::prewarmStrip(size_t stripIndex) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    for (const auto& node : chains[stripIndex]->nodes) {
        if (node != nullptr) {
            node->powerTracker.forceAwake();
        }
    }
}

void PluginProcessorBank::prewarmSlot(const std::string& slotId) noexcept {
    for (const auto& chain : chains) {
        if (chain == nullptr) continue;
        for (const auto& node : chain->nodes) {
            if (node != nullptr && node->slotId == slotId) {
                node->powerTracker.forceAwake();
                return;
            }
        }
    }
}

void PluginProcessorBank::parkSlot(const std::string& slotId) noexcept {
    for (const auto& chain : chains) {
        if (chain == nullptr) continue;
        for (const auto& node : chain->nodes) {
            if (node != nullptr && node->slotId == slotId) {
                node->powerTracker.park();
                return;
            }
        }
    }
}

void PluginProcessorBank::unparkSlot(const std::string& slotId) noexcept {
    for (const auto& chain : chains) {
        if (chain == nullptr) continue;
        for (const auto& node : chain->nodes) {
            if (node != nullptr && node->slotId == slotId) {
                node->powerTracker.unpark();
                return;
            }
        }
    }
}

PluginPowerStats PluginProcessorBank::powerStats() const noexcept {
    PluginPowerStats s;
    for (const auto& chain : chains) {
        if (chain == nullptr) continue;
        for (const auto& node : chain->nodes) {
            if (node == nullptr) continue;
            ++s.totalSlots;
            switch (node->powerTracker.state()) {
                case PluginPowerState::Active: ++s.activeCount; break;
                case PluginPowerState::Quiescent: ++s.quiescentCount; break;
                case PluginPowerState::Suspended: ++s.suspendedCount; break;
                case PluginPowerState::Parked: ++s.parkedCount; break;
            }
        }
    }
    if (s.totalSlots > 0) {
        const size_t saved = s.suspendedCount + s.parkedCount;
        s.estimatedDspSavingsPercent =
            (static_cast<float>(saved) / static_cast<float>(s.totalSlots)) * 100.0f;
    }
    return s;
}

} // namespace resostage

