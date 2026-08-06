#include "AppSettings.h"

#include "server/WireTypes.h"

namespace resostage {

using namespace wire;

juce::File appSettingsFile() {
    const juce::File userData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
#if JUCE_MAC
    // JUCE's userApplicationDataDirectory maps to ~/Library on macOS, not
    // ~/Library/Application Support -- append that segment explicitly, same
    // as AudioEngine's draft-archive location.
    const juce::File appSupport = userData.getChildFile("Application Support");
#else
    const juce::File appSupport = userData;
#endif
    return appSupport.getChildFile("ResoStage").getChildFile("settings.json");
}

AppSettings loadAppSettings() {
    AppSettings settings;

    const juce::File file = appSettingsFile();
    if (!file.existsAsFile())
        return settings; // first launch -- caller falls back to defaults

    const std::string text = file.loadFileAsString().toStdString();
    if (text.empty())
        return settings;

    WAppSettings wire{};
    const auto ec = glz::read_json(wire, text);
    if (ec)
        return settings; // corrupt file -- start from defaults rather than fail startup

    settings.outputDeviceName = std::move(wire.outputDeviceName);
    settings.sampleRate = wire.sampleRate;
    settings.bufferSize = wire.bufferSize;
    settings.midiOutputName = std::move(wire.midiOutputName);
    settings.midiInputName = std::move(wire.midiInputName);
    settings.virtualMidiPortEnabled = wire.virtualMidiPortEnabled;

    if (wire.uiRenderEngine == "browser" || wire.uiRenderEngine == "electron") {
        settings.uiRenderEngine = std::move(wire.uiRenderEngine);
    }

    settings.activeOutputChannels = std::move(wire.activeOutputChannels);
    settings.keybindings = std::move(wire.keybindings);

    for (auto& mm : wire.midiMappings) {
        if (mm.action.empty())
            continue;
        MidiMapping mapping;
        mapping.action = std::move(mm.action);
        mapping.channel = mm.channel;
        mapping.triggerType = (mm.triggerType == "controlChange")
                                  ? MidiTriggerType::ControlChange
                                  : MidiTriggerType::NoteOn;
        mapping.number = mm.number;
        settings.midiMappings.push_back(std::move(mapping));
    }

    for (auto& rp : wire.recentProjects) {
        if (rp.path.empty())
            continue;
        // .rsnraset projects are package directories (LSTypeIsPackage in
        // Info.plist.in), not flat files -- existsAsFile() is always
        // false for a directory, which was silently dropping every
        // recent project on load. exists() covers both.
        if (!juce::File(rp.path).exists())
            continue; // skip projects that no longer exist on disk
        RecentProjectEntry entry;
        entry.path = std::move(rp.path);
        entry.displayName = std::move(rp.displayName);
        entry.lastOpenedIso = std::move(rp.lastOpenedIso);
        settings.recentProjects.push_back(std::move(entry));
    }

    return settings;
}

bool saveAppSettings(const AppSettings& settings, std::string& error) {
    const juce::File file = appSettingsFile();
    const auto dirResult = file.getParentDirectory().createDirectory();
    if (dirResult.failed()) {
        error = dirResult.getErrorMessage().toStdString();
        return false;
    }

    WAppSettings wire;
    wire.outputDeviceName = settings.outputDeviceName;
    wire.sampleRate = settings.sampleRate;
    wire.bufferSize = settings.bufferSize;
    wire.midiOutputName = settings.midiOutputName;
    wire.midiInputName = settings.midiInputName;
    wire.virtualMidiPortEnabled = settings.virtualMidiPortEnabled;
    wire.uiRenderEngine = settings.uiRenderEngine;
    wire.activeOutputChannels = settings.activeOutputChannels;
    wire.keybindings = settings.keybindings;

    for (const auto& m : settings.midiMappings) {
        WMidiMapping mm;
        mm.action = m.action;
        mm.channel = m.channel;
        mm.triggerType = (m.triggerType == MidiTriggerType::ControlChange) ? "controlChange" : "noteOn";
        mm.number = m.number;
        wire.midiMappings.push_back(std::move(mm));
    }

    for (const auto& rp : settings.recentProjects) {
        WRecentProject entry;
        entry.path = rp.path;
        entry.displayName = rp.displayName;
        entry.lastOpenedIso = rp.lastOpenedIso;
        wire.recentProjects.push_back(std::move(entry));
    }

    std::string json;
    const auto ec = glz::write<AppSettingsPrettyOpts{}>(wire, json);
    if (ec) {
        error = "Failed to serialize app settings";
        return false;
    }
    json.push_back('\n');

    if (!file.replaceWithText(json)) {
        error = "Failed to write " + file.getFullPathName().toStdString();
        return false;
    }
    return true;
}

} // namespace resostage
