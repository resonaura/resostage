// Settings parity for the web UI. Mirrors SettingsPanel.cpp's
// AudioDeviceSelectorComponent callbacks and MIDI/keybinding row handlers --
// same juce::AudioDeviceManager / CoreMidiDispatcher / CoreMidiInputListener
// / Project::keybindings calls, just JSON-driven instead of widget-driven.
// Kept in its own translation unit for the same reason as
// MainComponentBuilder.cpp: keeps MainComponent.cpp from ballooning while
// still being full MainComponent member functions.

#include "MainComponent.h"
#include "web/BuilderJson.h"

#include <algorithm>

namespace resoset {

using namespace builder_json;

namespace {

bool parseJson(const std::string& json, simdjson::dom::element& out) {
    static simdjson::dom::parser parser;
    return !parser.parse(json).get(out);
}

// Canonical action catalogue for the web Settings UI (and the seed list
// mirrored into Project::keybindings). Keep in sync with
// SettingsPanel::kActions / MainComponent::keyBindings defaults.
constexpr const char* kActions[] = {
    "play",
    "stop",
    "next",
    "prev",
    "mode_player",
    "mode_mixer",
    "mode_editor",
    "mode_settings",
    "section_prev",
    "section_next",
    "section_last",
};

bool isKnownAction(const std::string& action) {
    for (const char* a : kActions) {
        if (action == a)
            return true;
    }
    return false;
}

} // namespace

void MainComponent::populateSettingsState(WebUiState::SettingsRow& out) {
    auto& dm = engine.deviceManager();
    const auto setup = dm.getAudioDeviceSetup();
    out.currentOutputDevice = setup.outputDeviceName.toStdString();
    out.sampleRate = setup.sampleRate;
    out.bufferSize = setup.bufferSize;

    if (auto* type = dm.getCurrentDeviceTypeObject()) {
        const auto names = type->getDeviceNames(false);
        for (const auto& n : names)
            out.outputDevices.push_back(n.toStdString());
    }
    if (auto* device = dm.getCurrentAudioDevice()) {
        for (double r : device->getAvailableSampleRates())
            out.availableSampleRates.push_back(r);
        for (int b : device->getAvailableBufferSizes())
            out.availableBufferSizes.push_back(b);

        const auto channelNames = device->getOutputChannelNames();
        const auto active = device->getActiveOutputChannels();
        for (int i = 0; i < channelNames.size(); ++i) {
            out.outputChannelNames.push_back(channelNames[i].toStdString());
            out.activeOutputChannels.push_back(active[i]);
        }
    }

    for (const auto& n : engine.midi().availableDestinationNames())
        out.midiOutputs.push_back(n);
    for (const auto& n : midiInput.availableSourceNames())
        out.midiInputs.push_back(n);

    const auto& bindings = engine.project().keybindings;
    for (const char* action : kActions) {
        WebUiState::SettingsRow::Keybinding kb;
        kb.action = action;
        const auto it = bindings.find(action);
        kb.key = (it != bindings.end()) ? it->second : "";
        out.keybindings.push_back(std::move(kb));
    }

    // One MIDI row per known action (empty number/channel when unbound) so
    // the Settings UI can show Learn/Clear next to every shortcut.
    for (const char* action : kActions) {
        WebUiState::SettingsRow::MidiBinding mb;
        mb.action = action;
        for (const auto& m : engine.project().midiMappings) {
            if (m.action != action)
                continue;
            mb.trigger = (m.triggerType == MidiTriggerType::ControlChange) ? "cc" : "note";
            mb.channel = m.channel;
            mb.number = m.number;
            break;
        }
        out.midiBindings.push_back(std::move(mb));
    }
    out.midiLearnAction = midiLearnAction;
}

void MainComponent::settingsSetAudioOutputDevice(const std::string& json) {
    simdjson::dom::element doc;
    std::string name;
    if (!parseJson(json, doc) || !getString(doc, "name", name))
        return;

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.outputDeviceName = name;
    setup.useDefaultOutputChannels = true;
    const juce::String error = engine.deviceManager().setAudioDeviceSetup(setup, true);
    setStatus(error.isEmpty() ? ("Audio output: " + juce::String(name)) : ("Audio device error: " + error));
}

void MainComponent::settingsSetSampleRate(const std::string& json) {
    simdjson::dom::element doc;
    double value = 0.0;
    if (!parseJson(json, doc) || !getDouble(doc, "value", value) || value <= 0.0)
        return;

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.sampleRate = value;
    const juce::String error = engine.deviceManager().setAudioDeviceSetup(setup, true);
    setStatus(error.isEmpty() ? ("Sample rate: " + juce::String(value, 0) + " Hz")
                              : ("Sample rate error: " + error));
}

void MainComponent::settingsSetBufferSize(const std::string& json) {
    simdjson::dom::element doc;
    int value = 0;
    if (!parseJson(json, doc) || !getInt(doc, "value", value) || value <= 0)
        return;

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.bufferSize = value;
    const juce::String error = engine.deviceManager().setAudioDeviceSetup(setup, true);
    setStatus(error.isEmpty() ? ("Buffer size: " + juce::String(value) + " samples")
                              : ("Buffer size error: " + error));
}

void MainComponent::settingsSetMidiOutput(const std::string& json) {
    simdjson::dom::element doc;
    std::string name;
    if (!parseJson(json, doc) || !getString(doc, "name", name))
        return;

    std::string error;
    if (!engine.midi().openDestination(name, error))
        setStatus("MIDI output failed: " + juce::String(error));
    else
        setStatus("MIDI output: " + juce::String(name));
}

void MainComponent::settingsSetMidiInput(const std::string& json) {
    simdjson::dom::element doc;
    std::string name;
    if (!parseJson(json, doc) || !getString(doc, "name", name))
        return;

    std::string error;
    if (!midiInput.openSource(name, error))
        setStatus("MIDI input failed: " + juce::String(error));
    else
        setStatus("MIDI input: " + juce::String(name));
}

void MainComponent::settingsSetOutputChannels(const std::string& json) {
    simdjson::dom::element doc;
    simdjson::dom::array channels;
    if (!parseJson(json, doc) || doc["channels"].get(channels))
        return;

    juce::BigInteger bits;
    for (simdjson::dom::element v : channels) {
        int64_t idx = 0;
        if (!v.get(idx) && idx >= 0)
            bits.setBit(static_cast<int>(idx));
    }

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.outputChannels = bits;
    setup.useDefaultOutputChannels = false;
    const juce::String error = engine.deviceManager().setAudioDeviceSetup(setup, true);
    setStatus(error.isEmpty() ? juce::String("Output channels updated")
                              : ("Output channels error: " + error));
}

void MainComponent::settingsSetKeybinding(const std::string& json) {
    simdjson::dom::element doc;
    std::string action, key;
    if (!parseJson(json, doc) || !getString(doc, "action", action) || !getString(doc, "key", key))
        return;
    if (action.empty() || key.empty() || !isKnownAction(action))
        return;

    engine.project().keybindings[action] = key;
    applyProjectBindings();
    settingsPanel.refreshBindings();
    setStatus("Keybinding: " + juce::String(action) + " -> " + juce::String(key));
}

void MainComponent::settingsMidiLearn(const std::string& json) {
    simdjson::dom::element doc;
    std::string action;
    if (!parseJson(json, doc) || !getString(doc, "action", action))
        return;
    if (!isKnownAction(action))
        return;
    midiLearnAction = action;
    setStatus("MIDI learn armed: " + juce::String(action) + " -- press a pad/CC");
}

void MainComponent::settingsMidiLearnCancel() {
    if (midiLearnAction.empty())
        return;
    midiLearnAction.clear();
    setStatus("MIDI learn cancelled");
}

void MainComponent::settingsMidiClear(const std::string& json) {
    simdjson::dom::element doc;
    std::string action;
    if (!parseJson(json, doc) || !getString(doc, "action", action))
        return;
    auto& mappings = engine.project().midiMappings;
    const auto before = mappings.size();
    mappings.erase(std::remove_if(mappings.begin(), mappings.end(),
                                  [&](const MidiMapping& m) { return m.action == action; }),
                   mappings.end());
    if (mappings.size() == before)
        return;
    if (midiLearnAction == action)
        midiLearnAction.clear();
    applyProjectBindings();
    settingsPanel.refreshBindings();
    setStatus("MIDI cleared: " + juce::String(action));
}

} // namespace resoset
