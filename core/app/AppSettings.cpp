#include "AppSettings.h"

#include "project/ProjectJson.h" // jsonEscapeString

#include "simdjson.h"

#include <sstream>

namespace resostage {

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

    simdjson::dom::parser parser;
    simdjson::dom::element doc;
    if (parser.parse(text).get(doc))
        return settings; // corrupt file -- start from defaults rather than fail startup

    std::string_view sv;
    if (!doc["outputDeviceName"].get(sv))
        settings.outputDeviceName = std::string(sv);
    double d = 0.0;
    if (!doc["sampleRate"].get(d))
        settings.sampleRate = d;
    int64_t i64 = 0;
    if (!doc["bufferSize"].get(i64))
        settings.bufferSize = static_cast<int>(i64);
    if (!doc["midiOutputName"].get(sv))
        settings.midiOutputName = std::string(sv);
    if (!doc["midiInputName"].get(sv))
        settings.midiInputName = std::string(sv);
    bool b = false;
    if (!doc["virtualMidiPortEnabled"].get(b))
        settings.virtualMidiPortEnabled = b;
    if (!doc["uiRenderEngine"].get(sv)) {
        // Only the two current engines are valid; a stale persisted value
        // (e.g. the retired "wkwebview" or "cef") must not reach the UI.
        const std::string choice = std::string(sv);
        if (choice == "browser" || choice == "electron")
            settings.uiRenderEngine = choice;
    }

    simdjson::dom::array channelsArr;
    if (!doc["activeOutputChannels"].get(channelsArr)) {
        for (simdjson::dom::element el : channelsArr) {
            int64_t idx = 0;
            if (!el.get(idx))
                settings.activeOutputChannels.push_back(static_cast<int>(idx));
        }
    }

    simdjson::dom::object kbObj;
    if (!doc["keybindings"].get(kbObj)) {
        for (simdjson::dom::key_value_pair field : kbObj) {
            std::string_view value;
            if (!field.value.get(value))
                settings.keybindings[std::string(field.key)] = std::string(value);
        }
    }

    simdjson::dom::array mmArr;
    if (!doc["midiMappings"].get(mmArr)) {
        for (simdjson::dom::element mmEl : mmArr) {
            std::string_view action;
            if (mmEl["action"].get(action))
                continue; // skip malformed entry rather than fail the whole load
            MidiMapping mapping;
            mapping.action = std::string(action);

            int64_t channel = 0;
            (void)mmEl["channel"].get(channel);
            mapping.channel = static_cast<int>(channel);

            std::string_view triggerType;
            if (!mmEl["triggerType"].get(triggerType))
                mapping.triggerType = (triggerType == "controlChange") ? MidiTriggerType::ControlChange : MidiTriggerType::NoteOn;

            int64_t number = 0;
            (void)mmEl["number"].get(number);
            mapping.number = static_cast<int>(number);

            settings.midiMappings.push_back(std::move(mapping));
        }
    }

    simdjson::dom::array rpArr;
    if (!doc["recentProjects"].get(rpArr)) {
        for (simdjson::dom::element rpEl : rpArr) {
            std::string_view path;
            if (rpEl["path"].get(path))
                continue; // skip malformed entry rather than fail the whole load
            RecentProjectEntry rp;
            rp.path = std::string(path);
            std::string_view name;
            if (!rpEl["displayName"].get(name))
                rp.displayName = std::string(name);
            std::string_view iso;
            if (!rpEl["lastOpenedIso"].get(iso))
                rp.lastOpenedIso = std::string(iso);
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
