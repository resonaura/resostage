/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "plugins/PluginHostProtocol.h"
#include "project/ProjectLoader.h"
#include "plugins/PluginProcessorBank.h"

#include <juce_core/juce_core.h>

#include <memory>
#include <string>
#include <vector>

namespace resostage {

/** In-process vendor runtime owned exclusively by the isolated host process. */
class PluginHostRuntime final {
public:
    PluginHostRuntime();
    ~PluginHostRuntime();
    bool prepare(const juce::File& snapshotDirectory,
                 const juce::File& registryFile,
                 double sampleRate, int maximumBlockSize,
                 std::atomic<uint32_t>* activePluginIndex,
                 std::string& error);
    bool process(plugin_host::AudioSlot& block) noexcept;
    /** Helper DSP only: consume fixed power mailboxes before rendering a block. */
    void applyPowerRequests(plugin_host::SharedArea& area) noexcept;
    /** Helper DSP only: publish actual per-node state after rendering. */
    void publishPowerStates(plugin_host::SharedArea& area) const noexcept;
    void applyControlEvent(const plugin_host::ParameterEvent& event) noexcept;
    bool captureStateFiles(std::string& error);
    bool consumeStateChange() noexcept;
    bool consumeLatencyChange() noexcept;
    int processorLatencySamples() const noexcept { return latestProcessorLatency; }
    bool openEditor(uint32_t slotIndex, plugin_host::SharedArea& area);
    /** Helper UI thread: refresh editor bypass controls from Core-owned tokens. */
    void syncEditorBypassStates() noexcept;
    bool closeEditor(uint32_t slotIndex);
    void closeAllEditors();
    bool hasVisibleEditors() const noexcept;
    void publishSlotStatuses(plugin_host::SharedArea& area) const noexcept;
    /** Writes bounded parameter names before the shared host becomes Ready. */
    void publishParameterDescriptors(plugin_host::SharedArea& area) const noexcept;
    PluginProcessorBank* bank() noexcept;
    const std::vector<std::string>& warnings() const noexcept;

private:
    struct EditorWindow;
    ProjectLoader projectLoader;
    MixGraph graph;
    PluginProcessorBank::BuildResult builtBank;
    juce::File projectDirectory;
    int planeStride = 0;
    int latestProcessorLatency = 0;
    std::vector<std::unique_ptr<EditorWindow>> editors;
};

} // namespace resostage
