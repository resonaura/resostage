#include "PluginCatalogService.h"
#include "PluginPaths.h"

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
    if (text.empty() || juce::JSON::parse(juce::String::fromUTF8(text.c_str())).isVoid())
        return fallback;
    return text;
}

bool isInterruptedScan(const std::string& json) {
    const auto root = juce::JSON::parse(juce::String::fromUTF8(json.c_str()));
    const auto* object = root.getDynamicObject();
    if (object == nullptr) return false;
    const auto state = object->getProperty("state").toString();
    if (state == "scanning") return true;
    if (state != "failed") return false;
    const auto error = object->getProperty("error").toString();
    return error.containsIgnoreCase("interrupted")
        || error.containsIgnoreCase("scanner crashed");
}

juce::String scanStateName(const std::string& json) {
    const auto root = juce::JSON::parse(juce::String::fromUTF8(json.c_str()));
    const auto* object = root.getDynamicObject();
    return object != nullptr ? object->getProperty("state").toString()
                             : juce::String{};
}

} // namespace

PluginCatalogService::PluginCatalogService()
    : dataDirectory(pluginDataDirectory()),
      registryFile(pluginRegistryFile()),
      catalogFile(dataDirectory.getChildFile("catalog.json")),
      stateFile(dataDirectory.getChildFile("scan-state.json")),
      deadMansPedalFile(dataDirectory.getChildFile("scanner.pedal")),
      helperExecutable(findHelperExecutable()) {
    (void)dataDirectory.createDirectory();
    catalogJson = loadBoundedJson(catalogFile, "{\"plugins\":[],\"blacklist\":[]}");
    const auto previousState = loadBoundedJson(stateFile, "{}");
    // A normal Core shutdown terminates the crash-isolated helper. Resume once
    // on the next launch instead of leaving Settings permanently reporting a
    // stale "interrupted" failure.
    resumeScanOnStartup = isInterruptedScan(previousState);
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
    scanRunning = true;
    scannerProcess = std::make_unique<juce::ChildProcess>();
    worker = std::thread([this, rescanAll] { runScan(rescanAll); });
    return true;
}

void PluginCatalogService::resumeInterruptedScanIfNeeded() {
    if (!resumeScanOnStartup) return;
    resumeScanOnStartup = false;
    (void)startScan(false);
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
            if (shutdownRequested) break;
            process = scannerProcess.get();
        }
        if (process == nullptr || !helperExecutable.existsAsFile()
            || !process->start(args)) {
            (void)stateFile.replaceWithText(
                "{\"state\":\"failed\",\"progress\":0,\"format\":\"\","
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
                    catalogJson = std::move(checkpoint);
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
    catalogJson = loadBoundedJson(catalogFile, "{\"plugins\":[],\"blacklist\":[]}");
}

std::string PluginCatalogService::snapshotJson() const {
    bool running = false;
    std::string catalog;
    {
        std::lock_guard lock(mutex);
        running = scanRunning;
        catalog = catalogJson;
    }
    auto scan = loadBoundedJson(stateFile,
        "{\"state\":\"idle\",\"progress\":0,\"format\":\"\",\"currentPlugin\":\"\",\"error\":\"\"}");
    if (running && scan.find("\"state\":\"scanning\"") == std::string::npos)
        scan = "{\"state\":\"scanning\",\"progress\":0,\"format\":\"\",\"currentPlugin\":\"\",\"error\":\"\"}";
    if (!running && scan.find("\"state\":\"scanning\"") != std::string::npos)
        scan = "{\"state\":\"failed\",\"progress\":0,\"format\":\"\",\"currentPlugin\":\"\",\"error\":\"The previous scan was interrupted; rescan to quarantine the last plug-in and continue\"}";
    return "{\"scan\":" + scan + ",\"catalog\":" + catalog + "}";
}

std::optional<PluginReference> PluginCatalogService::findPlugin(
    const std::string& identifier) const {
    std::string catalog;
    {
        std::lock_guard lock(mutex);
        catalog = catalogJson;
    }
    const juce::var root = juce::JSON::parse(
        juce::String::fromUTF8(catalog.c_str()));
    const auto* object = root.getDynamicObject();
    if (object == nullptr)
        return std::nullopt;
    const juce::var rows = object->getProperty("plugins");
    const auto* plugins = rows.getArray();
    if (plugins == nullptr)
        return std::nullopt;
    for (const auto& row : *plugins) {
        const auto* plugin = row.getDynamicObject();
        if (plugin == nullptr
            || plugin->getProperty("id").toString().toStdString()
                   != identifier) {
            continue;
        }
        PluginReference result;
        result.identifier = identifier;
        result.format = plugin->getProperty("format").toString().toStdString();
        result.name = plugin->getProperty("name").toString().toStdString();
        result.manufacturer =
            plugin->getProperty("manufacturer").toString().toStdString();
        result.fileOrIdentifier =
            plugin->getProperty("fileOrIdentifier").toString().toStdString();
        result.instrument = static_cast<bool>(plugin->getProperty("instrument"));
        return result;
    }
    return std::nullopt;
}

} // namespace resostage
