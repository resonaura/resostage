#pragma once

#include "project/ProjectSchema.h"

#include <juce_core/juce_core.h>

#include <mutex>
#include <optional>
#include <thread>

namespace resostage {

/**
 * Owns the crash-isolated plug-in scan helper and its device-local catalog.
 * Calls are safe from the JUCE message thread and WebServer provider thread;
 * scanning never loads third-party code into Core.
 */
class PluginCatalogService final {
public:
    PluginCatalogService();
    ~PluginCatalogService();

    PluginCatalogService(const PluginCatalogService&) = delete;
    PluginCatalogService& operator=(const PluginCatalogService&) = delete;

    /** Starts one helper scan. Returns false when a scan is already active. */
    bool startScan(bool rescanAll);

    /** Returns a bounded JSON snapshot containing scan state and catalog. */
    std::string snapshotJson() const;
    /** Resolves client ids against the scanner-owned catalog. */
    std::optional<PluginReference> findPlugin(
        const std::string& identifier) const;
    /** Device-local JUCE registry used only by non-realtime bank builders. */
    const juce::File& registryPath() const noexcept { return registryFile; }

private:
    juce::File dataDirectory;
    juce::File registryFile;
    juce::File catalogFile;
    juce::File stateFile;
    juce::File deadMansPedalFile;
    juce::File helperExecutable;

    mutable std::mutex mutex;
    std::thread worker;
    std::unique_ptr<juce::ChildProcess> scannerProcess;
    bool scanRunning = false;
    std::string catalogJson = "{\"plugins\":[],\"blacklist\":[]}";

    void runScan(bool rescanAll);
    static juce::File findHelperExecutable();
};

} // namespace resostage
