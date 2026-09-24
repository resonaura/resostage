#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <iostream>

namespace {

juce::String jsonString(const juce::String& value) {
    return juce::JSON::toString(juce::var(value), true);
}

bool replaceAtomically(const juce::File& destination, const juce::String& text) {
    const auto parent = destination.getParentDirectory();
    if (parent.createDirectory().failed()) return false;
    juce::TemporaryFile temporary(destination);
    if (!temporary.getFile().replaceWithText(text, false, false, "\n")) return false;
    return temporary.overwriteTargetFileWithTemporary();
}

void writeScanState(const juce::File& file, const char* state, double progress,
                    const juce::String& format, const juce::String& current,
                    const juce::String& error = {}) {
    juce::String json;
    json << "{\"state\":" << jsonString(state)
         << ",\"progress\":" << juce::String(std::clamp(progress, 0.0, 1.0), 5)
         << ",\"format\":" << jsonString(format)
         << ",\"currentPlugin\":" << jsonString(current)
         << ",\"error\":" << jsonString(error) << "}";
    (void)replaceAtomically(file, json);
}

bool writeCatalog(const juce::File& file, const juce::KnownPluginList& list) {
    auto types = list.getTypes();
    std::sort(types.begin(), types.end(), [](const auto& a, const auto& b) {
        const int manufacturer = a.manufacturerName.compareIgnoreCase(b.manufacturerName);
        return manufacturer != 0 ? manufacturer < 0 : a.name.compareIgnoreCase(b.name) < 0;
    });

    juce::String json("{\"plugins\":[");
    bool first = true;
    for (const auto& plugin : types) {
        if (!first) json << ',';
        first = false;
        json << "{\"id\":" << jsonString(plugin.createIdentifierString())
             << ",\"name\":" << jsonString(plugin.name)
             << ",\"manufacturer\":" << jsonString(plugin.manufacturerName)
             << ",\"format\":" << jsonString(plugin.pluginFormatName)
             << ",\"category\":" << jsonString(plugin.category)
             << ",\"version\":" << jsonString(plugin.version)
             << ",\"fileOrIdentifier\":" << jsonString(plugin.fileOrIdentifier)
             << ",\"instrument\":" << (plugin.isInstrument ? "true" : "false")
             << ",\"inputs\":" << plugin.numInputChannels
             << ",\"outputs\":" << plugin.numOutputChannels << '}';
    }
    json << "],\"blacklist\":[";
    first = true;
    for (const auto& blocked : list.getBlacklistedFiles()) {
        if (!first) json << ',';
        first = false;
        json << jsonString(blocked);
    }
    json << "]}";
    return replaceAtomically(file, json);
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
    writeScanState(state, "scanning", 0.0, {}, {});

    for (int i = 0; i < formatCount; ++i) {
        auto* format = formats.getFormat(i);
        if (format == nullptr) continue;
        juce::PluginDirectoryScanner scanner(known, *format,
                                             format->getDefaultLocationsToSearch(), true,
                                             pedal, false);
        juce::String current;
        while (scanner.scanNextFile(!rescanAll, current)) {
            const double progress = (static_cast<double>(i) + scanner.getProgress())
                                    / std::max(1, formatCount);
            writeScanState(state, "scanning", progress, format->getName(), current);
            // A third-party binary may terminate this process at any item.
            // Checkpoint each completed item so Core can launch a fresh helper,
            // quarantine the pedal entry, and continue instead of repeating
            // every successful plug-in from the beginning.
            if (!writeRegistry(registry, known) || !writeCatalog(catalog, known)) {
                writeScanState(state, "failed", progress, format->getName(), current,
                               "Could not checkpoint plug-in catalog");
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
    writeScanState(state, "complete", 1.0, {}, {});
    return 0;
}
