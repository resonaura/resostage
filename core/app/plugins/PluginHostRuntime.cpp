/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "PluginHostRuntime.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <cmath>
#include <limits>

#if !defined(_WIN32)
#include <sys/stat.h>
#endif

namespace resostage {

struct PluginHostRuntime::EditorWindow final : juce::DocumentWindow {
    EditorWindow(const juce::String& title,
                 std::unique_ptr<juce::AudioProcessorEditor> editorIn)
        : juce::DocumentWindow(title, juce::Colours::black,
                               juce::DocumentWindow::allButtons, true),
          editor(std::move(editorIn)) {
        setUsingNativeTitleBar(true);
        setResizable(true, true);
        setWantsKeyboardFocus(true);
        if (editor != nullptr) {
            const int width = editor->getWidth() > 0 ? editor->getWidth() : 720;
            const int height = editor->getHeight() > 0 ? editor->getHeight() : 520;
            editor->setSize(width, height);
            setContentNonOwned(editor.get(), true);
        }
        centreWithSize(getWidth(), getHeight());
        setVisible(true);
        toFront(true);
        // The macOS helper bundle is an LSUIElement agent so it does not add
        // a second Dock icon. Agent windows do not become the key application
        // merely from DocumentWindow::toFront(); explicitly activate the host
        // when a plug-in editor is requested or it can appear to have vanished
        // behind the ResoStage shell.
        juce::Process::makeForegroundProcess();
    }

    ~EditorWindow() override {
        clearContentComponent();
        editor.reset();
    }

    void closeButtonPressed() override { setVisible(false); }

    uint32_t slotIndex = std::numeric_limits<uint32_t>::max();
    std::unique_ptr<juce::AudioProcessorEditor> editor;
};

PluginHostRuntime::~PluginHostRuntime() = default;
PluginHostRuntime::PluginHostRuntime() = default;

bool PluginHostRuntime::prepare(const juce::File& snapshotDirectory,
                                const juce::File& registryFile,
                                double sampleRate, int maximumBlockSize,
                                std::atomic<uint32_t>* activePluginIndex,
                                std::string& error) {
    projectDirectory = snapshotDirectory;
    if (maximumBlockSize <= 0
        || maximumBlockSize > static_cast<int>(plugin_host::kMaximumBlockSamples)) {
        error = "Plug-in host block capacity is outside the shared-memory limit";
        return false;
    }
    planeStride = maximumBlockSize;
    if (!projectLoader.open(snapshotDirectory.getFullPathName().toStdString(), error))
        return false;
    const Project& project = projectLoader.project();
    if (project.tracks.size() != 1 || project.tracks.front().plugins.empty()) {
        error = "Plug-in host snapshot must contain exactly one non-empty chain";
        return false;
    }

    // One helper owns one serial chain. The complete routing graph remains in
    // Core; its existing PDC compensates for this host's two-callback pipeline.
    MixStrip strip;
    strip.id = project.tracks.front().effectiveStripId();
    strip.name = project.tracks.front().name;
    strip.kind = StripKind::Track;
    strip.channels = 2;
    strip.projectIndex = 0;
    graph.strips.push_back(std::move(strip));
    graph.processorLayoutKey = 1;
    graph.latencyLayoutKey = 1;

    try {
        builtBank = PluginProcessorBank::build(
            project, graph, &projectLoader, registryFile,
            sampleRate, maximumBlockSize, false, nullptr, nullptr,
            PluginProcessorBank::ExecutionMode::InProcess, 0,
            [activePluginIndex](uint32_t index, const std::string&) {
                if (activePluginIndex != nullptr)
                    activePluginIndex->store(index, std::memory_order_release);
            });
    } catch (const std::exception& exception) {
        error = std::string("Plug-in chain preparation failed: ") + exception.what();
        return false;
    } catch (...) {
        error = "Plug-in chain preparation failed with an unknown exception";
        return false;
    }
    if (builtBank.bank == nullptr) {
        error = "Plug-in host did not produce a processor bank";
        return false;
    }
    builtBank.bank->setActivePluginIndexTelemetry(activePluginIndex);
    latestProcessorLatency = builtBank.bank->snapshotMaximumProcessorLatency();
    return true;
}

bool PluginHostRuntime::captureStateFiles(std::string& error) {
    if (builtBank.bank == nullptr) {
        error = "Live plug-in bank is unavailable";
        return false;
    }
    const auto snapshot = builtBank.bank->snapshotStates();
    if (!snapshot.warnings.empty()) {
        error = "Plug-in state snapshot was incomplete";
        for (const auto& warning : snapshot.warnings) {
            if (error.size() + warning.size() + 2 > 448) {
                error += "; additional diagnostics omitted";
                break;
            }
            error += "; " + warning;
        }
        return false;
    }

    // Build a complete replacement beside the published snapshot so a failed
    // plug-in serialization or disk write cannot erase the last recoverable
    // state. Directory renames stay on the same volume.
    const auto stateDirectory = projectDirectory.getChildFile("LiveState");
    const auto stagingDirectory = projectDirectory.getChildFile(
        ".LiveState-pending-" + juce::Uuid().toString().removeCharacters("{}-"));
    const auto previousDirectory = projectDirectory.getChildFile(
        ".LiveState-previous-" + juce::Uuid().toString().removeCharacters("{}-"));
    if (stagingDirectory.createDirectory().failed()) {
        error = "Could not create staged isolated plug-in state snapshot";
        return false;
    }
#if !defined(_WIN32)
    if (::chmod(stagingDirectory.getFullPathName().toRawUTF8(), 0700) != 0) {
        stagingDirectory.deleteRecursively();
        error = "Could not secure isolated plug-in state directory";
        return false;
    }
#endif

    const auto& slots = projectLoader.project().tracks.front().plugins;
    for (const auto& blob : snapshot.blobs) {
        const auto found = std::find_if(slots.begin(), slots.end(),
            [&blob](const PluginSlot& slot) { return slot.id == blob.slotId; });
        if (found == slots.end())
            continue;
        const size_t slotIndex = static_cast<size_t>(found - slots.begin());
        auto destination = stagingDirectory.getChildFile(
            "slot-" + juce::String(static_cast<juce::int64>(slotIndex)) + ".state");
        juce::TemporaryFile temporary(destination);
        auto stream = temporary.getFile().createOutputStream();
        const bool wrote = stream != nullptr
            && (blob.data.empty()
                || stream->write(blob.data.data(), blob.data.size()));
        if (stream != nullptr)
            stream->flush();
        if (!wrote || !temporary.overwriteTargetFileWithTemporary()) {
            stagingDirectory.deleteRecursively();
            error = "Could not persist isolated plug-in state for slot " + blob.slotId;
            return false;
        }
    }

    const bool hadPrevious = stateDirectory.exists();
    if (hadPrevious && !stateDirectory.moveFileTo(previousDirectory)) {
        stagingDirectory.deleteRecursively();
        error = "Could not preserve the last isolated plug-in state snapshot";
        return false;
    }
    if (!stagingDirectory.moveFileTo(stateDirectory)) {
        if (hadPrevious)
            (void)previousDirectory.moveFileTo(stateDirectory);
        stagingDirectory.deleteRecursively();
        error = "Could not publish isolated plug-in state snapshot";
        return false;
    }
    if (hadPrevious)
        (void)previousDirectory.deleteRecursively();
    return true;
}

bool PluginHostRuntime::consumeStateChange() noexcept {
    return builtBank.bank != nullptr && builtBank.bank->consumeStateChange();
}

bool PluginHostRuntime::consumeLatencyChange() noexcept {
    if (builtBank.bank == nullptr || !builtBank.bank->consumeLatencyChange())
        return false;
    latestProcessorLatency = builtBank.bank->snapshotMaximumProcessorLatency();
    return true;
}

bool PluginHostRuntime::openEditor(uint32_t slotIndex) {
    if (!juce::MessageManager::getInstance()->isThisTheMessageThread()
        || builtBank.bank == nullptr || projectLoader.project().tracks.empty())
        return false;
    if (slotIndex >= projectLoader.project().tracks.front().plugins.size())
        return false;
    // This helper is an LSUIElement agent launched by Core. Activate it before
    // creating/showing a native editor so macOS assigns the window to a visible
    // foreground app instead of leaving it behind the shell.
    juce::Process::makeForegroundProcess();
    for (auto& existing : editors) {
        if (existing != nullptr && existing->slotIndex == slotIndex) {
            existing->setVisible(true);
            existing->toFront(true);
            juce::Process::makeForegroundProcess();
            return true;
        }
    }
    if (editors.size() >= 12) {
        const auto hidden = std::find_if(editors.begin(), editors.end(),
            [](const auto& editor) { return editor == nullptr || !editor->isVisible(); });
        if (hidden == editors.end())
            return false;
        editors.erase(hidden);
    }
    const auto& slot = projectLoader.project().tracks.front().plugins[slotIndex];
    auto editor = builtBank.bank->createEditor(slot.id);
    if (editor == nullptr)
        return false;
    auto window = std::make_unique<EditorWindow>(
        juce::String(slot.plugin.name), std::move(editor));
    window->slotIndex = slotIndex;
    editors.push_back(std::move(window));
    return true;
}

bool PluginHostRuntime::closeEditor(uint32_t slotIndex) {
    if (!juce::MessageManager::getInstance()->isThisTheMessageThread())
        return false;
    for (auto& editor : editors) {
        if (editor != nullptr && editor->slotIndex == slotIndex) {
            editor->setVisible(false);
            return true;
        }
    }
    return true;
}

void PluginHostRuntime::closeAllEditors() {
    if (!juce::MessageManager::getInstance()->isThisTheMessageThread())
        return;
    for (auto& editor : editors)
        if (editor != nullptr)
            editor->setVisible(false);
}

bool PluginHostRuntime::hasVisibleEditors() const noexcept {
    for (const auto& editor : editors)
        if (editor != nullptr && editor->isVisible())
            return true;
    return false;
}

void PluginHostRuntime::publishSlotStatuses(
    plugin_host::SharedArea& area) const noexcept {
    const auto& slots = projectLoader.project().tracks.front().plugins;
    area.pluginSlotCount = static_cast<uint32_t>(std::min<size_t>(
        slots.size(), plugin_host::kMaximumPluginSlotsPerChain));
    for (uint32_t i = 0; i < area.pluginSlotCount; ++i) {
        const std::string state = builtBank.bank->getSlotLoadState(slots[i].id);
        auto status = plugin_host::PluginSlotStatus::Unknown;
        if (state == "loaded") status = plugin_host::PluginSlotStatus::Loaded;
        else if (state == "missing") status = plugin_host::PluginSlotStatus::Missing;
        else if (state == "failed") status = plugin_host::PluginSlotStatus::Failed;
        area.pluginSlotStatuses[i] = static_cast<uint8_t>(status);
        area.pluginSlotErrors[i].fill('\0');
        try {
            const auto error = builtBank.bank->getSlotLoadError(slots[i].id);
            juce::String::fromUTF8(error.c_str()).copyToUTF8(
                area.pluginSlotErrors[i].data(), area.pluginSlotErrors[i].size());
        } catch (...) {
            // Diagnostics are optional; a vendor's broken error formatting
            // must not prevent a prepared processor chain from becoming Ready.
        }
    }
}

void PluginHostRuntime::publishParameterDescriptors(
    plugin_host::SharedArea& area) const noexcept {
    area.parameterDescriptorCount = 0;
    area.parameterMetadataTruncated = 0;
    if (builtBank.bank == nullptr || projectLoader.project().tracks.empty())
        return;
    const auto& slots = projectLoader.project().tracks.front().plugins;
    try {
        for (size_t slotIndex = 0; slotIndex < slots.size(); ++slotIndex) {
            if (builtBank.bank->parameterMetadataTruncated(slots[slotIndex].id))
                area.parameterMetadataTruncated = 1;
            const auto parameters = builtBank.bank->parametersForSlot(slots[slotIndex].id);
            for (const auto& parameter : parameters) {
                if (area.parameterDescriptorCount
                    >= plugin_host::kMaximumParameterDescriptorsPerChain) {
                    area.parameterMetadataTruncated = 1;
                    return;
                }
                auto& descriptor = area.parameterDescriptors[area.parameterDescriptorCount++];
                descriptor.slotIndex = static_cast<uint16_t>(slotIndex);
                descriptor.parameterIndex = parameter.index;
                descriptor.defaultValue = parameter.defaultValue;
                descriptor.steps = parameter.steps;
                descriptor.automatable = parameter.automatable ? 1 : 0;
                juce::String(parameter.name.empty()
                    ? "Parameter " + std::to_string(parameter.index + 1)
                    : parameter.name).copyToUTF8(descriptor.name, sizeof(descriptor.name));
                juce::String(parameter.label).copyToUTF8(
                    descriptor.label, sizeof(descriptor.label));
                juce::String(parameter.parameterId).copyToUTF8(
                    descriptor.parameterId, sizeof(descriptor.parameterId));
                builtBank.bank->bindParameterValueTelemetry(slots[slotIndex].id,
                    parameter.index, area.parameterValues[area.parameterDescriptorCount - 1]);
            }
        }
    } catch (...) {
        // Metadata is optional; a vendor throwing while enumerating it must
        // not prevent the already-prepared audio chain from starting.
        area.parameterMetadataTruncated = 1;
    }
}

void PluginHostRuntime::applyPowerRequests(plugin_host::SharedArea& area) noexcept {
    if (builtBank.bank == nullptr)
        return;
    if (area.chainPrewarmRequested.load(std::memory_order_relaxed)
        && area.chainPrewarmRequested.exchange(false, std::memory_order_acq_rel))
        builtBank.bank->prewarmStrip(0);
    const auto count = std::min<uint32_t>(area.pluginSlotCount,
                                         plugin_host::kMaximumPluginSlotsPerChain);
    for (uint32_t index = 0; index < count; ++index) {
        auto& mailbox = area.pluginSlotPowerRequests[index];
        if (mailbox.load(std::memory_order_relaxed) == 0)
            continue;
        const auto requests = mailbox.exchange(0, std::memory_order_acq_rel);
        // Keep-awake is an independent guard. Explicit park/unpark dominates
        // a predictive wake in the same batch; a wake cannot cancel parking.
        constexpr PluginPowerControl order[] = {
            PluginPowerControl::KeepAwakeEnable, PluginPowerControl::KeepAwakeDisable,
            PluginPowerControl::RecordArmedEnable, PluginPowerControl::RecordArmedDisable,
            PluginPowerControl::InputMonitoringEnable,
            PluginPowerControl::InputMonitoringDisable,
            PluginPowerControl::BypassEnable, PluginPowerControl::BypassDisable,
            PluginPowerControl::Wake, PluginPowerControl::Park, PluginPowerControl::Unpark};
        for (const auto control : order)
            if (hasPluginPowerControl(requests, control))
                builtBank.bank->applySlotPowerControl(0, index, control);
    }
}

void PluginHostRuntime::publishPowerStates(plugin_host::SharedArea& area) const noexcept {
    if (builtBank.bank == nullptr)
        return;
    const auto count = std::min<uint32_t>(area.pluginSlotCount,
                                         plugin_host::kMaximumPluginSlotsPerChain);
    for (uint32_t index = 0; index < count; ++index) {
        const auto state = static_cast<uint8_t>(builtBank.bank->slotPowerState(0, index));
        auto& published = area.pluginSlotPowerStates[index];
        if (published.load(std::memory_order_relaxed) != state)
            published.store(state, std::memory_order_relaxed);
    }
}

bool PluginHostRuntime::process(plugin_host::AudioSlot& block) noexcept {
    if (builtBank.bank == nullptr || block.numSamples == 0
        || block.numSamples > plugin_host::kMaximumBlockSamples
        || block.midiEventCount > plugin_host::kMaximumMidiEventsPerBlock)
        return false;

    auto& processorBank = *builtBank.bank;
    processorBank.clearStripMidi(0);
    for (uint32_t i = 0; i < block.midiEventCount; ++i) {
        const auto& event = block.midiEvents[i];
        if (event.size == 0 || event.size > plugin_host::kMaximumMidiEventBytes
            || event.sampleOffset >= block.numSamples)
            continue;
        processorBank.addStripMidiEvent(0, event.data, static_cast<int>(event.size),
                                        static_cast<int>(event.sampleOffset));
    }
    const auto& track = projectLoader.project().tracks.front();
    for (uint32_t i = 0; i < block.parameterEventCount; ++i) {
        const auto& event = block.parameterEvents[i];
        if (event.slotIndex >= track.plugins.size())
            continue;
        if (event.parameterIndex == -2) {
            (void)processorBank.setSlotBypassed(
                track.plugins[event.slotIndex].id,
                event.normalizedValue >= 0.5f);
        } else if (event.parameterIndex >= 0) {
            processorBank.setPluginParameter(
                0, event.slotIndex, event.parameterIndex,
                event.normalizedValue);
        }
    }

    PluginTransportState transport;
    transport.sample = block.transport.sample;
    transport.sampleRate = std::isfinite(block.transport.sampleRate)
        ? block.transport.sampleRate : 48000.0;
    transport.bpm = std::isfinite(block.transport.bpm)
        ? block.transport.bpm : 120.0;
    transport.numerator = block.transport.numerator;
    transport.denominator = block.transport.denominator;
    transport.playing = block.transport.playing != 0;
    transport.recording = block.transport.recording != 0;
    transport.looping = block.transport.looping != 0;
    transport.loopStartSample = block.transport.loopStartSample;
    transport.loopEndSample = block.transport.loopEndSample;
    transport.hostTimeNanos = block.transport.hostTimeNanos;
    processorBank.publishTransport(transport);

    std::copy_n(block.input.data(), block.numSamples, block.output.data());
    std::copy_n(block.input.data() + planeStride,
                block.numSamples,
                block.output.data() + planeStride);

    const MixProcessorView view = processorBank.processorView(
        builtBank.delayBank.get());
    if (view.strips == nullptr || view.count == 0
        || view.strips[0].process == nullptr)
        return true;
    view.strips[0].process(view.strips[0].context, block.output.data(),
                           block.output.data() + planeStride,
                           static_cast<int>(block.numSamples));
    return true;
}

void PluginHostRuntime::applyControlEvent(
    const plugin_host::ParameterEvent& event) noexcept {
    if (builtBank.bank == nullptr || projectLoader.project().tracks.empty())
        return;
    const auto& slots = projectLoader.project().tracks.front().plugins;
    if (event.slotIndex >= slots.size())
        return;
    if (event.parameterIndex == -2) {
        (void)builtBank.bank->setSlotBypassed(
            slots[event.slotIndex].id, event.normalizedValue >= 0.5f);
    } else if (event.parameterIndex >= 0) {
        builtBank.bank->setPluginParameter(
            0, event.slotIndex, event.parameterIndex, event.normalizedValue);
    }
}

PluginProcessorBank* PluginHostRuntime::bank() noexcept {
    return builtBank.bank.get();
}

const std::vector<std::string>& PluginHostRuntime::warnings() const noexcept {
    return builtBank.warnings;
}

} // namespace resostage
