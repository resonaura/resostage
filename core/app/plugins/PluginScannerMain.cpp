#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include "glaze/glaze.hpp"

#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

namespace resostage {

struct ScannerStatePayload {
    std::string state;
    double progress = 0.0;
    std::string format;
    int formatIndex = 0;
    int formatCount = 0;
    double formatProgress = 0.0;
    std::string currentPlugin;
    std::string error;
};

struct ScannerPluginEntry {
    std::string id;
    std::string name;
    std::string manufacturer;
    std::string format;
    std::string category;
    std::string version;
    std::string fileOrIdentifier;
    bool instrument = false;
    int inputs = 2;
    int outputs = 2;
};

struct ScannerCatalogPayload {
    std::vector<ScannerPluginEntry> plugins;
    std::vector<std::string> blacklist;
};

} // namespace resostage

namespace {

using namespace resostage;

bool replaceAtomically(const juce::File& destination, const juce::String& text) {
    const auto parent = destination.getParentDirectory();
    if (parent.createDirectory().failed()) return false;
    juce::TemporaryFile temporary(destination);
    if (!temporary.getFile().replaceWithText(text, false, false, "\n")) return false;
    return temporary.overwriteTargetFileWithTemporary();
}

void writeScanState(const juce::File& file, const char* state, double progress,
                    const juce::String& format, const juce::String& current,
                    const juce::String& error = {}, int formatIndex = 0,
                    int formatCount = 0, double formatProgress = 0.0) {
    ScannerStatePayload payload;
    payload.state = state != nullptr ? state : "idle";
    payload.progress = std::clamp(progress, 0.0, 1.0);
    payload.format = format.toStdString();
    payload.formatIndex = std::max(0, formatIndex);
    payload.formatCount = std::max(0, formatCount);
    payload.formatProgress = std::clamp(formatProgress, 0.0, 1.0);
    payload.currentPlugin = current.toStdString();
    payload.error = error.toStdString();

    std::string json;
    (void)glz::write_json(payload, json);
    (void)replaceAtomically(file, juce::String::fromUTF8(json.c_str()));
}

bool writeCatalog(const juce::File& file, const juce::KnownPluginList& list) {
    auto types = list.getTypes();
    std::sort(types.begin(), types.end(), [](const auto& a, const auto& b) {
        const int manufacturer = a.manufacturerName.compareIgnoreCase(b.manufacturerName);
        return manufacturer != 0 ? manufacturer < 0 : a.name.compareIgnoreCase(b.name) < 0;
    });

    ScannerCatalogPayload catalog;
    catalog.plugins.reserve(static_cast<size_t>(types.size()));
    for (const auto& plugin : types) {
        ScannerPluginEntry entry;
        entry.id = plugin.createIdentifierString().toStdString();
        entry.name = plugin.name.toStdString();
        entry.manufacturer = plugin.manufacturerName.toStdString();
        entry.format = plugin.pluginFormatName.toStdString();
        entry.category = plugin.category.toStdString();
        entry.version = plugin.version.toStdString();
        entry.fileOrIdentifier = plugin.fileOrIdentifier.toStdString();
        entry.instrument = plugin.isInstrument;
        entry.inputs = plugin.numInputChannels;
        entry.outputs = plugin.numOutputChannels;
        catalog.plugins.push_back(std::move(entry));
    }

    const auto blocked = list.getBlacklistedFiles();
    catalog.blacklist.reserve(static_cast<size_t>(blocked.size()));
    for (const auto& b : blocked) {
        catalog.blacklist.push_back(b.toStdString());
    }

    std::string json;
    (void)glz::write_json(catalog, json);
    return replaceAtomically(file, juce::String::fromUTF8(json.c_str()));
}

bool writeRegistry(const juce::File& file, const juce::KnownPluginList& list) {
    if (file.getParentDirectory().createDirectory().failed()) return false;
    juce::TemporaryFile temporary(file);
    const auto xml = list.createXml();
    return xml != nullptr && xml->writeTo(temporary.getFile())
        && temporary.overwriteTargetFileWithTemporary();
}

juce::String argumentValue(const juce::StringArray& args, const juce::String& key) {
    const int index = args.indexOf(key);
    return index >= 0 && index + 1 < args.size() ? args[index + 1] : juce::String{};
}

} // namespace

int main(int argc, char** argv) {
    juce::ScopedJuceInitialiser_GUI juceInitialiser;
    juce::StringArray args(argv + 1, argc - 1);
    const juce::File registry(argumentValue(args, "--registry"));
    const juce::File catalog(argumentValue(args, "--catalog"));
    const juce::File state(argumentValue(args, "--state"));
    const juce::File pedal(argumentValue(args, "--dead-mans-pedal"));
    const bool rescanAll = args.contains("--rescan-all");

    if (registry.getFullPathName().isEmpty() || catalog.getFullPathName().isEmpty()
        || state.getFullPathName().isEmpty() || pedal.getFullPathName().isEmpty()) {
        std::cerr << "missing scanner path argument\n";
        return 2;
    }

    juce::KnownPluginList known;
    if (registry.existsAsFile()) {
        if (auto xml = juce::parseXML(registry)) known.recreateFromXml(*xml);
    }
    juce::PluginDirectoryScanner::applyBlacklistingsFromDeadMansPedal(known, pedal);

    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager(formats);
    const int formatCount = formats.getNumFormats();
    writeScanState(state, "scanning", 0.0, {}, {}, {}, 0, formatCount, 0.0);

    for (int i = 0; i < formatCount; ++i) {
        auto* format = formats.getFormat(i);
        if (format == nullptr) continue;
        writeScanState(state, "scanning",
                       static_cast<double>(i) / std::max(1, formatCount),
                       format->getName(), {}, {}, i + 1, formatCount, 0.0);
        juce::PluginDirectoryScanner scanner(known, *format,
                                             format->getDefaultLocationsToSearch(), true,
                                             pedal, false);
        juce::String current;
        while (scanner.scanNextFile(!rescanAll, current)) {
            const double progress = (static_cast<double>(i) + scanner.getProgress())
                                    / std::max(1, formatCount);
            writeScanState(state, "scanning", progress, format->getName(), current,
                           {}, i + 1, formatCount, scanner.getProgress());
            // A third-party binary may terminate this process at any item.
            // Checkpoint each completed item so Core can launch a fresh helper,
            // quarantine the pedal entry, and continue instead of repeating
            // every successful plug-in from the beginning.
            if (!writeRegistry(registry, known) || !writeCatalog(catalog, known)) {
                writeScanState(state, "failed", progress, format->getName(), current,
                               "Could not checkpoint plug-in catalog", i + 1,
                               formatCount, scanner.getProgress());
                return 3;
            }
        }
    }

    if (!writeRegistry(registry, known)) {
        writeScanState(state, "failed", 1.0, {}, {}, "Could not commit plug-in registry");
        return 4;
    }

    if (!writeCatalog(catalog, known)) {
        writeScanState(state, "failed", 1.0, {}, {}, "Could not commit plug-in catalog");
        return 5;
    }
    writeScanState(state, "complete", 1.0, {}, {}, {}, formatCount,
                   formatCount, 1.0);
    return 0;
}
