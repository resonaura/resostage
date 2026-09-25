#include "PluginCatalogService.h"
#include "PluginPaths.h"
#include "server/WireTypes.h"
#include "server/BuilderJson.h"
#include "glaze/glaze.hpp"

#include <algorithm>
#include <unordered_set>

namespace resostage {
namespace {

constexpr int kMaxCatalogBytes = 8 * 1024 * 1024;
constexpr int kScannerPollMilliseconds = 250;
constexpr int64_t kScannerInactivityTimeoutMilliseconds = 60'000;
constexpr int kMaxAutomaticScannerRecoveries = 32;

std::string loadBoundedJson(const juce::File& file, const char* fallback) {
    if (!file.existsAsFile() || file.getSize() <= 0 || file.getSize() > kMaxCatalogBytes)
        return fallback;
    const auto text = file.loadFileAsString().toStdString();
    if (text.empty())
        return fallback;
    glz::generic doc;
    if (glz::read_json(doc, text))
        return fallback;
    return text;
}

juce::String scanStateName(const std::string& json) {
    glz::generic doc;
    if (!glz::read_json(doc, json)) {
        std::string s;
        if (builder_json::getString(doc, "state", s))
            return juce::String::fromUTF8(s.c_str());
    }
    return {};
}

std::unordered_set<std::string> pluginIdsFromCatalog(const std::string& json) {
    std::unordered_set<std::string> ids;
    wire::WPluginCatalogData cat;
    if (!glz::read_json(cat, json)) {
        ids.reserve(cat.plugins.size());
        for (const auto& p : cat.plugins) {
            if (!p.id.empty()) ids.insert(p.id);
        }
    }
    return ids;
}

} // namespace

PluginCatalogService::PluginCatalogService()
    : dataDirectory(pluginDataDirectory()),
      registryFile(pluginRegistryFile()),
      catalogFile(dataDirectory.getChildFile("catalog.json")),
      stateFile(dataDirectory.getChildFile("scan-state.json")),
      preferencesFile(dataDirectory.getChildFile("catalog-preferences.json")),
      deadMansPedalFile(dataDirectory.getChildFile("scanner.pedal")),
      helperExecutable(findHelperExecutable()) {
    (void)dataDirectory.createDirectory();
    catalogJson = loadBoundedJson(catalogFile, "{\"plugins\":[],\"blacklist\":[]}");
    loadPreferencesLocked();
    const auto previousState = loadBoundedJson(stateFile, "{}");
    // Discovery is always an explicit operator action. A stale in-progress
    // marker from a crash/shutdown is informational only; the dead-man pedal
    // remains available to the next manually requested scan.
    if (scanStateName(previousState) == "scanning")
        (void)stateFile.replaceWithText(
            "{\"state\":\"cancelled\",\"progress\":0,\"format\":\"\","
            "\"formatIndex\":0,\"formatCount\":0,\"formatProgress\":0,"
            "\"currentPlugin\":\"\",\"error\":\"Previous scan was interrupted; start a scan to continue\"}");
}

PluginCatalogService::~PluginCatalogService() {
    bool killedHelperOnShutdown = false;
    {
        std::lock_guard lock(mutex);
        shutdownRequested = true;
        if (scannerProcess != nullptr && scanRunning && scannerProcess->isRunning()) {
            killedHelperOnShutdown = true;
            scannerProcess->kill();
        }
    }
    if (worker.joinable()) worker.join();
    // Stopping Core is not evidence that the active vendor binary is bad.
    // The checkpoint does not contain the unfinished item, so clear its pedal
    // and let the next helper retry it instead of falsely quarantining it.
    if (killedHelperOnShutdown)
        (void)deadMansPedalFile.deleteFile();
}

juce::File PluginCatalogService::findHelperExecutable() {
    const auto app = juce::File::getSpecialLocation(juce::File::currentApplicationFile);
#if JUCE_WINDOWS
    return app.getSiblingFile("resostage-plugin-scanner.exe");
#elif JUCE_MAC
    // JUCE returns the outer .app bundle here, while Windows/Linux return the
    // executable itself. The helper is embedded beside the bundle executable.
    if (app.isDirectory())
        return app.getChildFile("Contents").getChildFile("MacOS")
                  .getChildFile("resostage-plugin-scanner");
    return app.getSiblingFile("resostage-plugin-scanner");
#else
    return app.getSiblingFile("resostage-plugin-scanner");
#endif
}

bool PluginCatalogService::startScan(bool rescanAll) {
    std::lock_guard lock(mutex);
    if (scanRunning || shutdownRequested) return false;
    if (worker.joinable()) worker.join();
    cancelRequested = false;
    scanBaselinePluginIds = pluginIdsFromCatalog(catalogJson);
    newPluginIds.clear();
    savePreferencesLocked();
    scanRunning = true;
    scannerProcess = std::make_unique<juce::ChildProcess>();
    worker = std::thread([this, rescanAll] { runScan(rescanAll); });
    return true;
}

bool PluginCatalogService::cancelScan() {
    std::lock_guard lock(mutex);
    if (!scanRunning || shutdownRequested) return false;
    cancelRequested = true;
    if (scannerProcess != nullptr && scannerProcess->isRunning())
        scannerProcess->kill();
    return true;
}

bool PluginCatalogService::setPluginEnabled(const std::string& identifier,
                                            bool enabled) {
    std::lock_guard lock(mutex);
    if (!pluginIdsFromCatalog(catalogJson).contains(identifier)) return false;
    if (enabled)
        disabledPluginIds.erase(identifier);
    else
        disabledPluginIds.insert(identifier);
    savePreferencesLocked();
    return true;
}

void PluginCatalogService::runScan(bool rescanAll) {
    int recoveries = 0;
    for (;;) {
        juce::StringArray args;
        args.add(helperExecutable.getFullPathName());
        args.add("--registry"); args.add(registryFile.getFullPathName());
        args.add("--catalog"); args.add(catalogFile.getFullPathName());
        args.add("--state"); args.add(stateFile.getFullPathName());
        args.add("--dead-mans-pedal"); args.add(deadMansPedalFile.getFullPathName());
        // After a crash the helper's per-item checkpoint is authoritative.
        // Skip already committed items even when the original request was a
        // full rescan, otherwise every recovery repeats the whole prefix.
        if (rescanAll && recoveries == 0) args.add("--rescan-all");

        juce::ChildProcess* process = nullptr;
        {
            std::lock_guard lock(mutex);
            if (shutdownRequested || cancelRequested) break;
            process = scannerProcess.get();
        }
        if (process == nullptr || !helperExecutable.existsAsFile()
            || !process->start(args)) {
            (void)stateFile.replaceWithText(
                "{\"state\":\"failed\",\"progress\":0,\"format\":\"\","
                "\"formatIndex\":0,\"formatCount\":0,\"formatProgress\":0,"
                "\"currentPlugin\":\"\",\"error\":\"Plug-in scanner helper is unavailable\"}");
            break;
        }

        auto lastProgressAt = juce::Time::currentTimeMillis();
        auto lastStateModification = stateFile.getLastModificationTime();
        bool timedOut = false;
        while (!process->waitForProcessToFinish(kScannerPollMilliseconds)) {
            const auto modification = stateFile.getLastModificationTime();
            if (modification != lastStateModification) {
                lastStateModification = modification;
                lastProgressAt = juce::Time::currentTimeMillis();
                // The helper publishes registry/catalog first and scan state
                // last. Refreshing on that state edge exposes only complete
                // atomic checkpoints, so Settings and insert menus can use
                // already validated plug-ins during a long scan.
                auto checkpoint = loadBoundedJson(catalogFile, "");
                if (!checkpoint.empty()) {
                    std::lock_guard lock(mutex);
                    refreshCatalogLocked(std::move(checkpoint));
                }
            }
            if (juce::Time::currentTimeMillis() - lastProgressAt
                > kScannerInactivityTimeoutMilliseconds) {
                timedOut = true;
                process->kill();
                (void)process->waitForProcessToFinish(2'000);
                break;
            }
        }

        {
            std::lock_guard lock(mutex);
            // Preserve the scanning state so the next Core launch resumes.
            // The destructor clears the pedal after this worker has stopped;
            // an intentional app shutdown must not blacklist a healthy item.
            if (shutdownRequested) break;
            if (cancelRequested) {
                (void)deadMansPedalFile.deleteFile();
                (void)stateFile.replaceWithText(
                    "{\"state\":\"cancelled\",\"progress\":0,\"format\":\"\","
                    "\"formatIndex\":0,\"formatCount\":0,\"formatProgress\":0,"
                    "\"currentPlugin\":\"\",\"error\":\"\"}");
                break;
            }
        }

        const auto persistedState = loadBoundedJson(stateFile, "{}");
        const auto stateName = scanStateName(persistedState);
        if (!timedOut && process->getExitCode() == 0 && stateName == "complete")
            break;
        // Explicit helper failures (for example an unwritable registry) are
        // not plug-in crashes and retrying cannot repair them.
        if (stateName == "failed")
            break;

        if (++recoveries > kMaxAutomaticScannerRecoveries) {
            (void)stateFile.replaceWithText(
                "{\"state\":\"failed\",\"progress\":0,\"format\":\"\","
                "\"formatIndex\":0,\"formatCount\":0,\"formatProgress\":0,"
                "\"currentPlugin\":\"\",\"error\":\"Plug-in scan stopped after 32 automatic crash recoveries; quarantined items remain in the catalog\"}");
            break;
        }

        // PluginDirectoryScanner leaves the active candidate in its pedal.
        // A fresh helper applies that pedal to the blacklist before scanning,
        // then continues from the last atomically checkpointed registry.
        {
            std::lock_guard lock(mutex);
            if (shutdownRequested) break;
            scannerProcess = std::make_unique<juce::ChildProcess>();
        }
    }

    std::lock_guard lock(mutex);
    scanRunning = false;
    refreshCatalogLocked(loadBoundedJson(
        catalogFile, "{\"plugins\":[],\"blacklist\":[]}"));
    scanBaselinePluginIds.clear();
}

std::string PluginCatalogService::snapshotJson() const {
    bool running = false;
    std::string catalog;
    std::unordered_set<std::string> disabled;
    std::unordered_set<std::string> fresh;
    {
        std::lock_guard lock(mutex);
        running = scanRunning;
        catalog = catalogJson;
        disabled = disabledPluginIds;
        fresh = newPluginIds;
    }

    wire::WPluginScanState scanState;
    const std::string rawScan = loadBoundedJson(stateFile, "{}");
    (void)glz::read_json(scanState, rawScan);
    if (running && scanState.state != "scanning") {
        scanState.state = "scanning";
        scanState.progress = 0.0;
        scanState.error.clear();
    } else if (!running && scanState.state == "scanning") {
        scanState.state = "cancelled";
        scanState.progress = 0.0;
        scanState.error = "Previous scan was interrupted; start a scan to continue";
    }

    wire::WPluginCatalogData catData;
    (void)glz::read_json(catData, catalog);
    for (auto& plugin : catData.plugins) {
        plugin.enabled = !disabled.contains(plugin.id);
        plugin.isNew = fresh.contains(plugin.id);
    }

    wire::WPluginCatalogResponse response{std::move(scanState), std::move(catData)};
    std::string outJson;
    (void)glz::write_json(response, outJson);
    return outJson;
}

std::optional<PluginReference> PluginCatalogService::findPlugin(
    const std::string& identifier) const {
    std::string catalog;
    {
        std::lock_guard lock(mutex);
        if (disabledPluginIds.contains(identifier)) return std::nullopt;
        catalog = catalogJson;
    }
    wire::WPluginCatalogData catData;
    if (glz::read_json(catData, catalog))
        return std::nullopt;
    for (const auto& plugin : catData.plugins) {
        if (plugin.id == identifier) {
            PluginReference result;
            result.identifier = identifier;
            result.format = plugin.format;
            result.name = plugin.name;
            result.manufacturer = plugin.manufacturer;
            result.fileOrIdentifier = plugin.fileOrIdentifier;
            result.instrument = plugin.instrument;
            return result;
        }
    }
    return std::nullopt;
}

void PluginCatalogService::refreshCatalogLocked(std::string json) {
    catalogJson = std::move(json);
    if (scanRunning) {
        for (const auto& id : pluginIdsFromCatalog(catalogJson))
            if (!scanBaselinePluginIds.contains(id)) newPluginIds.insert(id);
        savePreferencesLocked();
    }
}

void PluginCatalogService::loadPreferencesLocked() {
    const auto json = loadBoundedJson(preferencesFile, "{}");
    wire::WPluginPreferences prefs;
    if (glz::read_json(prefs, json)) return;
    for (const auto& id : prefs.disabled) {
        if (!id.empty()) disabledPluginIds.insert(id);
    }
    for (const auto& id : prefs.newPlugins) {
        if (!id.empty()) newPluginIds.insert(id);
    }
}

void PluginCatalogService::savePreferencesLocked() const {
    wire::WPluginPreferences prefs;
    prefs.disabled.assign(disabledPluginIds.begin(), disabledPluginIds.end());
    std::sort(prefs.disabled.begin(), prefs.disabled.end());
    prefs.newPlugins.assign(newPluginIds.begin(), newPluginIds.end());
    std::sort(prefs.newPlugins.begin(), prefs.newPlugins.end());

    std::string text;
    (void)glz::write_json(prefs, text);

    juce::TemporaryFile temporary(preferencesFile);
    if (temporary.getFile().replaceWithText(juce::String::fromUTF8(text.c_str()),
                                            false, false, "\n"))
        (void)temporary.overwriteTargetFileWithTemporary();
}

} // namespace resostage
