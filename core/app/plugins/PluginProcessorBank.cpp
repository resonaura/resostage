/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "PluginProcessorBank.h"
#include "PluginHostProcess.h"
#include "audio/graph/MixMath.h"
#include "PluginMIDIBuffer.h"
#include "PluginPaths.h"
#include "PluginPresetStore.h"
#include "PluginRetryScope.h"
#include "project/ProjectSchema.h"
#include "plugins/PluginHostProtocol.h"
#include "plugins/PluginMidiActivity.h"
#include "plugins/PluginParameterBinding.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <charconv>
#include <climits>
#include <cmath>
#include <filesystem>
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
constexpr size_t kMaximumIsolatedChains = 32;
std::atomic<uint64_t> nextPluginHostGeneration{1};

bool stateBlobMatchesSlot(const PluginProcessorBank::StateBlob& state,
                          const std::string& stripId,
                          const PluginSlot& slot) noexcept {
    return state.stripId == stripId
        && state.slotId == slot.id
        && (!state.stateResource.has_value()
            || state.stateResource == slot.stateResource);
}

bool extractPluginSlotState(const ProjectLoader* resources,
                            const std::string& stripId,
                            const PluginSlot& slot,
                            std::vector<uint8_t>& state,
                            std::string& error) {
    state.clear();
    if (!slot.stateResource.has_value())
        return true;
    std::string projectError;
    if (resources != nullptr
        && resources->extractFile(*slot.stateResource, state, projectError,
                                  PluginPresetStore::kMaximumStateBytes))
        return true;

    const auto presetId = PluginPresetStore::presetIdForProjectResource(
        stripId, slot.id, *slot.stateResource);
    if (presetId.has_value()) {
        PluginPresetData preset;
        const auto root = PluginPresetStore::userPresetRoot();
        if (PluginPresetStore::load(root, slot.plugin.identifier,
                                    *presetId, preset, error)) {
            state = std::move(preset.state);
            return true;
        }
        error = "Could not restore plug-in preset " + *presetId + ": " + error;
        return false;
    }
    error = projectError.empty()
        ? "Project plug-in-state resource is unavailable"
        : "Could not restore saved state: " + projectError;
    return false;
}

std::string pluginParameterId(const juce::AudioProcessorParameter& parameter,
                               uint32_t index) {
    if (const auto* hosted = dynamic_cast<const juce::HostedAudioProcessorParameter*>(&parameter)) {
        const auto id = hosted->getParameterID().toStdString();
        // Never truncate identities: distinct long IDs could otherwise bind
        // one envelope to another vendor control. Those retain legacy indices.
        if (!id.empty() && id.size() < sizeof(plugin_host::ParameterDescriptor::parameterId) - 3)
            return "id:" + id;
    }
    return "param:" + std::to_string(index);
}

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

int requestedSidechainBusIndex(const PluginSlot& slot) noexcept {
    if (!slot.sidechain.has_value() || slot.sidechain->inputBusIndex == 0
        || slot.sidechain->inputBusIndex
            > plugin_host::kMaximumSidechainInputBusIndex)
        return -1;
    return static_cast<int>(slot.sidechain->inputBusIndex);
}

const TrackDef* trackForStrip(const Project& project, const MixStrip& strip) {
    if (strip.kind != StripKind::Track || strip.projectIndex >= project.tracks.size())
        return nullptr;
    return &project.tracks[strip.projectIndex];
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
    bool recordArmed, bool inputMonitoring,
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
    track.recordArmed = recordArmed;
    track.inputMonitoring = inputMonitoring;
    track.plugins = sourceSlots;

    std::vector<ProjectLoader::ExtraFile> extraFiles;
    size_t totalStateBytes = 0;
    for (size_t i = 0; i < track.plugins.size(); ++i) {
        auto& slot = track.plugins[i];
        // Preserve the source reference before replacing it with the snapshot's
        // private resource path. Resetting it first silently skipped project
        // state restoration and made isolated AU/VST instances open defaults.
        const PluginSlot sourceSlot = slot;
        const auto sourceStateResource = slot.stateResource;
        slot.stateResource.reset();
        const PluginProcessorBank::StateBlob* transient = nullptr;
        if (transientStates != nullptr) {
            const auto found = std::find_if(
                transientStates->begin(), transientStates->end(),
                [&sourceSlot, &strip](const PluginProcessorBank::StateBlob& state) {
                    return stateBlobMatchesSlot(state, strip.id, sourceSlot);
                });
            if (found != transientStates->end()) transient = &*found;
        }
        std::vector<uint8_t> state;
        if (transient != nullptr) {
            state = transient->data;
        } else if (sourceStateResource.has_value()) {
            std::string stateError;
            if (!extractPluginSlotState(resources, strip.id, sourceSlot,
                                        state, stateError)) {
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
    struct ValueListener final : juce::AudioProcessorParameter::Listener {
        ValueListener(juce::AudioProcessorParameter& input,
                      std::atomic<float>& output) : parameter(input), destination(output) {
            const float value = parameter.getValue();
            destination.store(std::isfinite(value) ? std::clamp(value, 0.0f, 1.0f) : 0.0f,
                              std::memory_order_relaxed);
            parameter.addListener(this);
        }
        ~ValueListener() override { parameter.removeListener(this); }
        void parameterValueChanged(int, float value) override {
            if (std::isfinite(value))
                destination.store(std::clamp(value, 0.0f, 1.0f), std::memory_order_relaxed);
        }
        void parameterGestureChanged(int, bool) override {}
        juce::AudioProcessorParameter& parameter;
        std::atomic<float>& destination;
    };
    explicit Node(bool instrumentNode = false) : instrument(instrumentNode) {
        if (instrument) {
            deferredMidi = std::make_unique<PluginMIDIDeferredQueue>();
            replayMidi = std::make_unique<PluginMIDIBuffer>();
        }
    }

    ~Node() {
        // Listener pointers refer to the host mapping. Remove them while both
        // the mapping and vendor parameters still live, before releaseResources.
        valueListeners.clear();
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
    std::optional<std::string> stateResource;
    std::unique_ptr<juce::AudioPluginInstance> instance;
    std::vector<PluginParameterBinding> parameterBindings;
    bool bindingsPrepared = false;
    std::vector<std::unique_ptr<ValueListener>> valueListeners;
    std::atomic<bool> bypassed{false};
    bool instrument = false;
    std::unique_ptr<PluginMIDIDeferredQueue> deferredMidi;
    std::unique_ptr<PluginMIDIBuffer> replayMidi;
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
    int requestedSidechainBusIndex = -1;
    int sidechainBusIndex = -1;
    juce::AudioBuffer<float> buffer;
    PluginSlotPowerTracker powerTracker;
};

struct PluginProcessorBank::StripChain {
    StripChain(int maxBlockSize, bool nonRealtime)
        : audio(2, std::max(1, maxBlockSize)), midi(nonRealtime) {}

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
    bool hasInstrument = false;
    uint64_t lastRemoteStateChangeCounter = 0;
    uint64_t lastRemoteLatencyChangeCounter = 0;
    juce::AudioBuffer<float> audio;
    PluginMIDIBuffer midi;
    std::shared_ptr<PluginMidiActivity> midiActivity =
        std::make_shared<PluginMidiActivity>();
    // Prepared once, then written only for actual events. Empty instrument
    // blocks must not clear a 12-KiB packet array on every device callback.
    std::array<plugin_host::MidiEvent,
               plugin_host::kMaximumMidiEventsPerBlock> hostedMidiEvents{};
    int processorLatencySamples = 0;
    int pipelineLatencySamples = 0;
    int latencySamples = 0;
    double tailSeconds = 0.0;
};


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

PluginProcessorBank::StateSnapshot PluginProcessorBank::snapshotStates(
    const std::string& stripId) {
    StateSnapshot snapshot;
    size_t totalBytes = 0;

    for (auto& chain : chains) {
        if (chain == nullptr || (!stripId.empty() && chain->stripId != stripId))
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
                blob.stripId = chain->stripId;
                blob.slotId = node->slotId;
                blob.stateResource = node->stateResource;
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
            if (node == nullptr)
                continue;
            if (node->instance == nullptr) {
                snapshot.warnings.push_back(
                    "No live instance available for plug-in slot " + node->slotId);
                continue;
            }

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
            if (node->deferredMidi != nullptr) {
                const uint64_t dropped = node->deferredMidi->takeDroppedEvents();
                if (dropped != 0) {
                    snapshot.warnings.push_back(
                        "Deferred MIDI overflow for plug-in slot " + node->slotId
                        + "; sent All Sound Off and dropped "
                        + std::to_string(dropped) + " events");
                }
            }
            StateBlob blob;
            blob.stripId = chain->stripId;
            blob.slotId = node->slotId;
            blob.stateResource = node->stateResource;
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
    return stripIndex < chains.size() && chains[stripIndex] != nullptr
        && chains[stripIndex]->hasInstrument;
}

void PluginProcessorBank::addStripMidiEvent(size_t stripIndex, const juce::MidiMessage& message,
                                            int samplePosition) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    chains[stripIndex]->midi.add(message, samplePosition);
}

void PluginProcessorBank::addStripMidiEvent(size_t stripIndex,
                                            const uint8_t* data, int numBytes,
                                            int samplePosition) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    chains[stripIndex]->midi.add(data, numBytes, samplePosition);
}

uint64_t PluginProcessorBank::rejectedMidiEvents() const noexcept {
    uint64_t rejected = 0;
    for (const auto& chain : chains)
        if (chain != nullptr)
            rejected += chain->midi.rejectedEvents();
    return rejected;
}

uint64_t PluginProcessorBank::missedOutputBlocks() const noexcept {
    uint64_t total = 0;
    for (const auto& chain : chains) {
        if (chain != nullptr && chain->hostedProcess != nullptr
            && chain->hostedProcess->process != nullptr) {
            total += chain->hostedProcess->process->missedOutputBlocks();
        }
    }
    return total;
}

uint64_t PluginProcessorBank::missedInputBlocks() const noexcept {
    uint64_t total = 0;
    for (const auto& chain : chains) {
        if (chain != nullptr && chain->hostedProcess != nullptr
            && chain->hostedProcess->process != nullptr) {
            total += chain->hostedProcess->process->missedInputBlocks();
        }
    }
    return total;
}

uint64_t PluginProcessorBank::missedControlEvents() const noexcept {
    uint64_t total = 0;
    for (const auto& chain : chains) {
        if (chain != nullptr && chain->hostedProcess != nullptr
            && chain->hostedProcess->process != nullptr) {
            total += chain->hostedProcess->process->missedControlEvents();
        }
    }
    return total;
}

void PluginProcessorBank::clearStripMidi(size_t stripIndex) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    chains[stripIndex]->midi.clear();
}

void PluginProcessorBank::injectAllNotesOff() noexcept {
    for (auto& chain : chains) {
        if (chain != nullptr) {
            chain->midi.makeRoomForPanic(16 * 2);
            for (int ch = 1; ch <= 16; ++ch) {
                chain->midi.add(juce::MidiMessage::allNotesOff(ch), 0);
                // Release sustained voices, but do not send All Sound Off
                // (CC 120): that kills envelopes immediately and can click
                // on Stop/seek instead of letting the synth's release/tail
                // run through the normal mixer path.
                chain->midi.add(juce::MidiMessage::controllerEvent(ch, 64, 0), 0);
            }
        }
    }
}

void PluginProcessorBank::injectAllSoundOff() noexcept {
    for (auto& chain : chains) {
        if (chain == nullptr)
            continue;
        chain->midi.makeRoomForPanic(16 * 3);
        for (int ch = 1; ch <= 16; ++ch) {
            chain->midi.add(juce::MidiMessage::allSoundOff(ch), 0);
            chain->midi.add(juce::MidiMessage::controllerEvent(ch, 121, 0), 0);
            chain->midi.add(juce::MidiMessage::pitchWheel(ch, 8192), 0);
        }
    }
}

void PluginProcessorBank::processChain(void* context, float* left, float* right,
                                       int numSamples,
                                       const MixSidechainInput* sidechains,
                                       uint32_t sidechainCount) noexcept {
    auto& chain = *static_cast<StripChain*>(context);
    if (chain.hostedProcess != nullptr
        && chain.hostedProcess->process != nullptr) {
        const auto midiCopy = copyPluginMIDIEventsToHost(
            chain.midi.buffer(), chain.hostedMidiEvents.data(),
            static_cast<uint32_t>(chain.hostedMidiEvents.size()), numSamples);
        chain.midi.recordRejected(midiCopy.rejected);

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

        (void)chain.hostedProcess->process->processBlock(
            left, right, static_cast<uint32_t>(numSamples), chain.hostedMidiEvents.data(),
            midiCopy.copied, nullptr, 0, transport, sidechains, sidechainCount,
            chain.hasInstrument);
        chain.midi.clear();
        if (chain.activePluginIndexTelemetry != nullptr)
            chain.activePluginIndexTelemetry->store(
                std::numeric_limits<uint32_t>::max(), std::memory_order_release);
        return;
    }

    float* stereoChannels[] = {left, right};

    const bool hasMidi = !chain.midi.buffer().isEmpty();
    // Consume once before vendor processing: instruments/FX may modify MIDI.
    // The helper owns this fixed state, including blocks without new packets.
    for (const juce::MidiMessageMetadata event : chain.midi.buffer())
        chain.midiActivity->consume(event.data, event.numBytes);

    uint32_t nodeIndex = 0;
    for (auto& node : chain.nodes) {
        const uint32_t pluginSlotIndex = nodeIndex;
        if (chain.activePluginIndexTelemetry != nullptr)
            chain.activePluginIndexTelemetry->store(nodeIndex,
                                                     std::memory_order_release);
        ++nodeIndex;
        const MixSidechainInput* nodeSidechain = nullptr;
        for (uint32_t feedIndex = 0;
             sidechains != nullptr && feedIndex < sidechainCount; ++feedIndex) {
            const auto& feed = sidechains[feedIndex];
            if (feed.pluginSlotIndex == pluginSlotIndex
                && feed.inputBusIndex
                    == static_cast<uint32_t>(std::max(node->sidechainBusIndex, 0))) {
                nodeSidechain = &feed;
                break;
            }
        }
        if (node->missingInstrument
            || (node->instrument && node->faulted.load(std::memory_order_relaxed))) {
            chain.audio.setDataToReferTo(stereoChannels, 2, numSamples);
            chain.audio.clear();
            continue;
        }
        if (node->instance == nullptr || node->faulted.load(std::memory_order_relaxed))
            continue;

        // Only this DSP thread applies requests to the decay accumulator.
        // Explicit parking cannot be cancelled by input or predictive wake.
        node->powerTracker.beginBlockRealtime();
        if (node->powerTracker.state() == PluginPowerState::Parked)
            continue;

        bool hasAudioInput = false;
        // Instrument activity comes from MIDI; scanning its incoming silent
        // audio cannot change the wake decision. Effects still inspect their
        // actual post-previous-insert input so tail/suspension semantics agree.
        if (!node->instrument && !hasMidi) {
            for (int i = 0; i < numSamples; ++i) {
                if (std::abs(left[i]) > 1.0e-5f || std::abs(right[i]) > 1.0e-5f) {
                    hasAudioInput = true;
                    break;
                }
            }
            if (!hasAudioInput && nodeSidechain != nullptr
                && nodeSidechain->active && nodeSidechain->left != nullptr
                && nodeSidechain->right != nullptr) {
                for (int i = 0; i < numSamples; ++i) {
                    if (std::abs(nodeSidechain->left[i]) > 1.0e-5f
                        || std::abs(nodeSidechain->right[i]) > 1.0e-5f) {
                        hasAudioInput = true;
                        break;
                    }
                }
            }
        }

        const bool hasDeferredMidi = node->deferredMidi != nullptr
            && node->deferredMidi->hasPending();
        const bool hasInput = node->instrument
            ? (hasMidi || hasDeferredMidi || chain.midiActivity->hasActiveNotes())
            : (hasAudioInput || hasMidi);
        if (hasInput) {
            // Immediate instantaneous wake-up (< 0.05 ms) if incoming signal enters
            if (!node->powerTracker.isProcessingNeeded()) {
                node->powerTracker.forceAwake();
            }
        } else if (!node->powerTracker.isProcessingNeeded()) {
            // Suspended or parked: skip execution completely (O(1))
            continue;
        }

        if (node->stateCaptureRequested.load(std::memory_order_acquire)) {
            if (node->deferredMidi != nullptr)
                node->deferredMidi->capture(chain.midi.buffer());
            continue;
        }
        node->activeCalls.fetch_add(1, std::memory_order_acq_rel);
        if (node->stateCaptureRequested.load(std::memory_order_acquire)) {
            node->activeCalls.fetch_sub(1, std::memory_order_acq_rel);
            if (node->deferredMidi != nullptr)
                node->deferredMidi->capture(chain.midi.buffer());
            continue;
        }

        bool replayingDeferredMidi = false;
        if (node->deferredMidi != nullptr && node->replayMidi != nullptr
            && node->deferredMidi->hasPending()) {
            auto& replay = *node->replayMidi;
            replay.clear();
            (void)node->deferredMidi->replayInto(replay);
            for (const juce::MidiMessageMetadata event : chain.midi.buffer()) {
                if (!replay.add(event.data, event.numBytes, event.samplePosition))
                    (void)node->deferredMidi->captureEvent(event);
            }
            chain.midi.swapContents(replay);
            replayingDeferredMidi = true;
        }

        const auto restoreCurrentMidi = [&]() noexcept {
            if (!replayingDeferredMidi)
                return;
            chain.midi.swapContents(*node->replayMidi);
            node->replayMidi->clear();
            replayingDeferredMidi = false;
        };

        try {
            const int inChannels = node->instance->getTotalNumInputChannels();
            const int outChannels = node->instance->getTotalNumOutputChannels();

            // Mono-in folding: if plugin accepts 1 channel and input is stereo, sum L+R
            if (inChannels == 1 && node->requiredChannels <= 2) {
                for (int i = 0; i < numSamples; ++i)
                    left[i] = 0.5f * (left[i] + right[i]);
            }

            if (node->sidechainBusIndex > 0) {
                const int samplesToProcess = std::min(
                    numSamples, node->buffer.getNumSamples());
                if (samplesToProcess <= 0) {
                    restoreCurrentMidi();
                    node->activeCalls.fetch_sub(1, std::memory_order_acq_rel);
                    continue;
                }
                for (int channel = 0; channel < node->requiredChannels; ++channel)
                    std::fill_n(node->buffer.getWritePointer(channel),
                                samplesToProcess, 0.0f);

                auto& instance = *node->instance;
                const int mainInputChannels = instance.getChannelCountOfBus(true, 0);
                for (int channel = 0; channel < mainInputChannels; ++channel) {
                    const int bufferChannel =
                        instance.getChannelIndexInProcessBlockBuffer(true, 0, channel);
                    if (bufferChannel < 0 || bufferChannel >= node->requiredChannels)
                        continue;
                    float* destination = node->buffer.getWritePointer(bufferChannel);
                    if (mainInputChannels == 1) {
                        for (int sample = 0; sample < samplesToProcess; ++sample)
                            destination[sample] = mix_math::monoSum(left[sample],
                                                                   right[sample]);
                    } else if (channel == 0 || channel == 1) {
                        const float* source = channel == 0 ? left : right;
                        std::memcpy(destination, source,
                                    sizeof(float) * static_cast<size_t>(samplesToProcess));
                    }
                }

                const int sidechainChannels = instance.getChannelCountOfBus(
                    true, node->sidechainBusIndex);
                for (int channel = 0; channel < sidechainChannels; ++channel) {
                    const int bufferChannel = instance.getChannelIndexInProcessBlockBuffer(
                        true, node->sidechainBusIndex, channel);
                    if (bufferChannel < 0 || bufferChannel >= node->requiredChannels)
                        continue;
                    float* destination = node->buffer.getWritePointer(bufferChannel);
                    if (nodeSidechain == nullptr || !nodeSidechain->active
                        || nodeSidechain->left == nullptr
                        || nodeSidechain->right == nullptr)
                        continue;
                    for (int sample = 0; sample < samplesToProcess; ++sample) {
                        const float sourceLeft = nodeSidechain->left[sample];
                        const float sourceRight = nodeSidechain->right[sample];
                        switch (nodeSidechain->channelMode) {
                            case SidechainChannelMode::MonoSum:
                                destination[sample] = mix_math::monoSum(
                                    sourceLeft, sourceRight);
                                break;
                            case SidechainChannelMode::Left:
                                destination[sample] = sourceLeft;
                                break;
                            case SidechainChannelMode::Right:
                                destination[sample] = sourceRight;
                                break;
                            case SidechainChannelMode::Automatic:
                            default:
                                if (sidechainChannels == 1)
                                    destination[sample] = mix_math::monoSum(
                                        sourceLeft, sourceRight);
                                else if (channel == 0)
                                    destination[sample] = sourceLeft;
                                else if (channel == 1)
                                    destination[sample] = sourceRight;
                                break;
                        }
                    }
                }

                juce::AudioBuffer<float> activeBuffer(
                    node->buffer.getArrayOfWritePointers(),
                    node->requiredChannels, samplesToProcess);
                if (node->bypassed.load(std::memory_order_relaxed))
                    instance.processBlockBypassed(activeBuffer, chain.midi.buffer());
                else
                    instance.processBlock(activeBuffer, chain.midi.buffer());

                const int mainOutputChannels = instance.getChannelCountOfBus(false, 0);
                const int outputLeftChannel = mainOutputChannels > 0
                    ? instance.getChannelIndexInProcessBlockBuffer(false, 0, 0) : -1;
                const int outputRightChannel = mainOutputChannels > 1
                    ? instance.getChannelIndexInProcessBlockBuffer(false, 0, 1)
                    : outputLeftChannel;
                if (outputLeftChannel >= 0
                    && outputLeftChannel < node->requiredChannels)
                    std::memcpy(left, node->buffer.getReadPointer(outputLeftChannel),
                                sizeof(float) * static_cast<size_t>(samplesToProcess));
                else
                    std::fill_n(left, samplesToProcess, 0.0f);
                if (outputRightChannel >= 0
                    && outputRightChannel < node->requiredChannels)
                    std::memcpy(right, node->buffer.getReadPointer(outputRightChannel),
                                sizeof(float) * static_cast<size_t>(samplesToProcess));
                else
                    std::copy_n(left, samplesToProcess, right);
            } else if (node->requiredChannels > 2) {
                const int samplesToProcess = std::min(numSamples, node->buffer.getNumSamples());
                if (samplesToProcess <= 0) {
                    restoreCurrentMidi();
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
                    node->instance->processBlockBypassed(activeBuf, chain.midi.buffer());
                else
                    node->instance->processBlock(activeBuf, chain.midi.buffer());

                std::memcpy(left, node->buffer.getReadPointer(0), bytesToCopy);
                std::memcpy(right, node->buffer.getReadPointer(1), bytesToCopy);
            } else {
                chain.audio.setDataToReferTo(stereoChannels, 2, numSamples);
                if (node->bypassed.load(std::memory_order_relaxed))
                    node->instance->processBlockBypassed(chain.audio, chain.midi.buffer());
                else
                    node->instance->processBlock(chain.audio, chain.midi.buffer());

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
        restoreCurrentMidi();
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
    int hostedPipelineLatencySamples,
    const std::function<void(uint32_t, const std::string&)>& progress,
    const std::function<bool()>& cancelled,
    const PluginDelayBank* previousDelayBank,
    std::string_view retryOnlyStripId) {
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
    uint32_t completedSlots = 0;
    for (size_t stripIndex = 0; stripIndex < graph.strips.size(); ++stripIndex) {
        // Superseded document/chain requests cannot keep creating helpers.
        // An already-started helper has its own bounded initialization timeout.
        if (cancelled && cancelled()) return {};
        const auto* slots = slotsForStrip(project, graph.strips[stripIndex]);
        if (slots == nullptr || slots->empty()) continue;
        const bool reportProgress = pluginRetryIncludesStrip(
            retryOnlyStripId, graph.strips[stripIndex].id);
        const auto* sourceTrack = trackForStrip(project, graph.strips[stripIndex]);
        const bool trackRecordArmed = sourceTrack != nullptr && sourceTrack->recordArmed;
        const bool trackInputMonitoring = sourceTrack != nullptr
            && sourceTrack->inputMonitoring;
        // Budget the complete prepared bank, including reused vendors. Partial
        // chains must not pass a larger private snapshot to an isolated child.
        if (slots->size() > kMaximumSlotsPerBank - slotCount) {
            result.warnings.push_back("Plug-in bank exceeds 128 slots; chain skipped: "
                + graph.strips[stripIndex].name);
            if (reportProgress) {
                completedSlots += static_cast<uint32_t>(slots->size());
                if (progress) progress(completedSlots, graph.strips[stripIndex].name);
            }
            continue;
        }
        if (executionMode == ExecutionMode::IsolatedProcess
            && isolatedChainCount >= kMaximumIsolatedChains) {
            result.warnings.push_back("Plug-in bank exceeds 32 isolated chains; chain skipped: "
                + graph.strips[stripIndex].name);
            if (reportProgress) {
                completedSlots += static_cast<uint32_t>(slots->size());
                if (progress) progress(completedSlots, graph.strips[stripIndex].name);
            }
            continue;
        }
        slotCount += slots->size();
        if (executionMode == ExecutionMode::IsolatedProcess) ++isolatedChainCount;
        if (reportProgress && progress)
            progress(completedSlots, graph.strips[stripIndex].name
                + " · Preparing plug-in chain");
        auto chain = std::make_unique<StripChain>(maximumBlockSize, nonRealtime);
        chain->stripId = graph.strips[stripIndex].id;
        chain->sampleRate = sampleRate;
        chain->sharedBlockCapacity = maximumBlockSize;

        if (executionMode == ExecutionMode::IsolatedProcess) {
            if (!reportProgress && previousBank != nullptr) {
                const StripChain* retainedChain = nullptr;
                for (const auto& candidate : previousBank->chains) {
                    if (candidate == nullptr
                        || candidate->stripId != chain->stripId
                        || std::abs(candidate->sampleRate - sampleRate) >= 1.0e-6
                        || candidate->sharedBlockCapacity != maximumBlockSize
                        || candidate->nodes.size() != slots->size())
                        continue;
                    bool identical = true;
                    for (size_t index = 0; index < slots->size(); ++index) {
                        const auto& slot = (*slots)[index];
                        const auto& node = candidate->nodes[index];
                        identical = identical && node != nullptr
                            && node->slotId == slot.id
                            && node->pluginIdentifier == slot.plugin.identifier
                            && node->instrument == slot.plugin.instrument
                            && node->stateResource == slot.stateResource
                            && node->requestedSidechainBusIndex
                                == requestedSidechainBusIndex(slot);
                    }
                    if (identical) {
                        retainedChain = candidate.get();
                        break;
                    }
                }

                if (retainedChain != nullptr) {
                    // A targeted retry must not recreate or re-open unrelated
                    // chains, even if those chains are already degraded. Keep
                    // their current nodes and helper alive exactly as-is.
                    chain->nodes = retainedChain->nodes;
                    chain->hostedProcess = retainedChain->hostedProcess;
                    chain->hostFailed = retainedChain->hostFailed;
                    // Transport is refreshed on the next callback before DSP.
                    // MIDI voice state is callback-owned; share its small
                    // object rather than racing a worker-thread copy.
                    chain->midiActivity = retainedChain->midiActivity;
                    chain->activePluginIndexTelemetry =
                        retainedChain->activePluginIndexTelemetry;
                    if (chain->hostedProcess != nullptr
                        && chain->hostedProcess->process != nullptr) {
                        chain->lastRemoteStateChangeCounter =
                            chain->hostedProcess->process->stateChangeCounter();
                        chain->lastRemoteLatencyChangeCounter =
                            chain->hostedProcess->process->latencyChangeCounter();
                    }
                    chain->hasInstrument = retainedChain->hasInstrument;
                    chain->processorLatencySamples =
                        retainedChain->processorLatencySamples;
                    chain->pipelineLatencySamples = std::max(
                        0, hostedPipelineLatencySamples);
                    chain->latencySamples = static_cast<int>(std::min<int64_t>(
                        static_cast<int64_t>(chain->processorLatencySamples)
                            + chain->pipelineLatencySamples,
                        INT_MAX));
                    chain->tailSeconds = retainedChain->tailSeconds;
                    bank->hasAnyPlugins = true;
                    bank->maximumLatencySamples = std::max(
                        bank->maximumLatencySamples, chain->latencySamples);
                    bank->processorEntries[stripIndex] = {
                        chain.get(), nullptr, processChain};
                    stripProcessorLatencies[stripIndex] =
                        static_cast<uint32_t>(chain->latencySamples);
                    stripProcessorTails[stripIndex] = chain->tailSeconds;
                    bank->chains[stripIndex] = std::move(chain);
                    continue;
                }
            }

            const StripChain* reusableChain = nullptr;
            if (retryOnlyStripId.empty() && previousBank != nullptr) {
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
                            && node->stateResource == slot.stateResource
                            && node->requestedSidechainBusIndex
                                == requestedSidechainBusIndex(slot);
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
                // History can restore a different guard without changing the
                // vendor chain identity. Synchronize the requested snapshot;
                // never reload a healthy instance merely to pin it awake.
                for (size_t index = 0; index < slots->size(); ++index)
                    (void)chain->hostedProcess->process->requestPowerControl(
                        static_cast<uint32_t>(index), (*slots)[index].keepAwake
                            ? PluginPowerControl::KeepAwakeEnable
                            : PluginPowerControl::KeepAwakeDisable);
                for (size_t index = 0; index < slots->size(); ++index) {
                    (void)chain->hostedProcess->process->requestPowerControl(
                        static_cast<uint32_t>(index), trackRecordArmed
                            ? PluginPowerControl::RecordArmedEnable
                            : PluginPowerControl::RecordArmedDisable);
                    (void)chain->hostedProcess->process->requestPowerControl(
                        static_cast<uint32_t>(index), trackInputMonitoring
                            ? PluginPowerControl::InputMonitoringEnable
                            : PluginPowerControl::InputMonitoringDisable);
                }
                for (size_t index = 0; index < slots->size(); ++index) {
                    const auto bypassed = (*slots)[index].bypassed;
                    if (chain->nodes[index]->bypassed.load(std::memory_order_acquire) != bypassed
                        && chain->hostedProcess->process->requestPowerControl(
                            static_cast<uint32_t>(index), bypassed
                                ? PluginPowerControl::BypassEnable : PluginPowerControl::BypassDisable))
                        chain->nodes[index]->bypassed.store(bypassed, std::memory_order_release);
                }
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
                                if (index >= slots->size()
                                    || oldNode->stateResource != (*slots)[index].stateResource)
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
                                blob.stripId = old.stripId;
                                blob.slotId = oldNode->slotId;
                                blob.stateResource = oldNode->stateResource;
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
                    auto node = std::make_shared<Node>(slot.plugin.instrument);
                    node->slotId = slot.id;
                    node->pluginIdentifier = slot.plugin.identifier;
                    node->stateResource = slot.stateResource;
                    node->bypassed.store(slot.bypassed, std::memory_order_relaxed);
                    node->loadState = "loading";
                    PluginPowerFlags flags;
                    flags.keepAwake = slot.keepAwake;
                    flags.isInstrument = slot.plugin.instrument;
                    flags.trackRecordArmed = trackRecordArmed;
                    flags.trackInputMonitoring = trackInputMonitoring;
                    node->powerTracker.prepare(slot.id, sampleRate, 0.0, flags);
                    chain->nodes.push_back(std::move(node));
                }

                std::string hostError;
                if (isolatedChainCount <= kMaximumIsolatedChains
                    && !chain->nodes.empty()) {
                    auto hosted = std::make_shared<StripChain::HostedProcess>();
                    if (createPrivateHostSnapshot(graph.strips[stripIndex], *slots,
                            trackRecordArmed, trackInputMonitoring,
                            resources, chainStates, sampleRate,
                            hosted->projectDirectory, hostError)) {
                        hosted->process = std::make_unique<PluginHostProcess>();
                        const uint64_t hostGeneration =
                            nextPluginHostGeneration.fetch_add(1, std::memory_order_relaxed);
                        if (hosted->process->start(pluginHostExecutable(),
                                hostGeneration,
                                static_cast<uint32_t>(maximumBlockSize), hostError,
                                sampleRate, hosted->projectDirectory,
                                pluginRegistryFile(), [&](uint32_t index) {
                                    if (reportProgress && progress && index < slots->size())
                                        progress(completedSlots + index,
                                            graph.strips[stripIndex].name + " · "
                                            + (*slots)[index].plugin.name);
                                })) {
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
                            const bool isInfiniteTail = std::isinf(hostTail) || hostTail >= 3600.0;
                            chain->tailSeconds = isInfiniteTail
                                ? std::numeric_limits<double>::infinity()
                                : ((std::isfinite(hostTail) && hostTail > 0.0) ? hostTail : 0.0);
                            for (size_t i = 0; i < chain->nodes.size(); ++i) {
                                auto& node = chain->nodes[i];
                                if (node != nullptr) {
                                    PluginPowerFlags pflags = node->powerTracker.getFlags();
                                    if (isInfiniteTail)
                                        pflags.infiniteTail = true;
                                    pflags.trackRecordArmed = trackRecordArmed;
                                    pflags.trackInputMonitoring = trackInputMonitoring;
                                    node->powerTracker.prepare(node->slotId, sampleRate, chain->tailSeconds, pflags);
                                }
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
            chain->hasInstrument = std::any_of(
                chain->nodes.begin(), chain->nodes.end(),
                [](const auto& node) { return node != nullptr && node->instrument; });
            bank->maximumLatencySamples = std::max(
                bank->maximumLatencySamples, chain->latencySamples);
            bank->processorEntries[stripIndex] = {
                chain.get(), nullptr, processChain};
            stripProcessorLatencies[stripIndex] =
                static_cast<uint32_t>(chain->latencySamples);
            stripProcessorTails[stripIndex] = chain->tailSeconds;
            if (reportProgress) {
                completedSlots += static_cast<uint32_t>(chain->nodes.size());
                if (progress) progress(completedSlots, graph.strips[stripIndex].name);
            }
            bank->chains[stripIndex] = std::move(chain);
            continue;
        }

        for (const auto& slot : *slots) {
            if (reportProgress && progress) progress(completedSlots + static_cast<uint32_t>(chain->nodes.size()),
                graph.strips[stripIndex].name + " · " + slot.plugin.name);
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
                                && candidate->instrument == slot.plugin.instrument
                                && candidate->stateResource == slot.stateResource
                                && candidate->requestedSidechainBusIndex
                                    == requestedSidechainBusIndex(slot);
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
                reusableNode->powerTracker.setRecordArmed(trackRecordArmed);
                reusableNode->powerTracker.setInputMonitoring(trackInputMonitoring);
                try {
                    chain->latencySamples = static_cast<int>(std::min<uint64_t>(
                        static_cast<uint64_t>(chain->latencySamples)
                            + static_cast<uint32_t>(reusableNode->instance != nullptr
                                ? std::max(0, reusableNode->instance->getLatencySamples())
                                : 0),
                        static_cast<uint64_t>(INT_MAX)));
                    if (reusableNode->instance != nullptr) {
                        const double tail = reusableNode->instance->getTailLengthSeconds();
                        const bool isInf = std::isinf(tail) || tail >= 3600.0;
                        if (isInf) {
                            chain->tailSeconds = std::numeric_limits<double>::infinity();
                            PluginPowerFlags pflags = reusableNode->powerTracker.getFlags();
                            pflags.infiniteTail = true;
                            pflags.trackRecordArmed = trackRecordArmed;
                            pflags.trackInputMonitoring = trackInputMonitoring;
                            reusableNode->powerTracker.prepare(reusableNode->slotId, sampleRate, tail, pflags);
                        } else if (std::isfinite(tail) && tail > 0.0) {
                            chain->tailSeconds += tail;
                            PluginPowerFlags pflags = reusableNode->powerTracker.getFlags();
                            pflags.trackRecordArmed = trackRecordArmed;
                            pflags.trackInputMonitoring = trackInputMonitoring;
                            reusableNode->powerTracker.prepare(reusableNode->slotId, sampleRate, tail, pflags);
                        }
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

            auto node = std::make_shared<Node>(slot.plugin.instrument);
            node->slotId = slot.id;
            node->pluginIdentifier = slot.plugin.identifier;
            node->stateResource = slot.stateResource;
            node->requestedSidechainBusIndex = requestedSidechainBusIndex(slot);
            node->bypassed.store(slot.bypassed, std::memory_order_relaxed);
            PluginPowerFlags pflags;
            pflags.keepAwake = slot.keepAwake;
            pflags.isInstrument = slot.plugin.instrument;
            pflags.trackRecordArmed = trackRecordArmed;
            pflags.trackInputMonitoring = trackInputMonitoring;

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
                if (node->requestedSidechainBusIndex > 0) {
                    auto* sidechainBus = node->instance->getBus(
                        true, node->requestedSidechainBusIndex);
                    if (sidechainBus != nullptr && sidechainBus->enable(true)
                        && sidechainBus->getNumberOfChannels() > 0) {
                        node->sidechainBusIndex =
                            node->requestedSidechainBusIndex;
                    } else {
                        result.warnings.push_back(
                            "Plug-in sidechain input bus is unavailable: "
                            + slot.plugin.name);
                    }
                }
                node->instance->prepareToPlay(sampleRate, maximumBlockSize);

                const int ins = node->instance->getTotalNumInputChannels();
                const int outs = node->instance->getTotalNumOutputChannels();
                node->requiredChannels = std::max(2, std::max(ins, outs));
                if (node->requiredChannels > 2 || node->sidechainBusIndex > 0) {
                    node->buffer.setSize(node->requiredChannels, std::max(512, maximumBlockSize));
                    node->buffer.clear();
                }

                const StateBlob* transientState = nullptr;
                if (transientStates != nullptr) {
                    const auto saved = std::find_if(
                        transientStates->begin(), transientStates->end(),
                        [&slot, &chain](const StateBlob& state) {
                            return stateBlobMatchesSlot(state, chain->stripId, slot);
                        });
                    if (saved != transientStates->end()) transientState = &*saved;
                }
                if (transientState != nullptr) {
                    node->instance->setStateInformation(
                        transientState->data.data(),
                        static_cast<int>(transientState->data.size()));
                } else if (slot.stateResource.has_value()) {
                    std::vector<uint8_t> state;
                    std::string stateError;
                    if (extractPluginSlotState(resources, chain->stripId,
                                               slot, state, stateError)) {
                        if (state.size() <= kMaximumStateBytesPerSlot
                            && loadedStateBytes + state.size() <= kMaximumStateBytesPerBank) {
                            node->instance->setStateInformation(
                                state.data(), static_cast<int>(state.size()));
                            loadedStateBytes += state.size();
                        } else {
                            result.warnings.push_back("Plug-in state limit exceeded: " + slot.plugin.name);
                        }
                    } else {
                        result.warnings.push_back("Missing plug-in state for "
                            + slot.plugin.name + ": " + stateError);
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
                const bool isInf = std::isinf(reportedTail) || reportedTail >= 3600.0;
                if (isInf) {
                    chain->tailSeconds = std::numeric_limits<double>::infinity();
                    pflags.infiniteTail = true;
                } else if (std::isfinite(reportedTail) && reportedTail > 0.0) {
                    chain->tailSeconds += reportedTail;
                }
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
        chain->hasInstrument = std::any_of(
            chain->nodes.begin(), chain->nodes.end(),
            [](const auto& node) { return node != nullptr && node->instrument; });
        bank->maximumLatencySamples = std::max(bank->maximumLatencySamples,
                                               chain->latencySamples);
        bank->processorEntries[stripIndex] = {
            chain.get(), nullptr, processChain};
        stripProcessorLatencies[stripIndex] =
            static_cast<uint32_t>(chain->latencySamples);
        stripProcessorTails[stripIndex] = chain->tailSeconds;
        if (reportProgress) {
            completedSlots += static_cast<uint32_t>(chain->nodes.size());
            if (progress) progress(completedSlots, graph.strips[stripIndex].name);
        }
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

    // Build the bounded hosted-only traversal once. A large graph can contain
    // thousands of non-hosted strips; callback prewarm must not walk them.
    for (uint32_t strip = 0; strip < bank->chains.size(); ++strip)
        if (bank->chains[strip] != nullptr)
            bank->hostedStripIndices.push_back(strip);
    bank->stripProcessorLatencySamples = std::move(stripProcessorLatencies);
    result.delayBank = PluginDelayBank::build(
        graph, bank->stripProcessorLatencySamples, sampleRate,
        result.warnings, previousDelayBank);
    // Subscribe only after preparation and state restore. Notifications from
    // those setup calls describe the latency already measured above and must
    // not trigger a rebuild loop immediately after publication.
    for (auto& chain : bank->chains)
        if (chain != nullptr)
            for (auto& node : chain->nodes) {
                // Identity lookup is prepared once, including the isolated
                // metadata copy. Dispatch never asks vendors to enumerate or
                // allocate a parameter list on the audio callback.
                if (!node->bindingsPrepared) {
                    for (const auto& parameter : bank->parametersForSlot(
                             chain->stripId, node->slotId))
                        node->parameterBindings.push_back({parameter.parameterId, parameter.index});
                    std::sort(node->parameterBindings.begin(), node->parameterBindings.end(),
                        [](const PluginParameterBinding& a, const PluginParameterBinding& b) {
                            return a.id < b.id;
                        });
                    node->bindingsPrepared = true;
                }
                if (node->instance != nullptr)
                    node->instance->addListener(bank.get());
            }

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
PluginProcessorBank::createEditor(const std::string& stripId,
                                  const std::string& slotId) {
    jassert(juce::MessageManager::getInstance()->isThisTheMessageThread());
    for (auto& chain : chains)
        if (chain != nullptr && chain->stripId == stripId)
            for (auto& node : chain->nodes)
                if (node->slotId == slotId && node->instance != nullptr) {
                    try {
                        if (node->instance->hasEditor())
                            return std::unique_ptr<juce::AudioProcessorEditor>(
                                node->instance->createEditorAndMakeActive());
                    } catch (...) {
                        node->faulted.store(true, std::memory_order_relaxed);
                        return {};
                    }
                }
    return {};
}

bool PluginProcessorBank::openHostedEditor(const std::string& stripId,
                                           const std::string& slotId) {
    for (const auto& chain : chains) {
        if (chain == nullptr || chain->stripId != stripId
            || chain->hostedProcess == nullptr
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

bool PluginProcessorBank::closeHostedEditor(const std::string& stripId,
                                            const std::string& slotId) {
    for (const auto& chain : chains) {
        if (chain == nullptr || chain->stripId != stripId
            || chain->hostedProcess == nullptr
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

std::vector<PluginEditorBypassRequest>
PluginProcessorBank::takeEditorBypassRequests() {
    jassert(juce::MessageManager::getInstance()->isThisTheMessageThread());
    std::vector<PluginEditorBypassRequest> requests;
    for (const auto& chain : chains) {
        if (chain == nullptr || chain->hostedProcess == nullptr
            || chain->hostedProcess->process == nullptr)
            continue;
        auto& process = *chain->hostedProcess->process;
        const size_t count = std::min(chain->nodes.size(),
            static_cast<size_t>(plugin_host::kMaximumPluginSlotsPerChain));
        for (size_t slotIndex = 0; slotIndex < count; ++slotIndex) {
            const auto& node = chain->nodes[slotIndex];
            if (node == nullptr || slotIndex > std::numeric_limits<uint32_t>::max())
                continue;
            bool bypassed = false;
            if (process.takeEditorBypassRequest(
                    static_cast<uint32_t>(slotIndex), bypassed))
                requests.push_back({chain->stripId, node->slotId, bypassed});
        }
    }
    return requests;
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
                    if (static_cast<size_t>(paramIndex) < node.valueListeners.size()
                        && node.valueListeners[static_cast<size_t>(paramIndex)] != nullptr)
                        node.valueListeners[static_cast<size_t>(paramIndex)]->parameterValueChanged(
                            paramIndex, param->getValue());
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

PluginSlotLookup PluginProcessorBank::findSlot(const std::string& stripId,
                                               const std::string& slotId) const noexcept {
    PluginSlotLookup result;
    for (size_t stripIndex = 0; stripIndex < chains.size(); ++stripIndex) {
        const auto& chain = chains[stripIndex];
        if (chain == nullptr)
            continue;
        for (size_t slotIndex = 0; slotIndex < chain->nodes.size(); ++slotIndex) {
            const auto& node = chain->nodes[slotIndex];
            if (node == nullptr)
                continue;
            considerPluginSlot(result, stripId, slotId, chain->stripId,
                               node->slotId, stripIndex, slotIndex);
        }
    }
    return result;
}

bool PluginProcessorBank::setPluginParameterBySlotId(const std::string& slotId,
                                                    int paramIndex, float value) noexcept {
    return setPluginParameterBySlotId({}, slotId, paramIndex, value);
}

bool PluginProcessorBank::setPluginParameterBySlotId(const std::string& stripId,
                                                    const std::string& slotId,
                                                    int paramIndex, float value) noexcept {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return false;
    return setPluginParameterOnNode(
        *chains[location.stripIndex], *chains[location.stripIndex]->nodes[location.slotIndex],
        location.slotIndex, paramIndex, value);
}

bool PluginProcessorBank::setPluginParameterByTarget(
    const std::string& stripId, const std::string& slotId,
    std::string_view parameterId, float value) noexcept {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return false;
    auto& chain = *chains[location.stripIndex];
    auto& node = *chain.nodes[location.slotIndex];
    const int parameterIndex = resolvePluginParameterBinding(
        node.parameterBindings, parameterId);
    if (parameterIndex < 0)
        return false;
    return setPluginParameterOnNode(
        chain, node, location.slotIndex, parameterIndex, value);
}

bool PluginProcessorBank::setPluginParameterOnNode(
    StripChain& chain, Node& node, size_t slotIndex,
    int paramIndex, float value) noexcept {
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr) {
        if (slotIndex > std::numeric_limits<uint16_t>::max())
            return false;
        plugin_host::ParameterEvent event;
        event.slotIndex = static_cast<uint16_t>(slotIndex);
        event.parameterIndex = paramIndex;
        event.normalizedValue = std::clamp(value, 0.0f, 1.0f);
        return chain.hostedProcess->process->enqueueParameterEvent(event);
    }
    if (node.instance == nullptr)
        return false;
    if (node.stateCaptureRequested.load(std::memory_order_acquire))
        return false;
    node.activeCalls.fetch_add(1, std::memory_order_acq_rel);
    if (node.stateCaptureRequested.load(std::memory_order_acquire)) {
        node.activeCalls.fetch_sub(1, std::memory_order_acq_rel);
        return false;
    }
    bool succeeded = true;
    try {
        const auto& params = node.instance->getParameters();
        if (paramIndex >= 0 && paramIndex < params.size()) {
            if (auto* param = params[paramIndex]) {
                hostParameterWrites.fetch_add(1, std::memory_order_acq_rel);
                try {
                    param->setValue(std::clamp(value, 0.0f, 1.0f));
                    if (static_cast<size_t>(paramIndex) < node.valueListeners.size()
                        && node.valueListeners[static_cast<size_t>(paramIndex)] != nullptr)
                        node.valueListeners[static_cast<size_t>(paramIndex)]->parameterValueChanged(
                            paramIndex, param->getValue());
                } catch (...) {
                    hostParameterWrites.fetch_sub(1, std::memory_order_acq_rel);
                    throw;
                }
                hostParameterWrites.fetch_sub(1, std::memory_order_acq_rel);
            }
        }
    } catch (...) {
        node.faulted.store(true, std::memory_order_relaxed);
        succeeded = false;
    }
    node.activeCalls.fetch_sub(1, std::memory_order_acq_rel);
    return succeeded;
}

void PluginProcessorBank::setTrackPowerGuards(
    const std::string& trackId, bool recordArmed,
    bool inputMonitoring) noexcept {
    for (const auto& chain : chains) {
        if (chain == nullptr || chain->stripId != trackId)
            continue;
        for (size_t slotIndex = 0; slotIndex < chain->nodes.size(); ++slotIndex) {
            const auto& node = chain->nodes[slotIndex];
            if (node == nullptr)
                continue;
            node->powerTracker.setRecordArmed(recordArmed);
            node->powerTracker.setInputMonitoring(inputMonitoring);
            if (chain->hostedProcess == nullptr
                || chain->hostedProcess->process == nullptr)
                continue;
            (void)chain->hostedProcess->process->requestPowerControl(
                static_cast<uint32_t>(slotIndex), recordArmed
                    ? PluginPowerControl::RecordArmedEnable
                    : PluginPowerControl::RecordArmedDisable);
            (void)chain->hostedProcess->process->requestPowerControl(
                static_cast<uint32_t>(slotIndex), inputMonitoring
                    ? PluginPowerControl::InputMonitoringEnable
                    : PluginPowerControl::InputMonitoringDisable);
        }
    }
}

bool PluginProcessorBank::setSlotBypassed(const std::string& slotId,
                                          bool bypassed) noexcept {
    return setSlotBypassed({}, slotId, bypassed);
}

bool PluginProcessorBank::setSlotBypassed(const std::string& stripId,
                                          const std::string& slotId,
                                          bool bypassed) noexcept {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return false;
    auto& chain = *chains[location.stripIndex];
    auto& node = *chain.nodes[location.slotIndex];
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr) {
        if (!chain.hostedProcess->process->requestPowerControl(
                static_cast<uint32_t>(location.slotIndex), bypassed
                    ? PluginPowerControl::BypassEnable : PluginPowerControl::BypassDisable))
            return false;
    }
    node.bypassed.store(bypassed, std::memory_order_release);
    if (!bypassed)
        node.powerTracker.forceAwake();
    return true;
}

PluginPowerState PluginProcessorBank::getSlotPowerState(const std::string& slotId) const noexcept {
    return getStripSlotPowerState({}, slotId);
}

PluginPowerState PluginProcessorBank::getStripSlotPowerState(
    const std::string& stripId, const std::string& slotId) const noexcept {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return PluginPowerState::Unknown;
    return slotPowerState(location.stripIndex, location.slotIndex);
}

uint64_t PluginProcessorBank::getStripSlotHostGeneration(
    const std::string& stripId, const std::string& slotId) const noexcept {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return 0;
    const auto& chain = chains[location.stripIndex];
    return chain != nullptr && chain->hostedProcess != nullptr
        && chain->hostedProcess->process != nullptr
        ? chain->hostedProcess->process->generation() : 0;
}

PluginPowerState PluginProcessorBank::slotPowerState(
    size_t stripIndex, size_t slotIndex) const noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return PluginPowerState::Active;
    const auto& chain = *chains[stripIndex];
    if (slotIndex >= chain.nodes.size() || chain.nodes[slotIndex] == nullptr)
        return PluginPowerState::Active;
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr)
        return chain.hostedProcess->process->pluginSlotPowerState(slotIndex);
    return chain.nodes[slotIndex]->powerTracker.state();
}

void PluginProcessorBank::applySlotPowerControl(
    size_t stripIndex, size_t slotIndex, PluginPowerControl control) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    auto& chain = *chains[stripIndex];
    if (slotIndex >= chain.nodes.size() || chain.nodes[slotIndex] == nullptr)
        return;
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr) {
        (void)chain.hostedProcess->process->requestPowerControl(
            static_cast<uint32_t>(slotIndex), control);
        return;
    }
    auto& tracker = chain.nodes[slotIndex]->powerTracker;
    switch (control) {
        case PluginPowerControl::Wake: tracker.forceAwake(); break;
        case PluginPowerControl::Park: tracker.park(); break;
        case PluginPowerControl::Unpark: tracker.unpark(); break;
        case PluginPowerControl::KeepAwakeEnable: tracker.setKeepAwake(true); break;
        case PluginPowerControl::KeepAwakeDisable: tracker.setKeepAwake(false); break;
        case PluginPowerControl::RecordArmedEnable: tracker.setRecordArmed(true); break;
        case PluginPowerControl::RecordArmedDisable: tracker.setRecordArmed(false); break;
        case PluginPowerControl::InputMonitoringEnable: tracker.setInputMonitoring(true); break;
        case PluginPowerControl::InputMonitoringDisable: tracker.setInputMonitoring(false); break;
        case PluginPowerControl::BypassEnable:
            chain.nodes[slotIndex]->bypassed.store(true, std::memory_order_release);
            break;
        case PluginPowerControl::BypassDisable:
            chain.nodes[slotIndex]->bypassed.store(false, std::memory_order_release);
            tracker.forceAwake();
            break;
    }
}

std::string PluginProcessorBank::getSlotLoadState(const std::string& slotId) const {
    return getStripSlotLoadState({}, slotId);
}

std::string PluginProcessorBank::getStripSlotLoadState(
    const std::string& stripId, const std::string& slotId) const {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return "missing";
    const auto& chain = *chains[location.stripIndex];
    const auto& node = *chain.nodes[location.slotIndex];
    if (chain.hostedProcess != nullptr
        && (chain.hostedProcess->process == nullptr
            || !chain.hostedProcess->process->isRunning()))
        return "failed";
    if (node.faulted.load(std::memory_order_relaxed))
        return "failed";
    return node.loadState;
}

std::vector<PluginProcessorBank::ParameterInfo>
PluginProcessorBank::parametersForSlot(const std::string& slotId) const {
    return parametersForSlot({}, slotId);
}

std::vector<PluginProcessorBank::ParameterInfo>
PluginProcessorBank::parametersForSlot(const std::string& stripId,
                                       const std::string& slotId) const {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return {};
    const auto& chain = *chains[location.stripIndex];
    const auto& node = chain.nodes[location.slotIndex];
    std::vector<ParameterInfo> result;
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr) {
        std::vector<float> currentValues;
        const auto descriptors = chain.hostedProcess->process
            ->parameterDescriptorsForSlot(location.slotIndex, &currentValues);
        result.reserve(descriptors.size());
        for (size_t i = 0; i < descriptors.size(); ++i) {
            const auto& descriptor = descriptors[i];
            const auto nameEnd = std::find(std::begin(descriptor.name),
                                           std::end(descriptor.name), '\0');
            const auto labelEnd = std::find(std::begin(descriptor.label),
                                            std::end(descriptor.label), '\0');
            const auto idEnd = std::find(std::begin(descriptor.parameterId),
                                         std::end(descriptor.parameterId), '\0');
            result.push_back({descriptor.parameterIndex,
                              std::string(std::begin(descriptor.name), nameEnd),
                              std::string(std::begin(descriptor.label), labelEnd),
                              descriptor.defaultValue, descriptor.steps,
                              std::string(std::begin(descriptor.parameterId), idEnd),
                              currentValues[i], descriptor.automatable != 0});
        }
        return result;
    }
    // In-process banks only exist in the helper and offline worker; callers
    // there are on their owner thread, never the Core callback.
    if (node == nullptr || node->instance == nullptr)
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
                                  std::max(0, parameter->getNumSteps())),
                              pluginParameterId(*parameter, static_cast<uint32_t>(i)),
                              std::clamp(parameter->getValue(), 0.0f, 1.0f),
                              parameter->isAutomatable()});
        }
    } catch (...) {
        result.clear();
    }
    return result;
}

std::vector<PluginProcessorBank::SidechainBusInfo>
PluginProcessorBank::sidechainBusesForSlot(const std::string& slotId) const {
    return sidechainBusesForSlot({}, slotId);
}

std::vector<PluginProcessorBank::SidechainBusInfo>
PluginProcessorBank::sidechainBusesForSlot(const std::string& stripId,
                                           const std::string& slotId) const {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return {};
    const auto& chain = *chains[location.stripIndex];
    const auto& node = chain.nodes[location.slotIndex];
    std::vector<SidechainBusInfo> result;
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr) {
        const auto descriptors = chain.hostedProcess->process
            ->sidechainBusDescriptorsForSlot(location.slotIndex);
        result.reserve(descriptors.size());
        for (const auto& descriptor : descriptors) {
            const auto nameEnd = std::find(std::begin(descriptor.name),
                                           std::end(descriptor.name), '\0');
            result.push_back({descriptor.busIndex, descriptor.channelCount,
                std::string(std::begin(descriptor.name), nameEnd),
                descriptor.enabled != 0});
        }
        return result;
    }
    if (node == nullptr || node->instance == nullptr)
        return result;

    // Bus enumeration is deliberately outside processChain/audio callbacks.
    // Use the current layout, falling back to the default layout for a
    // currently disabled auxiliary bus, without toggling vendor state.
    auto& processor = *node->instance;
    const int busCount = std::min<int>(
        processor.getBusCount(true),
        static_cast<int>(plugin_host::kMaximumSidechainInputBusIndex + 1));
    result.reserve(static_cast<size_t>(std::max(0, busCount - 1)));
    for (int busIndex = 1; busIndex < busCount; ++busIndex) {
        auto* bus = processor.getBus(true, busIndex);
        if (bus == nullptr)
            continue;
        auto layout = bus->getCurrentLayout();
        if (layout.isDisabled())
            layout = bus->getDefaultLayout();
        const int channelCount = layout.size();
        if (channelCount <= 0)
            continue;
        result.push_back({static_cast<uint32_t>(busIndex),
                          static_cast<uint32_t>(channelCount),
                          bus->getName().toStdString(), bus->isEnabled()});
    }
    return result;
}

bool PluginProcessorBank::sidechainBusMetadataTruncated(
    const std::string& stripId, const std::string& slotId) const noexcept {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return false;
    const auto& chain = *chains[location.stripIndex];
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr)
        return chain.hostedProcess->process->sidechainBusMetadataTruncated();
    const auto& node = chain.nodes[location.slotIndex];
    if (node == nullptr || node->instance == nullptr)
        return false;
    return node->instance->getBusCount(true)
        > static_cast<int>(plugin_host::kMaximumSidechainInputBusIndex + 1);
}

std::vector<PluginProcessorBank::ParameterValue>
PluginProcessorBank::parameterValuesForSlot(const std::string& slotId) const {
    return parameterValuesForSlot({}, slotId);
}

std::vector<PluginProcessorBank::ParameterValue>
PluginProcessorBank::parameterValuesForSlot(const std::string& stripId,
                                            const std::string& slotId) const {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return {};
    const auto& chain = chains[location.stripIndex];
    if (chain->hostedProcess == nullptr || chain->hostedProcess->process == nullptr)
        return {};
    const auto hosted = chain->hostedProcess->process
        ->parameterValuesForSlot(location.slotIndex);
    std::vector<ParameterValue> result;
    result.reserve(hosted.size());
    for (const auto& value : hosted)
        result.push_back({value.index, value.value});
    return result;
}

bool PluginProcessorBank::parameterMetadataTruncated(const std::string& slotId) const noexcept {
    return parameterMetadataTruncated({}, slotId);
}

bool PluginProcessorBank::parameterMetadataTruncated(const std::string& stripId,
                                                     const std::string& slotId) const noexcept {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return false;
    const auto& chain = *chains[location.stripIndex];
    const auto& node = chain.nodes[location.slotIndex];
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr)
        return chain.hostedProcess->process->parameterMetadataTruncated();
    return node != nullptr && node->instance != nullptr
        && node->instance->getParameters().size()
            > static_cast<int>(plugin_host::kMaximumParameterDescriptorsPerChain);
}

int PluginProcessorBank::resolvePluginParameterIndex(const std::string& slotId,
                                                     std::string_view parameterId) const noexcept {
    return resolvePluginParameterIndex({}, slotId, parameterId);
}

int PluginProcessorBank::resolvePluginParameterIndex(const std::string& stripId,
                                                     const std::string& slotId,
                                                     std::string_view parameterId) const noexcept {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return -1;
    const auto& node = chains[location.stripIndex]->nodes[location.slotIndex];
    return node != nullptr
        ? resolvePluginParameterBinding(node->parameterBindings, parameterId) : -1;
}

void PluginProcessorBank::bindParameterValueTelemetry(const std::string& slotId,
    uint32_t parameterIndex, std::atomic<float>& destination) {
    bindParameterValueTelemetry({}, slotId, parameterIndex, destination);
}

void PluginProcessorBank::bindParameterValueTelemetry(
    const std::string& stripId, const std::string& slotId,
    uint32_t parameterIndex, std::atomic<float>& destination) {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return;
    auto& node = chains[location.stripIndex]->nodes[location.slotIndex];
    if (node == nullptr || node->instance == nullptr)
        return;
    const auto& parameters = node->instance->getParameters();
    if (parameterIndex >= static_cast<uint32_t>(parameters.size())
        || parameterIndex >= plugin_host::kMaximumParameterDescriptorsPerChain
        || parameters[static_cast<int>(parameterIndex)] == nullptr)
        return;
    node->valueListeners.resize(std::min<uint32_t>(
        static_cast<uint32_t>(parameters.size()),
        plugin_host::kMaximumParameterDescriptorsPerChain));
    node->valueListeners[parameterIndex] = std::make_unique<Node::ValueListener>(
        *parameters[static_cast<int>(parameterIndex)], destination);
}

std::string PluginProcessorBank::getSlotLoadError(const std::string& slotId) const {
    return getStripSlotLoadError({}, slotId);
}

std::string PluginProcessorBank::getStripSlotLoadError(
    const std::string& stripId, const std::string& slotId) const {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return {};
    const auto& chain = *chains[location.stripIndex];
    const auto& node = chain.nodes[location.slotIndex];
    if (chain.hostedProcess != nullptr
        && (chain.hostedProcess->process == nullptr
            || !chain.hostedProcess->process->isRunning()))
        return "Isolated plug-in host exited; chain audio is temporarily unavailable";
    if (node->loadState == "missing" || node->loadState == "failed")
        return node->loadError;
    if (node->faulted.load(std::memory_order_relaxed))
        return "Plug-in raised an exception while processing audio";
    return node->loadError;
}

void PluginProcessorBank::setSlotKeepAwake(const std::string& slotId, bool keepAwake) noexcept {
    setSlotKeepAwake({}, slotId, keepAwake);
}

void PluginProcessorBank::setSlotKeepAwake(const std::string& stripId,
                                           const std::string& slotId,
                                           bool keepAwake) noexcept {
    const auto location = findSlot(stripId, slotId);
    if (!location.unique())
        return;
    applySlotPowerControl(location.stripIndex, location.slotIndex, keepAwake
        ? PluginPowerControl::KeepAwakeEnable : PluginPowerControl::KeepAwakeDisable);
}

void PluginProcessorBank::prewarmStrip(size_t stripIndex) noexcept {
    if (stripIndex >= chains.size() || chains[stripIndex] == nullptr)
        return;
    const auto& chain = *chains[stripIndex];
    if (chain.hostedProcess != nullptr && chain.hostedProcess->process != nullptr) {
        chain.hostedProcess->process->requestChainPrewarm();
        return;
    }
    for (const auto& node : chains[stripIndex]->nodes) {
        if (node != nullptr) {
            node->powerTracker.forceAwake();
        }
    }
}

void PluginProcessorBank::prewarmAllStrips() noexcept {
    for (const auto strip : hostedStripIndices)
        prewarmStrip(strip);
}

void PluginProcessorBank::prewarmSlot(const std::string& slotId) noexcept {
    prewarmSlot({}, slotId);
}

void PluginProcessorBank::prewarmSlot(const std::string& stripId,
                                      const std::string& slotId) noexcept {
    const auto location = findSlot(stripId, slotId);
    if (location.unique())
        applySlotPowerControl(location.stripIndex, location.slotIndex,
                              PluginPowerControl::Wake);
}

void PluginProcessorBank::parkSlot(const std::string& slotId) noexcept {
    parkSlot({}, slotId);
}

void PluginProcessorBank::parkSlot(const std::string& stripId,
                                   const std::string& slotId) noexcept {
    const auto location = findSlot(stripId, slotId);
    if (location.unique())
        applySlotPowerControl(location.stripIndex, location.slotIndex,
                              PluginPowerControl::Park);
}

void PluginProcessorBank::unparkSlot(const std::string& slotId) noexcept {
    unparkSlot({}, slotId);
}

void PluginProcessorBank::unparkSlot(const std::string& stripId,
                                     const std::string& slotId) noexcept {
    const auto location = findSlot(stripId, slotId);
    if (location.unique())
        applySlotPowerControl(location.stripIndex, location.slotIndex,
                              PluginPowerControl::Unpark);
}

PluginPowerStats PluginProcessorBank::powerStats() const noexcept {
    PluginPowerStats s;
    for (size_t stripIndex = 0; stripIndex < chains.size(); ++stripIndex) {
        const auto& chain = chains[stripIndex];
        if (chain == nullptr) continue;
        for (size_t slotIndex = 0; slotIndex < chain->nodes.size(); ++slotIndex) {
            const auto& node = chain->nodes[slotIndex];
            if (node == nullptr) continue;
            ++s.totalSlots;
            switch (slotPowerState(stripIndex, slotIndex)) {
                case PluginPowerState::Active: ++s.activeCount; break;
                case PluginPowerState::Quiescent: ++s.quiescentCount; break;
                case PluginPowerState::Suspended: ++s.suspendedCount; break;
                case PluginPowerState::Parked: ++s.parkedCount; break;
                case PluginPowerState::Unknown: break;
            }
        }
    }
    if (s.totalSlots > 0) {
        const size_t saved = s.suspendedCount + s.parkedCount;
        s.estimatedDSPSavingsPercent =
            (static_cast<float>(saved) / static_cast<float>(s.totalSlots)) * 100.0f;
        s.estimatedDspSavingsPercent = s.estimatedDSPSavingsPercent;
    }
    return s;
}

} // namespace resostage
