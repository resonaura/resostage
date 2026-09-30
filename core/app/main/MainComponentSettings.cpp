// Settings-state assembly and app-level preferences for the web UI.
// Audio hardware and MIDI handlers live in the focused translation units under
// main/settings/; these are still MainComponent members so they share the same
// command-thread ownership as the rest of application state.

#include "ActionCatalogue.h"
#include "MainComponent.h"
#include "server/BuilderJson.h"

#include <algorithm>
#include <cctype>

namespace resostage {

using namespace builder_json;

void MainComponent::populateSettingsState(WebUiState::SettingsRow& out) {
    // Fresh vectors every call (publishWebState builds a new WebUiState, but
    // be explicit so a reused SettingsRow can never accumulate stale names).
    out = WebUiState::SettingsRow{};

    // Everything below the hardware block is cheap: it reads maps we already
    // hold in memory. The hardware block is not -- enumerating audio devices
    // means a full CoreAudio HAL rescan, which is IPC to coreaudiod, and
    // listing MIDI endpoints is the same story. This function runs from
    // publishWebState(), i.e. at the telemetry rate, so doing that per frame
    // was ~30 device rescans a second for a list that changes when somebody
    // physically plugs something in. It showed up as the heaviest thing on
    // the message thread in a sampling profile.
    //
    // Refreshed on a slow timer instead. Hot-plug still appears within
    // kHardwareRescanSeconds, and anything that deliberately changes the
    // device (settingsSetAudioOutputDevice et al.) calls
    // invalidateHardwareSettingsCache() so the UI updates immediately.
    constexpr double kHardwareRescanSeconds = 2.0;
    const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
    const bool stale = hardwareSettingsCacheMs == 0
                       || (nowMs - hardwareSettingsCacheMs)
                              >= static_cast<juce::uint32>(kHardwareRescanSeconds * 1000.0);
    if (stale) {
        hardwareSettingsCacheMs = nowMs;
        rescanHardwareSettings();
    }

    out.outputDevices = hardwareSettingsCache.outputDevices;
    out.currentOutputDevice = hardwareSettingsCache.currentOutputDevice;
    out.inputDevices = hardwareSettingsCache.inputDevices;
    out.currentInputDevice = hardwareSettingsCache.currentInputDevice;
    out.audioDrivers = hardwareSettingsCache.audioDrivers;
    out.currentAudioDriver = hardwareSettingsCache.currentAudioDriver;
    out.sampleRate = hardwareSettingsCache.sampleRate;
    out.bufferSize = hardwareSettingsCache.bufferSize;
    out.availableSampleRates = hardwareSettingsCache.availableSampleRates;
    out.availableBufferSizes = hardwareSettingsCache.availableBufferSizes;
    out.outputChannelNames = hardwareSettingsCache.outputChannelNames;
    out.activeOutputChannels = hardwareSettingsCache.activeOutputChannels;
    out.inputChannelNames = hardwareSettingsCache.inputChannelNames;
    out.activeInputChannels = hardwareSettingsCache.activeInputChannels;
    out.inputLatencyMs = hardwareSettingsCache.inputLatencyMs;
    out.outputLatencyMs = hardwareSettingsCache.outputLatencyMs;
    out.roundtripLatencyMs = hardwareSettingsCache.roundtripLatencyMs;
    out.midiOutputs = hardwareSettingsCache.midiOutputs;
    out.midiInputs = hardwareSettingsCache.midiInputs;
    out.currentMidiInput = appSettings.midiInputName;
    out.selectedMidiOutputs = appSettings.midiOutputNames;
    out.selectedMidiInputs = appSettings.midiInputNames;
    out.virtualMidiPortEnabled = hardwareSettingsCache.virtualMidiPortEnabled;

    out.uiRenderEngine = appSettings.uiRenderEngine;
    out.theme = appSettings.theme;
    out.countInBars = appSettings.countInBars;
    out.countInPreferredBars = appSettings.countInPreferredBars;

    const auto& bindings = appSettings.keybindings;
    for (const char* action : kActionIds) {
        WebUiState::SettingsRow::Keybinding kb;
        kb.action = action;
        const auto it = bindings.find(action);
        kb.key = (it != bindings.end()) ? it->second : "";
        kb.midiAssignable = isMidiMappableAction(action);
        out.keybindings.push_back(std::move(kb));
    }

    for (const char* action : kActionIds) {
        WebUiState::SettingsRow::MidiBinding mb;
        mb.action = action;
        for (const auto& m : appSettings.midiMappings) {
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

    for (const auto& rp : appSettings.recentProjects) {
        WebUiState::SettingsRow::RecentProject entry;
        entry.path = rp.path;
        entry.displayName = rp.displayName;
        entry.lastOpenedIso = rp.lastOpenedIso;
        out.recentProjects.push_back(std::move(entry));
    }
}

void MainComponent::settingsSetUiRenderEngine(const std::string& json) {
    glz::generic doc;
    std::string engineChoice;
    if (!parseJson(json, doc) || !getString(doc, "engine", engineChoice))
        return;
    // "browser" = default: open the SPA in the system browser. "electron" =
    // the Electron shell takes over the on-screen UI (see
    // launchElectronShell()/launchBrowserTab()). No native renderer anymore.
    // The engine can't be swapped hot -- the SPA offers a restart (POST
    // /api/v1/action restart_app) which relaunches with the new setting.
    if (engineChoice != "browser" && engineChoice != "electron")
        return;

    if (appSettings.uiRenderEngine == engineChoice)
        return;

    appSettings.uiRenderEngine = engineChoice;
    saveAppSettingsToDisk();
    publishWebState();
    setStatus("UI engine set to " + juce::String(engineChoice)
              + " (takes effect on app restart)");
}

void MainComponent::settingsSetTheme(const std::string& json) {
    glz::generic doc;
    std::string themeChoice;
    if (!parseJson(json, doc) || !getString(doc, "theme", themeChoice) || themeChoice.empty())
        return;

    if (appSettings.theme == themeChoice)
        return;

    appSettings.theme = themeChoice;
    saveAppSettingsToDisk();
    publishWebState();
    setStatus("Theme set to " + juce::String(themeChoice));
}

void MainComponent::settingsSetKeybinding(const std::string& json) {
    glz::generic doc;
    std::string action, key;
    if (!parseJson(json, doc) || !getString(doc, "action", action) || !getString(doc, "key", key))
        return;
    if (action.empty() || key.empty() || !isKnownActionId(action))
        return;

    const auto normalized = [](std::string value) {
        value.erase(std::remove_if(value.begin(), value.end(), [](unsigned char c) {
            return std::isspace(c) != 0;
        }), value.end());
        std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        return value;
    };
    const std::string normalizedKey = normalized(key);
    for (const auto& [otherAction, otherKey] : appSettings.keybindings) {
        if (otherAction != action && normalized(otherKey) == normalizedKey) {
            setStatus("Shortcut is already assigned to " + juce::String(otherAction));
            publishWebState();
            return;
        }
    }

    appSettings.keybindings[action] = key;
    applyGlobalBindings();
    saveAppSettingsToDisk();
    setStatus("Keybinding: " + juce::String(action) + " -> " + juce::String(key));
}

void MainComponent::settingsSetCountInBars(const std::string& json) {
    glz::generic doc;
    int bars = 0;
    if (!parseJson(json, doc) || !getInt(doc, "bars", bars))
        return;
    appSettings.countInBars = std::clamp(bars, 0, 2);
    if (appSettings.countInBars > 0)
        appSettings.countInPreferredBars = appSettings.countInBars;
    engine.setCountInBars(appSettings.countInBars);
    saveAppSettingsToDisk();
    publishWebState();
}

} // namespace resostage
