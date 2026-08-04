#include "AppSettings.h"

#include "project/ProjectJson.h" // jsonEscapeString
#include "web/BuilderJson.h"

#include <sstream>

namespace resostage {

using namespace builder_json;

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

    glz::json_t doc;
    if (!parseJson(text, doc))
        return settings; // corrupt file -- start from defaults rather than fail startup

    getString(doc, "outputDeviceName", settings.outputDeviceName);
    getDouble(doc, "sampleRate", settings.sampleRate);
    getInt(doc, "bufferSize", settings.bufferSize);
    getString(doc, "midiOutputName", settings.midiOutputName);
    getString(doc, "midiInputName", settings.midiInputName);
    getBool(doc, "virtualMidiPortEnabled", settings.virtualMidiPortEnabled);

    std::string uiEngine;
    if (getString(doc, "uiRenderEngine", uiEngine)) {
        // Only the two current engines are valid; a stale persisted value
        // (e.g. the retired "wkwebview" or "cef") must not reach the UI.
        if (uiEngine == "browser" || uiEngine == "electron")
            settings.uiRenderEngine = uiEngine;
    }

    if (const auto* channelsArr = getArray(doc, "activeOutputChannels")) {
        for (const auto& el : *channelsArr) {
            int idx = 0;
            if (asInt(el, idx))
                settings.activeOutputChannels.push_back(idx);
        }
    }

    if (const auto* kbObj = getObject(doc, "keybindings")) {
        for (const auto& [key, value] : *kbObj) {
            std::string str;
            if (asString(value, str))
                settings.keybindings[key] = std::move(str);
        }
    }

    if (const auto* mmArr = getArray(doc, "midiMappings")) {
        for (const auto& mmEl : *mmArr) {
            std::string action;
            if (!getString(mmEl, "action", action))
                continue; // skip malformed entry rather than fail the whole load
            MidiMapping mapping;
            mapping.action = std::move(action);

            getInt(mmEl, "channel", mapping.channel);

            std::string triggerType;
            if (getString(mmEl, "triggerType", triggerType))
                mapping.triggerType = (triggerType == "controlChange")
                                          ? MidiTriggerType::ControlChange
                                          : MidiTriggerType::NoteOn;

            getInt(mmEl, "number", mapping.number);

            settings.midiMappings.push_back(std::move(mapping));
        }
    }

    if (const auto* rpArr = getArray(doc, "recentProjects")) {
        for (const auto& rpEl : *rpArr) {
            std::string pathStr;
            if (!getString(rpEl, "path", pathStr))
                continue; // skip malformed entry rather than fail the whole load
            // .rsnraset projects are package directories (LSTypeIsPackage in
            // Info.plist.in), not flat files -- existsAsFile() is always
            // false for a directory, which was silently dropping every
            // recent project on load. exists() covers both.
            if (!juce::File(pathStr).exists())
                continue; // skip projects that no longer exist on disk
            RecentProjectEntry rp;
            rp.path = std::move(pathStr);
            getString(rpEl, "displayName", rp.displayName);
            getString(rpEl, "lastOpenedIso", rp.lastOpenedIso);
            settings.recentProjects.push_back(std::move(rp));
        }
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

    std::ostringstream o;
    o << "{\n";
    o << "  \"outputDeviceName\": \"" << jsonEscapeString(settings.outputDeviceName) << "\",\n";
    o << "  \"sampleRate\": " << settings.sampleRate << ",\n";
    o << "  \"bufferSize\": " << settings.bufferSize << ",\n";
    o << "  \"midiOutputName\": \"" << jsonEscapeString(settings.midiOutputName) << "\",\n";
    o << "  \"midiInputName\": \"" << jsonEscapeString(settings.midiInputName) << "\",\n";
    o << "  \"virtualMidiPortEnabled\": " << (settings.virtualMidiPortEnabled ? "true" : "false") << ",\n";
    o << "  \"uiRenderEngine\": \"" << jsonEscapeString(settings.uiRenderEngine) << "\",\n";

    o << "  \"activeOutputChannels\": [";
    for (size_t i = 0; i < settings.activeOutputChannels.size(); ++i)
        o << (i ? "," : "") << settings.activeOutputChannels[i];
    o << "],\n";

    o << "  \"keybindings\": {\n";
    size_t kbCount = 0;
    for (const auto& [k, v] : settings.keybindings) {
        if (kbCount++)
            o << ",\n";
        o << "    \"" << jsonEscapeString(k) << "\": \"" << jsonEscapeString(v) << "\"";
    }
    if (kbCount)
        o << "\n";
    o << "  },\n";

    o << "  \"midiMappings\": [\n";
    for (size_t i = 0; i < settings.midiMappings.size(); ++i) {
        const MidiMapping& m = settings.midiMappings[i];
        o << "    {\n";
        o << "      \"action\": \"" << jsonEscapeString(m.action) << "\",\n";
        o << "      \"channel\": " << m.channel << ",\n";
        o << "      \"triggerType\": \""
          << (m.triggerType == MidiTriggerType::ControlChange ? "controlChange" : "noteOn")
          << "\",\n";
        o << "      \"number\": " << m.number << "\n";
        o << "    }" << (i + 1 < settings.midiMappings.size() ? "," : "") << "\n";
    }
    o << "  ],\n";

    o << "  \"recentProjects\": [\n";
    for (size_t i = 0; i < settings.recentProjects.size(); ++i) {
        const RecentProjectEntry& rp = settings.recentProjects[i];
        o << "    {\n";
        o << "      \"path\": \"" << jsonEscapeString(rp.path) << "\",\n";
        o << "      \"displayName\": \"" << jsonEscapeString(rp.displayName) << "\",\n";
        o << "      \"lastOpenedIso\": \"" << jsonEscapeString(rp.lastOpenedIso) << "\"\n";
        o << "    }" << (i + 1 < settings.recentProjects.size() ? "," : "") << "\n";
    }
    o << "  ]\n";
    o << "}\n";

    if (!file.replaceWithText(o.str())) {
        error = "Failed to write " + file.getFullPathName().toStdString();
        return false;
    }
    return true;
}

} // namespace resostage
