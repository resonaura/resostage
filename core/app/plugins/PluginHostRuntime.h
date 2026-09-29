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
    void applyControlEvent(const plugin_host::ParameterEvent& event) noexcept;
    bool captureStateFiles(std::string& error);
    bool consumeStateChange() noexcept;
    bool consumeLatencyChange() noexcept;
    int processorLatencySamples() const noexcept { return latestProcessorLatency; }
    bool openEditor(uint32_t slotIndex);
    bool closeEditor(uint32_t slotIndex);
    void closeAllEditors();
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
