// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#include "PluginProcessorBank.h"
#include "PluginHostProcess.h"
#include "PluginPaths.h"
#include "project/ProjectSchema.h"
#include "plugins/PluginHostProtocol.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <climits>
#include <cmath>
#include <limits>
#include <new>
#include <stdexcept>
#include <thread>

#if !defined(_WIN32)
#include <sys/stat.h>
#include <unistd.h>
#endif

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
constexpr size_t kMaximumIsolatedChains = 32;
std::atomic<uint64_t> nextPluginHostGeneration{1};

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

bool createPrivateHostSnapshot(
    const MixStrip& strip,
    const std::vector<PluginSlot>& sourceSlots,
    const ProjectLoader* resources,
    const std::vector<PluginProcessorBank::StateBlob>* transientStates,
    double sampleRate, juce::File& projectDirectory, std::string& error) {
    const auto root = juce::File::getSpecialLocation(
        juce::File::tempDirectory).getChildFile("ResoStageLivePluginHosts");
    if (root.createDirectory().failed()) {
        error = "Could not create private live plug-in host directory";
        return false;
    }
#if !defined(_WIN32)
    struct stat rootStatus {};
    const auto rootPath = root.getFullPathName().toStdString();
    if (::lstat(rootPath.c_str(), &rootStatus) != 0
        || !S_ISDIR(rootStatus.st_mode) || rootStatus.st_uid != ::getuid()
        || ::chmod(rootPath.c_str(), 0700) != 0) {
        error = "Live plug-in host directory is not private to this user";
        return false;
    }
#endif
    projectDirectory = root.getChildFile(juce::Uuid().toString().removeCharacters("{}-"));
    if (projectDirectory.createDirectory().failed()) {
        error = "Could not create unique live plug-in host snapshot directory";
        return false;
    }
#if !defined(_WIN32)
    if (::chmod(projectDirectory.getFullPathName().toRawUTF8(), 0700) != 0) {
        error = "Could not secure live plug-in host snapshot permissions";
        projectDirectory.deleteRecursively();
        return false;
    }
#endif

    Project snapshot;
    snapshot.format.version = kCurrentFormatVersion;
    snapshot.name = "Isolated Plug-in Chain";
    snapshot.sampleRate = sampleRate;
    TrackDef track;
    track.id = "host::track:1";
    track.name = strip.name.empty() ? "Plug-in Chain" : strip.name;
    track.kind = std::any_of(sourceSlots.begin(), sourceSlots.end(),
        [](const PluginSlot& slot) { return slot.plugin.instrument; })
        ? TrackKind::Instrument : TrackKind::Audio;
    track.plugins = sourceSlots;

    std::vector<ProjectLoader::ExtraFile> extraFiles;
    size_t totalStateBytes = 0;
    for (size_t i = 0; i < track.plugins.size(); ++i) {
        auto& slot = track.plugins[i];
        // Preserve the source reference before replacing it with the snapshot's
        // private resource path. Resetting it first silently skipped project
        // state restoration and made isolated AU/VST instances open defaults.
        const auto sourceStateResource = slot.stateResource;
        slot.stateResource.reset();
        const PluginProcessorBank::StateBlob* transient = nullptr;
        if (transientStates != nullptr) {
            const auto found = std::find_if(transientStates->begin(), transientStates->end(),
                [&slot](const PluginProcessorBank::StateBlob& state) {
                    return state.slotId == slot.id;
                });
            if (found != transientStates->end()) transient = &*found;
        }
        std::vector<uint8_t> state;
        if (transient != nullptr) {
            state = transient->data;
        } else if (resources != nullptr && sourceStateResource.has_value()) {
            std::string stateError;
            if (!resources->extractFile(*sourceStateResource, state, stateError,
                                        kMaximumStateBytesPerSlot)) {
                error = "Could not restore saved state for plug-in "
                    + slot.plugin.name + ": " + stateError;
                projectDirectory.deleteRecursively();
                return false;
            }
        }
        if (state.size() > kMaximumStateBytesPerSlot
            || totalStateBytes + state.size() > kMaximumStateBytesPerBank) {
            error = "Plug-in state exceeds the bounded live-host snapshot budget";
            projectDirectory.deleteRecursively();
            return false;
        }
        if (!state.empty()) {
            const std::string resource = "Plugins/slot-" + std::to_string(i) + ".state";
            slot.stateResource = resource;
            totalStateBytes += state.size();
            extraFiles.push_back({resource, std::move(state)});
        }
    }
    snapshot.tracks.push_back(std::move(track));

    ProjectLoader writer;
    writer.newProject(snapshot.name);
    if (!writer.saveAsWithExtras(projectDirectory.getFullPathName().toStdString(),
                                 extraFiles, error, &snapshot)) {
        projectDirectory.deleteRecursively();
        return false;
    }
    return true;
}

juce::File pluginHostExecutable() {
    const auto coreExecutable =
        juce::File::getSpecialLocation(juce::File::currentExecutableFile);
#if defined(__APPLE__)
    // The assembled macOS app launches the helper from its own nested bundle
    // so Activity Monitor, crash reports, and plug-in editor windows inherit
    // the host's identity and icon. Raw CMake builds keep the sibling binary.
    const auto bundledHost = coreExecutable.getParentDirectory()
        .getParentDirectory()
        .getChildFile("Helpers")
        .getChildFile("ResoStage Plug-in Host.app")
        .getChildFile("Contents")
        .getChildFile("MacOS")
        .getChildFile("ResoStage Plug-in Host");
    if (bundledHost.existsAsFile())
        return bundledHost;
#endif
    const auto executableName =
#if defined(_WIN32)
        "pluginhost.exe";
#elif defined(__APPLE__)
        "ResoStage Plug-in Host";
#else
        "resostage-plugin-host";
#endif
    return coreExecutable.getSiblingFile(executableName);
}

} // namespace

void PluginPlayHead::publish(const PluginTransportState& state) noexcept {
    sample.store(state.sample, std::memory_order_relaxed);
    sampleRate.store(std::max(1.0, state.sampleRate), std::memory_order_relaxed);
    bpm.store(std::max(1.0, state.bpm), std::memory_order_relaxed);
    numerator.store(std::max(1, state.numerator), std::memory_order_relaxed);
    denominator.store(std::max(1, state.denominator), std::memory_order_relaxed);
    playing.store(state.playing, std::memory_order_relaxed);
    recording.store(state.recording, std::memory_order_relaxed);
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
    position.setIsRecording(recording.load(std::memory_order_relaxed));
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
    ~Node() {
        if (instance != nullptr) {
            try {
                instance->releaseResources();
            } catch (...) {
                // A vendor throwing during teardown must not escape this
                // noexcept destructor and terminate the Core process.
            }
        }
    }

    std::string slotId;
    std::string pluginIdentifier;
    std::unique_ptr<juce::AudioPluginInstance> instance;
    std::atomic<bool> bypassed{false};
    bool instrument = false;
    bool missingInstrument = false;
    std::string loadState = "loading";
    std::string loadError;
    std::atomic<bool> faulted{false};
    // A save worker raises stateCaptureRequested and waits only for an
    // already-running processBlock call to leave. The callback re-checks the
    // flag after publishing an active call, so it either owns the instance
    // or skips it; it never waits for vendor serialization.
    std::atomic<bool> stateCaptureRequested{false};
    std::atomic<uint32_t> activeCalls{0};
    int requiredChannels = 2;
    juce::AudioBuffer<float> buffer;
    PluginSlotPowerTracker powerTracker;
};

struct PluginProcessorBank::StripChain {
    explicit StripChain(int maxBlockSize)
        : audio(2, std::max(1, maxBlockSize)) {
        midi.ensureSize(4096);
    }

    std::vector<std::shared_ptr<Node>> nodes;
    struct HostedProcess {
        juce::File projectDirectory;
        std::unique_ptr<PluginHostProcess> process;
        ~HostedProcess() {
            process.reset();
            if (projectDirectory.isDirectory())
                projectDirectory.deleteRecursively();
        }
    };
    std::shared_ptr<HostedProcess> hostedProcess;
    std::string stripId;
    double sampleRate = 48000.0;
    int sharedBlockCapacity = 512;
    PluginTransportState transport{};
    std::atomic<uint32_t>* activePluginIndexTelemetry = nullptr;
    bool hostFailed = false;
    uint64_t lastRemoteStateChangeCounter = 0;
    uint64_t lastRemoteLatencyChangeCounter = 0;
    juce::AudioBuffer<float> audio;
    juce::MidiBuffer midi;
    int processorLatencySamples = 0;
    int pipelineLatencySamples = 0;
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
                    try {
                        node->instance->removeListener(this);
                    } catch (...) {
                        // Vendor teardown must not escape a noexcept bank
                        // destructor and terminate Core.
                    }
                }
}

void PluginProcessorBank::publishTransport(
    const PluginTransportState& state) noexcept {
    playHead->publish(state);
    for (auto& chain : chains)
        if (chain != nullptr)
            chain->transport = state;
}

void PluginProcessorBank::setActivePluginIndexTelemetry(
    std::atomic<uint32_t>* activeIndex) noexcept {
    activePluginIndexTelemetry = activeIndex;
    for (auto& chain : chains)
        if (chain != nullptr)
            chain->activePluginIndexTelemetry = activeIndex;
}

bool PluginProcessorBank::consumeStateChange() noexcept {
    bool changed = stateChangePending.exchange(false, std::memory_order_acq_rel);
    for (auto& chain : chains) {
        if (chain == nullptr || chain->hostedProcess == nullptr
            || chain->hostedProcess->process == nullptr)
            continue;
        const uint64_t remoteChanges =
            chain->hostedProcess->process->stateChangeCounter();
        if (remoteChanges != chain->lastRemoteStateChangeCounter) {
            chain->lastRemoteStateChangeCounter = remoteChanges;
            changed = true;
        }
    }
    return changed;
}

bool PluginProcessorBank::consumeLatencyChange() noexcept {
    bool changed = latencyChangePending.exchange(false, std::memory_order_acq_rel);
    for (auto& chain : chains) {
        if (chain == nullptr || chain->hostedProcess == nullptr
            || chain->hostedProcess->process == nullptr)
            continue;
        const uint64_t remoteChanges =
            chain->hostedProcess->process->latencyChangeCounter();
        if (remoteChanges != chain->lastRemoteLatencyChangeCounter) {
            chain->lastRemoteLatencyChangeCounter = remoteChanges;
            changed = true;
        }
    }
    return changed;
}

void PluginProcessorBank::audioProcessorChanged(
    juce::AudioProcessor*,
    const juce::AudioProcessorListener::ChangeDetails& details) {
    if (details.latencyChanged)
        latencyChangePending.store(true, std::memory_order_release);
    if (hostParameterWrites.load(std::memory_order_acquire) == 0
        && !stateSerializationInProgress.load(std::memory_order_acquire))
        stateChangePending.store(true, std::memory_order_release);
}

void PluginProcessorBank::audioProcessorParameterChanged(
    juce::AudioProcessor*, int, float) {
    if (hostParameterWrites.load(std::memory_order_acquire) == 0
        && !stateSerializationInProgress.load(std::memory_order_acquire))
        stateChangePending.store(true, std::memory_order_release);
}

PluginProcessorBank::StateSnapshot PluginProcessorBank::snapshotStates() {
    StateSnapshot snapshot;
    size_t totalBytes = 0;

    for (auto& chain : chains) {
        if (chain == nullptr)
            continue;
        if (chain->hostedProcess != nullptr) {
            const bool captured = chain->hostedProcess->process != nullptr
                && chain->hostedProcess->process->requestStateSnapshot();
            if (!captured) {
                snapshot.warnings.push_back(
                    "Could not capture state from isolated host for strip "
                    + chain->stripId);
                continue;
            }
            const auto stateDirectory = chain->hostedProcess->projectDirectory
                .getChildFile("LiveState");
            for (size_t slotIndex = 0; slotIndex < chain->nodes.size(); ++slotIndex) {
                const auto& node = chain->nodes[slotIndex];
                if (node == nullptr)
                    continue;
                const auto file = stateDirectory.getChildFile(
                    "slot-" + juce::String(static_cast<juce::int64>(slotIndex))
                    + ".state");
                if (!file.existsAsFile()) {
                    snapshot.warnings.push_back(
                        "Isolated host did not provide state for slot " + node->slotId);
                    continue;
                }
                const int64_t fileBytes = file.getSize();
                if (fileBytes < 0
                    || static_cast<uint64_t>(fileBytes) > kMaximumStateBytesPerSlot
                    || totalBytes + static_cast<uint64_t>(fileBytes)
                        > kMaximumStateBytesPerBank) {
                    snapshot.warnings.push_back(
                        "Plug-in state limit exceeded for slot " + node->slotId);
                    continue;
                }
                auto stream = file.createInputStream();
                if (stream == nullptr) {
                    snapshot.warnings.push_back(
                        "Could not read state for plug-in slot " + node->slotId);
                    continue;
                }
                StateBlob blob;
                blob.slotId = node->slotId;
                blob.data.resize(static_cast<size_t>(fileBytes));
                if (fileBytes > 0
                    && stream->read(blob.data.data(), static_cast<int>(fileBytes))
                        != static_cast<int>(fileBytes)) {
                    snapshot.warnings.push_back(
                        "Plug-in state snapshot was truncated for slot " + node->slotId);
                    continue;
                }
                totalBytes += static_cast<size_t>(fileBytes);
                snapshot.blobs.push_back(std::move(blob));
            }
            continue;
        }
        for (auto& node : chain->nodes) {
            if (node == nullptr || node->instance == nullptr)
                continue;

            node->stateCaptureRequested.store(true, std::memory_order_release);
            const auto deadline = std::chrono::steady_clock::now()
                                  + std::chrono::seconds(2);
            while (node->activeCalls.load(std::memory_order_acquire) != 0
                   && std::chrono::steady_clock::now() < deadline) {
                std::this_thread::yield();
            }
            if (node->activeCalls.load(std::memory_order_acquire) != 0) {
                node->stateCaptureRequested.store(false, std::memory_order_release);
                snapshot.warnings.push_back(
                    "Timed out waiting to snapshot plug-in slot " + node->slotId);
                continue;
            }

            juce::MemoryBlock state;
            stateSerializationInProgress.store(true, std::memory_order_release);
            try {
                node->instance->getStateInformation(state);
            } catch (...) {
                stateSerializationInProgress.store(false, std::memory_order_release);
                node->stateCaptureRequested.store(false, std::memory_order_release);
                snapshot.warnings.push_back(
                    "Plug-in threw while saving state for slot " + node->slotId);
                continue;
            }
            stateSerializationInProgress.store(false, std::memory_order_release);
            node->stateCaptureRequested.store(false, std::memory_order_release);

            const size_t bytes = state.getSize();
            if (bytes > kMaximumStateBytesPerSlot
                || totalBytes + bytes > kMaximumStateBytesPerBank) {
                snapshot.warnings.push_back(
                    "Plug-in state limit exceeded for slot " + node->slotId);
                continue;
            }
            StateBlob blob;
            blob.slotId = node->slotId;
            if (bytes > 0) {
                const auto* begin = static_cast<const uint8_t*>(state.getData());
                blob.data.assign(begin, begin + bytes);
            }
            totalBytes += bytes;
            snapshot.blobs.push_back(std::move(blob));
        }
    }
    return snapshot;
}

std::vector<uint32_t> PluginProcessorBank::snapshotStripLatencies() const {
    std::vector<uint32_t> latencies(chains.size(), 0);
    for (size_t strip = 0; strip < chains.size(); ++strip) {
        const auto& chain = chains[strip];
        if (chain == nullptr)
            continue;
        if (chain->hostedProcess != nullptr
            && chain->hostedProcess->process != nullptr) {
            const uint64_t total = static_cast<uint64_t>(
                chain->hostedProcess->process->processorLatencySamples())
                + static_cast<uint32_t>(std::max(0, chain->pipelineLatencySamples));
            latencies[strip] = static_cast<uint32_t>(std::min<uint64_t>(
                total, std::numeric_limits<uint32_t>::max()));
            continue;
        }
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

int PluginProcessorBank::snapshotMaximumProcessorLatency() const noexcept {
    int maximum = 0;
    for (const auto& chain : chains) {
        if (chain == nullptr)
            continue;
        uint64_t total = 0;
        if (chain->hostedProcess != nullptr
            && chain->hostedProcess->process != nullptr) {
            total = chain->hostedProcess->process->processorLatencySamples();
        } else {
            for (const auto& node : chain->nodes) {
                if (node == nullptr || node->instance == nullptr)
                    continue;
                try {
                    total += static_cast<uint32_t>(std::max(
                        0, node->instance->getLatencySamples()));
                } catch (...) {
                    // A bad latency report is treated as zero for PDC; the
                    // separate processor failure boundary remains unchanged.
                }
            }
        }
        maximum = std::max(maximum, static_cast<int>(std::min<uint64_t>(
            total, static_cast<uint64_t>(INT_MAX))));
    }
    return maximum;
}

std::vector<std::string> PluginProcessorBank::failedHostStripIds() const {
    std::vector<std::string> failed;
    for (const auto& chain : chains) {
        if (chain == nullptr || chain->nodes.empty())
            continue;
        const bool slotFailed = std::any_of(chain->nodes.begin(), chain->nodes.end(),
            [](const std::shared_ptr<Node>& node) {
                return node != nullptr && node->loadState == "failed";
            });
        const bool dead = slotFailed || chain->hostFailed
            || chain->hostedProcess == nullptr
            || chain->hostedProcess->process == nullptr
            || !chain->hostedProcess->process->isRunning()
            || !chain->hostedProcess->process->isReady();
        if (dead)
            failed.push_back(chain->stripId);
    }
    return failed;
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
                // Release sustained voices, but do not send All Sound Off
                // (CC 120): that kills envelopes immediately and can click
                // on Stop/seek instead of letting the synth's release/tail
                // run through the normal mixer path.
                chain->midi.addEvent(juce::MidiMessage::controllerEvent(ch, 64, 0), 0);
            }
        }
    }
}

void PluginProcessorBank::injectAllSoundOff() noexcept {
    for (auto& chain : chains) {
        if (chain == nullptr)
            continue;
        for (int ch = 1; ch <= 16; ++ch) {
            chain->midi.addEvent(juce::MidiMessage::allSoundOff(ch), 0);
            chain->midi.addEvent(juce::MidiMessage::controllerEvent(ch, 121, 0), 0);
            chain->midi.addEvent(juce::MidiMessage::pitchWheel(ch, 8192), 0);
        }
    }
}

void PluginProcessorBank::processChain(void* context, float* left, float* right,
                                       int numSamples) noexcept {
    auto& chain = *static_cast<StripChain*>(context);
    if (chain.hostedProcess != nullptr
        && chain.hostedProcess->process != nullptr) {
        std::array<plugin_host::MidiEvent,
                   plugin_host::kMaximumMidiEventsPerBlock> midiEvents{};
        uint32_t midiEventCount = 0;
        juce::MidiBuffer::Iterator iterator(chain.midi);
        juce::MidiMessage message;
        int samplePosition = 0;
        while (midiEventCount < midiEvents.size()
               && iterator.getNextEvent(message, samplePosition)) {
            const int byteCount = message.getRawDataSize();
            if (byteCount <= 0
                || byteCount > static_cast<int>(plugin_host::kMaximumMidiEventBytes)
                || samplePosition < 0 || samplePosition >= numSamples)
                continue;
            auto& event = midiEvents[midiEventCount++];
            event.sampleOffset = static_cast<uint32_t>(samplePosition);
            event.size = static_cast<uint8_t>(byteCount);
            std::copy_n(message.getRawData(), byteCount, event.data);
        }

        plugin_host::TransportSnapshot transport;
        transport.sample = chain.transport.sample;
        transport.loopStartSample = chain.transport.loopStartSample;
        transport.loopEndSample = chain.transport.loopEndSample;
        transport.hostTimeNanos = chain.transport.hostTimeNanos;
        transport.sampleRate = chain.transport.sampleRate;
        transport.bpm = chain.transport.bpm;
        transport.numerator = chain.transport.numerator;
        transport.denominator = chain.transport.denominator;
        transport.playing = chain.transport.playing ? 1 : 0;
        transport.recording = chain.transport.recording ? 1 : 0;
        transport.looping = chain.transport.looping ? 1 : 0;

        const bool instrumentChain = std::any_of(
            chain.nodes.begin(), chain.nodes.end(),
            [](const std::shared_ptr<Node>& node) {
                return node != nullptr && node->instrument;
            });
        (void)chain.hostedProcess->process->processBlock(
            left, right, static_cast<uint32_t>(numSamples), midiEvents.data(),
            midiEventCount, nullptr, 0, transport, instrumentChain);
        chain.midi.clear();
        if (chain.activePluginIndexTelemetry != nullptr)
            chain.activePluginIndexTelemetry->store(
                std::numeric_limits<uint32_t>::max(), std::memory_order_release);
        return;
    }

    float* stereoChannels[] = {left, right};

    const bool hasMidi = !chain.midi.isEmpty();

    uint32_t nodeIndex = 0;
    for (auto& node : chain.nodes) {
        if (chain.activePluginIndexTelemetry != nullptr)
            chain.activePluginIndexTelemetry->store(nodeIndex,
                                                     std::memory_order_release);
        ++nodeIndex;
        if (node->missingInstrument
            || (node->instrument && node->faulted.load(std::memory_order_relaxed))) {
            chain.audio.setDataToReferTo(stereoChannels, 2, numSamples);
            chain.audio.clear();
            continue;
        }
        if (node->instance == nullptr || node->faulted.load(std::memory_order_relaxed))
            continue;

        bool hasAudioInput = false;
        for (int i = 0; i < numSamples; ++i) {
            if (std::abs(left[i]) > 1.0e-5f || std::abs(right[i]) > 1.0e-5f) {
                hasAudioInput = true;
                break;
            }
        }

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

        if (node->stateCaptureRequested.load(std::memory_order_acquire))
            continue;
        node->activeCalls.fetch_add(1, std::memory_order_acq_rel);
        if (node->stateCaptureRequested.load(std::memory_order_acquire)) {
            node->activeCalls.fetch_sub(1, std::memory_order_acq_rel);
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
                if (samplesToProcess <= 0) {
                    node->activeCalls.fetch_sub(1, std::memory_order_acq_rel);
                    continue;
                }

                const size_t bytesToCopy = sizeof(float) * static_cast<size_t>(samplesToProcess);
                std::memcpy(node->buffer.getWritePointer(0), left, bytesToCopy);
                std::memcpy(node->buffer.getWritePointer(1), right, bytesToCopy);
                for (int ch = 2; ch < node->requiredChannels; ++ch) {
                    std::memset(node->buffer.getWritePointer(ch), 0, bytesToCopy);
                }

                juce::AudioBuffer<float> activeBuf(node->buffer.getArrayOfWritePointers(),
                                                   node->requiredChannels, samplesToProcess);

                if (node->bypassed.load(std::memory_order_relaxed))
                    node->instance->processBlockBypassed(activeBuf, chain.midi);
                else
                    node->instance->processBlock(activeBuf, chain.midi);

                std::memcpy(left, node->buffer.getReadPointer(0), bytesToCopy);
                std::memcpy(right, node->buffer.getReadPointer(1), bytesToCopy);
            } else {
                chain.audio.setDataToReferTo(stereoChannels, 2, numSamples);
                if (node->bypassed.load(std::memory_order_relaxed))
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
            // A vendor may have written only part of the output before
            // throwing. Do not forward a partially corrupted audio block.
            std::fill(left, left + numSamples, 0.0f);
            std::fill(right, right + numSamples, 0.0f);
        }
        node->activeCalls.fetch_sub(1, std::memory_order_acq_rel);
    }
    if (chain.activePluginIndexTelemetry != nullptr)
        chain.activePluginIndexTelemetry->store(
            std::numeric_limits<uint32_t>::max(), std::memory_order_release);
    // Clear strip MIDI buffer after all nodes in the strip have processed the block
    chain.midi.clear();
}

PluginProcessorBank::BuildResult PluginProcessorBank::build(
    const Project& project, const MixGraph& graph, const ProjectLoader* resources,
    const juce::File& registryFile, double sampleRate, int maximumBlockSize,
    bool nonRealtime, const PluginProcessorBank* previousBank,
    const std::vector<StateBlob>* transientStates,
    ExecutionMode executionMode,
    int hostedPipelineLatencySamples) {
    BuildResult result;
    auto bank = std::shared_ptr<PluginProcessorBank>(new PluginProcessorBank());
    if (previousBank != nullptr)
        bank->playHead = previousBank->playHead;
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
    size_t isolatedChainCount = 0;
    size_t loadedStateBytes = 0;
    for (size_t stripIndex = 0; stripIndex < graph.strips.size(); ++stripIndex) {
        const auto* slots = slotsForStrip(project, graph.strips[stripIndex]);
        if (slots == nullptr || slots->empty()) continue;
        auto chain = std::make_unique<StripChain>(maximumBlockSize);
        chain->stripId = graph.strips[stripIndex].id;
        chain->sampleRate = sampleRate;
        chain->sharedBlockCapacity = maximumBlockSize;

        if (executionMode == ExecutionMode::IsolatedProcess) {
            const StripChain* reusableChain = nullptr;
            if (previousBank != nullptr) {
                for (const auto& candidate : previousBank->chains) {
                    if (candidate == nullptr || candidate->hostedProcess == nullptr
                        || candidate->hostedProcess->process == nullptr
                        || !candidate->hostedProcess->process->isRunning()
                        || !candidate->hostedProcess->process->isReady()
                        || std::abs(candidate->sampleRate - sampleRate) >= 1.0e-6
                        || candidate->sharedBlockCapacity != maximumBlockSize
                        || candidate->stripId != chain->stripId
                        || candidate->nodes.size() != slots->size())
                        continue;
                    bool identical = true;
                    for (size_t index = 0; index < slots->size(); ++index) {
                        const auto& slot = (*slots)[index];
                        const auto& node = candidate->nodes[index];
                        identical = identical && node != nullptr
                            && node->loadState == "loaded"
                            && !node->faulted.load(std::memory_order_acquire)
                            && node->slotId == slot.id
                            && node->pluginIdentifier == slot.plugin.identifier
                            && node->instrument == slot.plugin.instrument
                            && node->bypassed.load(std::memory_order_acquire)
                                == slot.bypassed;
                    }
                    if (identical) {
                        reusableChain = candidate.get();
                        break;
                    }
                }
            }

            if (reusableChain != nullptr) {
                chain->nodes = reusableChain->nodes;
                chain->hostedProcess = reusableChain->hostedProcess;
                chain->processorLatencySamples = static_cast<int>(std::min<uint32_t>(
                    chain->hostedProcess->process->processorLatencySamples(),
                    static_cast<uint32_t>(INT_MAX)));
                chain->pipelineLatencySamples = std::max(
                    0, hostedPipelineLatencySamples);
                chain->latencySamples = static_cast<int>(std::min<int64_t>(
                    static_cast<int64_t>(chain->processorLatencySamples)
                        + chain->pipelineLatencySamples,
                    INT_MAX));
                chain->tailSeconds = reusableChain->tailSeconds;
            } else {
                ++isolatedChainCount;
                std::vector<StateBlob> liveChainStates;
                const std::vector<StateBlob>* chainStates = transientStates;
                if (chainStates == nullptr && previousBank != nullptr) {
                    const auto previousChain = std::find_if(
                        previousBank->chains.begin(), previousBank->chains.end(),
                        [&chain](const auto& candidate) {
                            return candidate != nullptr
                                && candidate->stripId == chain->stripId
                                && candidate->hostedProcess != nullptr
                                && candidate->hostedProcess->process != nullptr;
                        });
                    if (previousChain != previousBank->chains.end()) {
                        const auto& old = **previousChain;
                        if (old.hostedProcess->process->requestStateSnapshot()) {
                            const auto directory = old.hostedProcess->projectDirectory
                                .getChildFile("LiveState");
                            size_t capturedBytes = 0;
                            for (size_t index = 0; index < old.nodes.size(); ++index) {
                                const auto& oldNode = old.nodes[index];
                                if (oldNode == nullptr)
                                    continue;
                                const auto file = directory.getChildFile(
                                    "slot-" + juce::String(static_cast<juce::int64>(index))
                                    + ".state");
                                const int64_t bytes = file.getSize();
                                if (!file.existsAsFile() || bytes < 0
                                    || static_cast<uint64_t>(bytes)
                                        > kMaximumStateBytesPerSlot
                                    || capturedBytes + static_cast<size_t>(bytes)
                                        > kMaximumStateBytesPerBank)
                                    continue;
                                auto stream = file.createInputStream();
                                if (stream == nullptr)
                                    continue;
                                StateBlob blob;
                                blob.slotId = oldNode->slotId;
                                blob.data.resize(static_cast<size_t>(bytes));
                                if (bytes > 0
                                    && stream->read(blob.data.data(),
                                        static_cast<int>(bytes)) != static_cast<int>(bytes))
                                    continue;
                                capturedBytes += static_cast<size_t>(bytes);
                                liveChainStates.push_back(std::move(blob));
                            }
                            if (!liveChainStates.empty())
                                chainStates = &liveChainStates;
                        }
                    }
                }
                for (const auto& slot : *slots) {
                    if (++slotCount > kMaximumSlotsPerBank) {
                        result.warnings.push_back(
                            "Plug-in bank exceeds 128 slots; remaining inserts were skipped");
                        break;
                    }
                    auto node = std::make_shared<Node>();
                    node->slotId = slot.id;
                    node->pluginIdentifier = slot.plugin.identifier;
                    node->bypassed.store(slot.bypassed, std::memory_order_relaxed);
                    node->instrument = slot.plugin.instrument;
                    node->loadState = "loading";
                    PluginPowerFlags flags;
                    flags.keepAwake = slot.keepAwake;
                    flags.isInstrument = slot.plugin.instrument;
                    node->powerTracker.prepare(slot.id, sampleRate, 0.0, flags);
                    chain->nodes.push_back(std::move(node));
                }

                std::string hostError;
                if (isolatedChainCount <= kMaximumIsolatedChains
                    && !chain->nodes.empty()) {
                    auto hosted = std::make_shared<StripChain::HostedProcess>();
                    if (createPrivateHostSnapshot(graph.strips[stripIndex], *slots,
                            resources, chainStates, sampleRate,
                            hosted->projectDirectory, hostError)) {
                        hosted->process = std::make_unique<PluginHostProcess>();
                        const uint64_t hostGeneration =
                            nextPluginHostGeneration.fetch_add(1, std::memory_order_relaxed);
                        if (hosted->process->start(pluginHostExecutable(),
                                hostGeneration,
                                static_cast<uint32_t>(maximumBlockSize), hostError,
                                sampleRate, hosted->projectDirectory,
                                pluginRegistryFile())) {
                            chain->hostedProcess = std::move(hosted);
                            chain->processorLatencySamples = static_cast<int>(
                                std::min<uint32_t>(
                                    chain->hostedProcess->process
                                        ->processorLatencySamples(),
                                    static_cast<uint32_t>(INT_MAX)));
                            chain->pipelineLatencySamples = std::max(
                                0, hostedPipelineLatencySamples);
                            chain->latencySamples = static_cast<int>(std::min<int64_t>(
                                static_cast<int64_t>(chain->processorLatencySamples)
                                    + chain->pipelineLatencySamples,
                                INT_MAX));
                            const double hostTail = chain->hostedProcess->process
                                ->processorTailSeconds();
                            chain->tailSeconds = std::isfinite(hostTail)
                                ? std::max(0.0, hostTail) : 0.0;
                            for (size_t i = 0; i < chain->nodes.size(); ++i) {
                                auto& node = chain->nodes[i];
                                switch (chain->hostedProcess->process->pluginSlotStatus(i)) {
                                    case plugin_host::PluginSlotStatus::Loaded:
                                        node->loadState = "loaded";
                                        break;
                                    case plugin_host::PluginSlotStatus::Missing:
                                        node->loadState = "missing";
                                        node->missingInstrument = node->instrument;
                                        node->loadError = chain->hostedProcess->process
                                            ->pluginSlotLoadError(i);
                                        if (node->loadError.empty())
                                            node->loadError = "Plug-in is not present in the isolated host catalog";
                                        break;
                                    case plugin_host::PluginSlotStatus::Failed:
                                        node->loadState = "failed";
                                        node->faulted.store(true, std::memory_order_relaxed);
                                        node->missingInstrument = node->instrument;
                                        node->loadError = chain->hostedProcess->process
                                            ->pluginSlotLoadError(i);
                                        if (node->loadError.empty())
                                            node->loadError = "Plug-in failed to initialize in the isolated host";
                                        break;
                                    case plugin_host::PluginSlotStatus::Unknown:
                                        node->loadState = "failed";
                                        node->faulted.store(true, std::memory_order_relaxed);
                                        node->missingInstrument = node->instrument;
                                        node->loadError = "Isolated host did not report plug-in load status";
                                        break;
                                }
                            }
                        }
                    }
                } else if (isolatedChainCount > kMaximumIsolatedChains) {
                    hostError = "Maximum of 32 isolated live plug-in chains reached";
                }

                if (chain->hostedProcess == nullptr) {
                    chain->hostFailed = true;
                    result.warnings.push_back("Could not start isolated plug-in chain "
                        + graph.strips[stripIndex].name + ": " + hostError);
                    for (auto& node : chain->nodes) {
                        node->faulted.store(true, std::memory_order_relaxed);
                        node->missingInstrument = node->instrument;
                        node->loadState = "failed";
                        node->loadError = hostError;
                    }
                }
            }
            if (!chain->nodes.empty())
                bank->hasAnyPlugins = true;
            bank->maximumLatencySamples = std::max(
                bank->maximumLatencySamples, chain->latencySamples);
            bank->processorEntries[stripIndex] = {chain.get(), processChain};
            stripProcessorLatencies[stripIndex] =
                static_cast<uint32_t>(chain->latencySamples);
            stripProcessorTails[stripIndex] = chain->tailSeconds;
            bank->chains[stripIndex] = std::move(chain);
            continue;
        }

        for (const auto& slot : *slots) {
            if (++slotCount > kMaximumSlotsPerBank) {
                result.warnings.push_back("Plug-in bank exceeds 128 slots; remaining inserts were skipped");
                break;
            }
            std::shared_ptr<Node> reusableNode;
            if (previousBank != nullptr) {
                for (const auto& previousChain : previousBank->chains) {
                    if (previousChain == nullptr) continue;
                    const auto previous = std::find_if(
                        previousChain->nodes.begin(), previousChain->nodes.end(),
                        [&slot](const auto& candidate) {
                            return candidate != nullptr
                                && candidate->slotId == slot.id
                                && candidate->pluginIdentifier == slot.plugin.identifier
                                && candidate->instrument == slot.plugin.instrument;
                        });
                    if (previous != previousChain->nodes.end()) {
                        reusableNode = *previous;
                        break;
                    }
                }
            }

            if (reusableNode != nullptr) {
                reusableNode->bypassed.store(slot.bypassed,
                                              std::memory_order_relaxed);
                try {
                    chain->latencySamples = static_cast<int>(std::min<uint64_t>(
                        static_cast<uint64_t>(chain->latencySamples)
                            + static_cast<uint32_t>(reusableNode->instance != nullptr
                                ? std::max(0, reusableNode->instance->getLatencySamples())
                                : 0),
                        static_cast<uint64_t>(INT_MAX)));
                    if (reusableNode->instance != nullptr) {
                        const double tail = reusableNode->instance->getTailLengthSeconds();
                        if (std::isfinite(tail) && tail > 0.0)
                            chain->tailSeconds += tail;
                    }
                } catch (...) {
                    reusableNode->faulted.store(true, std::memory_order_relaxed);
                    result.warnings.push_back(
                        "Reused plug-in failed while querying latency/tail: "
                        + slot.plugin.name);
                }
                chain->nodes.push_back(std::move(reusableNode));
                continue;
            }

            auto node = std::make_shared<Node>();
            node->slotId = slot.id;
            node->pluginIdentifier = slot.plugin.identifier;
            node->bypassed.store(slot.bypassed, std::memory_order_relaxed);
            node->instrument = slot.plugin.instrument;
            PluginPowerFlags pflags;
            pflags.keepAwake = slot.keepAwake;
            pflags.isInstrument = slot.plugin.instrument;

            const auto* description = findDescription(descriptions, slot.plugin.identifier);
            if (description == nullptr) {
                node->missingInstrument = slot.plugin.instrument;
                node->loadState = "missing";
                node->loadError = "Plug-in is not present in the scanned catalog";
                node->powerTracker.prepare(slot.id, sampleRate, 0.0, pflags);
                result.warnings.push_back("Missing plug-in: " + slot.plugin.name);
                chain->nodes.push_back(std::move(node));
                continue;
            }

            try {
                juce::String error;
                node->instance = formats.createPluginInstance(
                    *description, sampleRate, maximumBlockSize, error);
                if (node->instance == nullptr) {
                    node->loadError = error.isNotEmpty()
                        ? error.toStdString() : "JUCE could not create the plug-in instance";
                    throw std::runtime_error(node->loadError);
                }
                node->instance->setPlayHead(bank->playHead.get());
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

                const StateBlob* transientState = nullptr;
                if (transientStates != nullptr) {
                    const auto saved = std::find_if(
                        transientStates->begin(), transientStates->end(),
                        [&slot](const StateBlob& state) { return state.slotId == slot.id; });
                    if (saved != transientStates->end()) transientState = &*saved;
                }
                if (transientState != nullptr) {
                    node->instance->setStateInformation(
                        transientState->data.data(),
                        static_cast<int>(transientState->data.size()));
                } else if (resources != nullptr && slot.stateResource.has_value()) {
                    std::vector<uint8_t> state;
                    std::string stateError;
                    if (resources->extractFile(*slot.stateResource, state, stateError,
                                               kMaximumStateBytesPerSlot)) {
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
                node->loadState = "loaded";
            } catch (const std::exception& exception) {
                node->loadState = "failed";
                node->missingInstrument = slot.plugin.instrument;
                node->faulted.store(true, std::memory_order_relaxed);
                node->loadError = exception.what();
                result.warnings.push_back("Could not prepare " + slot.plugin.name + ": " + node->loadError);
            } catch (...) {
                node->loadState = "failed";
                node->missingInstrument = slot.plugin.instrument;
                node->faulted.store(true, std::memory_order_relaxed);
                node->loadError = "Plug-in threw during construction, preparation, or state restore";
                result.warnings.push_back("Could not prepare " + slot.plugin.name);
            }

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

    PluginTransportState initialTransport;
    initialTransport.sample = 0;
    initialTransport.sampleRate = sampleRate;
    initialTransport.playing = false;
    if (!project.songs.empty()) {
        const auto& song = project.songs.front();
        initialTransport.bpm = song.bpm;
        initialTransport.numerator = song.timeSignature.numerator;
        initialTransport.denominator = song.timeSignature.denominator;
    }
    bank->playHead->publish(initialTransport);

    result.bank = std::move(bank);
    return result;
}

std::unique_ptr<juce::AudioProcessorEditor>
PluginProcessorBank::createEditor(const std::string& slotId) {
    jassert(juce::MessageManager::getInstance()->isThisTheMessageThread());
    for (auto& chain : chains)
        if (chain != nullptr)
            for (auto& node : chain->nodes)
                if (node->slotId == slotId && node->instance != nullptr) {
                    try {
                        if (node->instance->hasEditor())
                            return std::unique_ptr<juce::AudioProcessorEditor>(
                                node->instance->createEditorIfNeeded());
                    } catch (...) {
                        node->faulted.store(true, std::memory_order_relaxed);
                        return {};
                    }
                }
    return {};
}

bool PluginProcessorBank::openHostedEditor(const std::string& slotId) {
    for (const auto& chain : chains) {
        if (chain == nullptr || chain->hostedProcess == nullptr
            || chain->hostedProcess->process == nullptr)
            continue;
        for (size_t i = 0; i < chain->nodes.size(); ++i) {
            if (chain->nodes[i] != nullptr && chain->nodes[i]->slotId == slotId
                && i <= std::numeric_limits<uint32_t>::max())
                return chain->hostedProcess->process->requestOpenEditor(
                    static_cast<uint32_t>(i));
        }
    }
    return false;
}

bool PluginProcessorBank::closeHostedEditor(const std::string& slotId) {
    for (const auto& chain : chains) {
        if (chain == nullptr || chain->hostedProcess == nullptr
            || chain->hostedProcess->process == nullptr)
            continue;
        for (size_t i = 0; i < chain->nodes.size(); ++i) {
            if (chain->nodes[i] != nullptr && chain->nodes[i]->slotId == slotId
                && i <= std::numeric_limits<uint32_t>::max())
                return chain->hostedProcess->process->requestCloseEditor(
                    static_cast<uint32_t>(i));
        }
    }
    return false;
}

bool PluginProcessorBank::closeAllHostedEditors() {
    bool requested = false;
    for (const auto& chain : chains) {
        if (chain == nullptr || chain->hostedProcess == nullptr
            || chain->hostedProcess->process == nullptr)
            continue;
        requested = chain->hostedProcess->process->requestCloseAllEditors()
            || requested;
    }
    return requested;
}

void PluginProcessorBank::setPluginParameter(size_t stripIndex, size_t slotIndex,
                                             int paramIndex, float value) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    auto& nodes = chains[stripIndex]->nodes;
    if (slotIndex >= nodes.size() || nodes[slotIndex] == nullptr)
        return;
    auto& chain = *chains[stripIndex];
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr) {
        if (slotIndex > std::numeric_limits<uint16_t>::max())
            return;
        plugin_host::ParameterEvent event;
        event.slotIndex = static_cast<uint16_t>(slotIndex);
        event.parameterIndex = paramIndex;
        event.normalizedValue = std::clamp(value, 0.0f, 1.0f);
        // A full bounded control queue drops this update and records a health
        // counter; it is not evidence that the vendor processor faulted.
        (void)chain.hostedProcess->process->enqueueParameterEvent(event);
        return;
    }
    auto* instance = nodes[slotIndex]->instance.get();
    if (instance == nullptr)
        return;
    auto& node = *nodes[slotIndex];
    if (node.stateCaptureRequested.load(std::memory_order_acquire))
        return;
    node.activeCalls.fetch_add(1, std::memory_order_acq_rel);
    if (node.stateCaptureRequested.load(std::memory_order_acquire)) {
        node.activeCalls.fetch_sub(1, std::memory_order_acq_rel);
        return;
    }
    try {
        const auto& params = instance->getParameters();
        if (paramIndex >= 0 && paramIndex < params.size()) {
            if (auto* param = params[paramIndex]) {
                hostParameterWrites.fetch_add(1, std::memory_order_acq_rel);
                try {
                    param->setValue(std::clamp(value, 0.0f, 1.0f));
                } catch (...) {
                    hostParameterWrites.fetch_sub(1, std::memory_order_acq_rel);
                    throw;
                }
                hostParameterWrites.fetch_sub(1, std::memory_order_acq_rel);
            }
        }
    } catch (...) {
        node.faulted.store(true, std::memory_order_relaxed);
    }
    node.activeCalls.fetch_sub(1, std::memory_order_acq_rel);
}

bool PluginProcessorBank::setPluginParameterBySlotId(const std::string& slotId,
                                                    int paramIndex, float value) noexcept {
    for (const auto& chain : chains) {
        if (chain == nullptr)
            continue;
        for (size_t slotIndex = 0; slotIndex < chain->nodes.size(); ++slotIndex) {
            const auto& node = chain->nodes[slotIndex];
            if (node != nullptr && node->slotId == slotId) {
                if (chain->hostedProcess != nullptr
                    && chain->hostedProcess->process != nullptr) {
                    if (slotIndex > std::numeric_limits<uint16_t>::max())
                        return false;
                    plugin_host::ParameterEvent event;
                    event.slotIndex = static_cast<uint16_t>(slotIndex);
                    event.parameterIndex = paramIndex;
                    event.normalizedValue = std::clamp(value, 0.0f, 1.0f);
                    const bool queued = chain->hostedProcess->process
                        ->enqueueParameterEvent(event);
                    return queued;
                }
                if (node->instance != nullptr) {
                    if (node->stateCaptureRequested.load(std::memory_order_acquire))
                        return false;
                    node->activeCalls.fetch_add(1, std::memory_order_acq_rel);
                    if (node->stateCaptureRequested.load(std::memory_order_acquire)) {
                        node->activeCalls.fetch_sub(1, std::memory_order_acq_rel);
                        return false;
                    }
                    bool succeeded = true;
                    try {
                        const auto& params = node->instance->getParameters();
                        if (paramIndex >= 0 && paramIndex < params.size()) {
                            if (auto* param = params[paramIndex]) {
                                hostParameterWrites.fetch_add(1, std::memory_order_acq_rel);
                                try {
                                    param->setValue(std::clamp(value, 0.0f, 1.0f));
                                } catch (...) {
                                    hostParameterWrites.fetch_sub(1, std::memory_order_acq_rel);
                                    throw;
                                }
                                hostParameterWrites.fetch_sub(1, std::memory_order_acq_rel);
                            }
                        }
                    } catch (...) {
                        node->faulted.store(true, std::memory_order_relaxed);
                        succeeded = false;
                    }
                    node->activeCalls.fetch_sub(1, std::memory_order_acq_rel);
                    return succeeded;
                }
            }
        }
    }
    return false;
}

bool PluginProcessorBank::setSlotBypassed(const std::string& slotId,
                                          bool bypassed) noexcept {
    for (const auto& chain : chains) {
        if (chain == nullptr)
            continue;
        for (size_t slotIndex = 0; slotIndex < chain->nodes.size(); ++slotIndex) {
            const auto& node = chain->nodes[slotIndex];
            if (node != nullptr && node->slotId == slotId) {
                if (chain->hostedProcess != nullptr
                    && chain->hostedProcess->process != nullptr) {
                    if (slotIndex > std::numeric_limits<uint16_t>::max())
                        return false;
                    plugin_host::ParameterEvent event;
                    event.slotIndex = static_cast<uint16_t>(slotIndex);
                    event.parameterIndex = -2; // bounded bypass control command
                    event.normalizedValue = bypassed ? 1.0f : 0.0f;
                    if (!chain->hostedProcess->process->enqueueParameterEvent(event))
                        return false;
                }
                node->bypassed.store(bypassed, std::memory_order_release);
                return true;
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

std::string PluginProcessorBank::getSlotLoadState(const std::string& slotId) const {
    for (const auto& chain : chains) {
        if (chain == nullptr) continue;
        for (const auto& node : chain->nodes) {
            if (node == nullptr || node->slotId != slotId) continue;
            if (chain->hostedProcess != nullptr
                && (chain->hostedProcess->process == nullptr
                    || !chain->hostedProcess->process->isRunning()))
                return "failed";
            if (node->faulted.load(std::memory_order_relaxed)) return "failed";
            return node->loadState;
        }
    }
    return "loading";
}

std::vector<PluginProcessorBank::ParameterInfo>
PluginProcessorBank::parametersForSlot(const std::string& slotId) const {
    for (const auto& chain : chains) {
        if (chain == nullptr)
            continue;
        for (size_t slotIndex = 0; slotIndex < chain->nodes.size(); ++slotIndex) {
            const auto& node = chain->nodes[slotIndex];
            if (node == nullptr || node->slotId != slotId)
                continue;
            std::vector<ParameterInfo> result;
            if (chain->hostedProcess != nullptr
                && chain->hostedProcess->process != nullptr) {
                const auto descriptors = chain->hostedProcess->process
                    ->parameterDescriptorsForSlot(slotIndex);
                result.reserve(descriptors.size());
                for (const auto& descriptor : descriptors) {
                    const auto nameEnd = std::find(std::begin(descriptor.name),
                                                   std::end(descriptor.name), '\0');
                    const auto labelEnd = std::find(std::begin(descriptor.label),
                                                    std::end(descriptor.label), '\0');
                    result.push_back({descriptor.parameterIndex,
                                      std::string(std::begin(descriptor.name), nameEnd),
                                      std::string(std::begin(descriptor.label), labelEnd),
                                      descriptor.defaultValue, descriptor.steps});
                }
                return result;
            }
            // In-process banks only exist in the helper and offline worker;
            // callers there are on their owner thread, never the Core callback.
            if (node->instance == nullptr)
                return result;
            try {
                const auto& parameters = node->instance->getParameters();
                const int limit = std::min<int>(
                    parameters.size(), plugin_host::kMaximumParameterDescriptorsPerChain);
                result.reserve(static_cast<size_t>(limit));
                for (int i = 0; i < limit; ++i) {
                    const auto* parameter = parameters[i];
                    if (parameter == nullptr)
                        continue;
                    result.push_back({static_cast<uint32_t>(i),
                                      parameter->getName(63).toStdString(),
                                      parameter->getLabel().toStdString(),
                                      std::clamp(parameter->getDefaultValue(), 0.0f, 1.0f),
                                      static_cast<uint32_t>(
                                          std::max(0, parameter->getNumSteps()))});
                }
            } catch (...) {
                result.clear();
            }
            return result;
        }
    }
    return {};
}

std::string PluginProcessorBank::getSlotLoadError(const std::string& slotId) const {
    for (const auto& chain : chains) {
        if (chain == nullptr) continue;
        for (const auto& node : chain->nodes) {
            if (node == nullptr || node->slotId != slotId) continue;
            if (chain->hostedProcess != nullptr
                && (chain->hostedProcess->process == nullptr
                    || !chain->hostedProcess->process->isRunning()))
                return "Isolated plug-in host exited; chain audio is temporarily unavailable";
            if (node->loadState == "missing" || node->loadState == "failed")
                return node->loadError;
            if (node->faulted.load(std::memory_order_relaxed))
                return "Plug-in raised an exception while processing audio";
            return node->loadError;
        }
    }
    return {};
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
