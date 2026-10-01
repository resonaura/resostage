// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#include "ActionCatalogue.h"
#include "MainComponent.h"
#include "server/BuilderJson.h"

#include <algorithm>

namespace resostage {

using namespace builder_json;

void MainComponent::settingsSetMidiOutput(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    std::vector<std::string> names;
    std::string legacyName;
    if (!parseJson(json, doc))
        return;
    if (!getStringArray(doc, "names", names)) {
        if (!getString(doc, "name", legacyName))
            return;
        if (!legacyName.empty())
            names.push_back(legacyName);
    }
    std::vector<std::string> uniqueNames;
    for (const auto& name : names) {
        if (!name.empty() && std::find(uniqueNames.begin(), uniqueNames.end(), name) == uniqueNames.end())
            uniqueNames.push_back(name);
    }

    std::string error;
    if (!engine.midi().openDestinations(uniqueNames, error)) {
        setStatus("MIDI output failed: " + juce::String(error));
    } else {
        appSettings.midiOutputNames = std::move(uniqueNames);
        appSettings.midiOutputName = appSettings.midiOutputNames.empty()
            ? std::string{} : appSettings.midiOutputNames.front();
        saveAppSettingsToDisk();
        setStatus(appSettings.midiOutputNames.empty()
            ? "MIDI hardware output disabled"
            : "MIDI output devices: " + juce::String(static_cast<int>(appSettings.midiOutputNames.size())));
    }
}

void MainComponent::settingsSetMidiInput(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    std::vector<std::string> names;
    std::string legacyName;
    if (!parseJson(json, doc))
        return;
    if (!getStringArray(doc, "names", names)) {
        if (!getString(doc, "name", legacyName))
            return;
        if (!legacyName.empty() && legacyName != "none")
            names.push_back(legacyName);
    }
    if (std::find(names.begin(), names.end(), "All Inputs") != names.end())
        names = {"All Inputs"};
    std::vector<std::string> uniqueNames;
    for (const auto& name : names) {
        if (!name.empty() && name != "none"
            && std::find(uniqueNames.begin(), uniqueNames.end(), name) == uniqueNames.end())
            uniqueNames.push_back(name);
    }

    const auto previousNames = appSettings.midiInputNames;
    std::string error;
    if (uniqueNames.empty()) {
        midiInput.closeSource();
    } else if (!midiInput.openSources(uniqueNames, error)) {
        if (!previousNames.empty()) {
            std::string restoreError;
            (void)midiInput.openSources(previousNames, restoreError);
        }
        setStatus("MIDI input failed: " + juce::String(error));
        return;
    }
    appSettings.midiInputNames = std::move(uniqueNames);
    appSettings.midiInputName = appSettings.midiInputNames.empty()
        ? std::string{} : appSettings.midiInputNames.front();
    saveAppSettingsToDisk();
    setStatus(appSettings.midiInputNames.empty()
        ? "MIDI input: None"
        : "MIDI input devices: " + juce::String(static_cast<int>(appSettings.midiInputNames.size())));
}

void MainComponent::settingsSetMidiVirtualPort(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    bool enabled = false;
    if (!parseJson(json, doc) || !getBool(doc, "enabled", enabled))
        return;

    if (enabled) {
        std::string error;
        if (!engine.midi().enableVirtualSource(error)) {
            setStatus("Virtual MIDI port failed: " + juce::String(error));
            return;
        }
        setStatus("Virtual MIDI port enabled: ResoStage Sync");
    } else {
        engine.midi().disableVirtualSource();
        setStatus("Virtual MIDI port disabled");
    }
    appSettings.virtualMidiPortEnabled = enabled;
    saveAppSettingsToDisk();
}

void MainComponent::settingsMidiLearn(const std::string& json) {
    glz::generic doc;
    std::string action;
    if (!parseJson(json, doc) || !getString(doc, "action", action))
        return;
    if (!isMidiMappableAction(action))
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
    glz::generic doc;
    std::string action;
    if (!parseJson(json, doc) || !getString(doc, "action", action))
        return;
    auto& mappings = appSettings.midiMappings;
    const auto before = mappings.size();
    mappings.erase(std::remove_if(mappings.begin(), mappings.end(),
                                  [&](const MidiMapping& mapping) { return mapping.action == action; }),
                   mappings.end());
    if (mappings.size() == before)
        return;
    if (midiLearnAction == action)
        midiLearnAction.clear();
    applyGlobalBindings();
    saveAppSettingsToDisk();
    setStatus("MIDI cleared: " + juce::String(action));
}

} // namespace resostage
