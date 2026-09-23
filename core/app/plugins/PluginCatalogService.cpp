#include "PluginCatalogService.h"

namespace resostage {
namespace {

constexpr int kMaxCatalogBytes = 8 * 1024 * 1024;

juce::File pluginDataDirectory() {
    auto root = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
#if JUCE_MAC
    root = root.getChildFile("Application Support");
#endif
    return root.getChildFile("ResoStage").getChildFile("Plugins");
}

std::string loadBoundedJson(const juce::File& file, const char* fallback) {
    if (!file.existsAsFile() || file.getSize() <= 0 || file.getSize() > kMaxCatalogBytes)
        return fallback;
    const auto text = file.loadFileAsString().toStdString();
    if (text.empty() || juce::JSON::parse(juce::String::fromUTF8(text.c_str())).isVoid())
        return fallback;
    return text;
}

} // namespace

PluginCatalogService::PluginCatalogService()
    : dataDirectory(pluginDataDirectory()),
      registryFile(dataDirectory.getChildFile("known-plugins.xml")),
      catalogFile(dataDirectory.getChildFile("catalog.json")),
      stateFile(dataDirectory.getChildFile("scan-state.json")),
      deadMansPedalFile(dataDirectory.getChildFile("scanner.pedal")),
      helperExecutable(findHelperExecutable()) {
    (void)dataDirectory.createDirectory();
    catalogJson = loadBoundedJson(catalogFile, "{\"plugins\":[],\"blacklist\":[]}");
}

PluginCatalogService::~PluginCatalogService() {
    {
        std::lock_guard lock(mutex);
        if (scannerProcess != nullptr && scanRunning) scannerProcess->kill();
    }
    if (worker.joinable()) worker.join();
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
    if (scanRunning) return false;
    if (worker.joinable()) worker.join();
    scanRunning = true;
    scannerProcess = std::make_unique<juce::ChildProcess>();
    worker = std::thread([this, rescanAll] { runScan(rescanAll); });
    return true;
}

void PluginCatalogService::runScan(bool rescanAll) {
    juce::StringArray args;
    args.add(helperExecutable.getFullPathName());
    args.add("--registry"); args.add(registryFile.getFullPathName());
    args.add("--catalog"); args.add(catalogFile.getFullPathName());
    args.add("--state"); args.add(stateFile.getFullPathName());
    args.add("--dead-mans-pedal"); args.add(deadMansPedalFile.getFullPathName());
    if (rescanAll) args.add("--rescan-all");

    juce::ChildProcess* process = nullptr;
    {
        std::lock_guard lock(mutex);
        process = scannerProcess.get();
    }
    if (process == nullptr || !helperExecutable.existsAsFile() || !process->start(args)) {
        (void)stateFile.replaceWithText(
            "{\"state\":\"failed\",\"progress\":0,\"format\":\"\","
            "\"currentPlugin\":\"\",\"error\":\"Plug-in scanner helper is unavailable\"}");
    } else {
        const bool finished = process->waitForProcessToFinish(-1);
        if (!finished || process->getExitCode() != 0) {
            (void)stateFile.replaceWithText(
                "{\"state\":\"failed\",\"progress\":0,\"format\":\"\","
                "\"currentPlugin\":\"\",\"error\":\"Plug-in scanner exited unexpectedly; the current item will be quarantined on the next scan\"}");
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

} // namespace resostage
