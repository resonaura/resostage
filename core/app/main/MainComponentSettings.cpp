// Settings parity for the web UI. Mirrors SettingsPanel.cpp's
// AudioDeviceSelectorComponent callbacks and MIDI/keybinding row handlers --
// same juce::AudioDeviceManager / CoreMidiDispatcher / CoreMidiInputListener
// / Project::keybindings calls, just JSON-driven instead of widget-driven.
// Kept in its own translation unit for the same reason as
// MainComponentBuilder.cpp: keeps MainComponent.cpp from ballooning while
// still being full MainComponent member functions.

#include "ActionCatalogue.h"
#include "MainComponent.h"
#include "server/BuilderJson.h"

#include <algorithm>
#include <cctype>
#include <cmath>

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

/**
 * Change the audio device with the outputs faded down first.
 *
 * Every one of these tears the device down and brings it back, which is a
 * ~100ms hole in the output whatever we do -- the driver simply stops calling
 * us. What is avoidable is the crack at each edge: cutting a running signal
 * mid-sample and resuming at full level are both step discontinuities, and
 * that is what a buffer-size change actually sounded (and metered) like.
 * The engine ramps back up on its own in audioDeviceAboutToStart.
 */
static juce::String applyDeviceSetupWithFade(AudioEngine& engine,
                                             const juce::AudioDeviceManager::AudioDeviceSetup& setup) {
    const int waitMs = engine.prepareForDeviceReconfigure();
    if (waitMs > 0)
        juce::Thread::sleep(waitMs);
    return engine.setAudioDeviceSetup(setup, true);
}

void MainComponent::settingsSetAudioOutputDevice(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    std::string name;
    if (!parseJson(json, doc) || !getString(doc, "name", name))
        return;

    rememberCurrentDeviceProfile();

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.outputDeviceName = name;

    // Restore what this device had last time, if we have ever seen it.
    const std::string compositeKey = name + "|" + setup.inputDeviceName.toStdString();
    auto it = appSettings.deviceProfiles.find(compositeKey);
    if (it == appSettings.deviceProfiles.end()) {
        it = appSettings.deviceProfiles.find(name);
    }
    const bool haveProfile = it != appSettings.deviceProfiles.end();
    if (haveProfile) {
        const auto& p = it->second;
        if (p.sampleRate > 0.0)
            setup.sampleRate = p.sampleRate;
        if (p.bufferSize > 0)
            setup.bufferSize = p.bufferSize;
        if (!p.activeOutputChannels.empty()) {
            juce::BigInteger bits;
            for (int idx : p.activeOutputChannels) {
                if (idx >= 0)
                    bits.setBit(idx);
            }
            setup.outputChannels = bits;
            setup.useDefaultOutputChannels = false;
        } else {
            setup.useDefaultOutputChannels = true;
        }
        if (!p.activeInputChannels.empty()) {
            juce::BigInteger bits;
            for (int idx : p.activeInputChannels) {
                if (idx >= 0)
                    bits.setBit(idx);
            }
            setup.inputChannels = bits;
            setup.useDefaultInputChannels = false;
        } else {
            setup.useDefaultInputChannels = true;
        }
    } else {
        // Never seen: let the driver pick both, which is also what happens
        // after a reset. 0 means "your choice" to JUCE, not "zero".
        setup.useDefaultOutputChannels = true;
        setup.useDefaultInputChannels = true;
        setup.sampleRate = 0;
        setup.bufferSize = 0;
    }
    if (appSettings.audioInputDisabled) {
        setup.inputDeviceName.clear();
        setup.inputChannels.clear();
        setup.useDefaultInputChannels = false;
    }

    const juce::String error = applyDeviceSetupWithFade(engine, setup);
    if (error.isEmpty()) {
        appSettings.outputDeviceName = name;
        appSettings.activeOutputChannels.clear();
        if (haveProfile) {
            appSettings.activeOutputChannels = it->second.activeOutputChannels;
            if (!appSettings.audioInputDisabled)
                appSettings.activeInputChannels = it->second.activeInputChannels;
            if (it->second.sampleRate > 0.0)
                appSettings.sampleRate = it->second.sampleRate;
            if (it->second.bufferSize > 0)
                appSettings.bufferSize = it->second.bufferSize;
        }
        saveAppSettingsToDisk();
        engine.rebuildDirectOutBusses();
        publishWebState();
        setStatus(haveProfile
                      ? "Audio output: " + juce::String(name) + " (restored its saved routing)"
                      : "Audio output: " + juce::String(name));
    } else {
        setStatus("Audio device error: " + error);
    }
}

void MainComponent::settingsSetAudioInputDevice(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    std::string name;
    if (!parseJson(json, doc) || !getString(doc, "name", name))
        return;

    rememberCurrentDeviceProfile();

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.inputDeviceName = name;
    const bool disableInput = name.empty();

    const std::string compositeKey = setup.outputDeviceName.toStdString() + "|" + name;
    auto it = appSettings.deviceProfiles.find(compositeKey);
    if (it == appSettings.deviceProfiles.end()) {
        it = appSettings.deviceProfiles.find(setup.outputDeviceName.toStdString());
    }
    const bool haveProfile = it != appSettings.deviceProfiles.end();
    if (disableInput) {
        setup.inputChannels.clear();
        setup.useDefaultInputChannels = false;
    } else if (haveProfile && !it->second.activeInputChannels.empty()) {
        juce::BigInteger bits;
        for (int idx : it->second.activeInputChannels) {
            if (idx >= 0)
                bits.setBit(idx);
        }
        setup.inputChannels = bits;
        setup.useDefaultInputChannels = false;
    } else {
        setup.useDefaultInputChannels = true;
    }

    const juce::String error = applyDeviceSetupWithFade(engine, setup);
    if (error.isEmpty()) {
        appSettings.inputDeviceName = name;
        appSettings.audioInputDisabled = disableInput;
        appSettings.activeInputChannels.clear();
        if (haveProfile && !disableInput) {
            appSettings.activeInputChannels = it->second.activeInputChannels;
        }
        saveAppSettingsToDisk();
        publishWebState();
        setStatus(name.empty() ? "Audio input disabled" : "Audio input: " + juce::String(name));
    } else {
        setStatus("Audio input device error: " + error);
    }
}

// Switch host audio API (ASIO / CoreAudio / ALSA / JACK / Windows Audio).
//
// Separate from picking a device because the same interface can be reachable
// through two APIs with wildly different latency -- an ASIO rig that comes
// back on WASAPI after a restart is a rig that misses its cues.
void MainComponent::settingsSetAudioDeviceType(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    std::string type;
    if (!parseJson(json, doc) || !getString(doc, "type", type) || type.empty())
        return;

    rememberCurrentDeviceProfile();
    auto& dm = engine.deviceManager();

    juce::OwnedArray<juce::AudioIODeviceType> types;
    dm.createAudioDeviceTypes(types);

    bool known = false;
    for (auto* t : types) {
        if (t != nullptr && t->getTypeName() == juce::String(type)) {
            known = true;
            break;
        }
    }
    if (!known) {
        setStatus("Audio driver not available: " + juce::String(type));
        return;
    }

    // true: open the new type's default device immediately, so the rig is
    // audible again without a second round trip.
    dm.setCurrentAudioDeviceType(juce::String(type), true);
    if (dm.getCurrentAudioDevice() == nullptr) {
        setStatus("Audio driver " + juce::String(type) + " has no usable device");
        return;
    }

    if (appSettings.audioInputDisabled) {
        auto setup = dm.getAudioDeviceSetup();
        setup.inputDeviceName.clear();
        setup.inputChannels.clear();
        setup.useDefaultInputChannels = false;
        const juce::String error = applyDeviceSetupWithFade(engine, setup);
        if (!error.isEmpty())
            setStatus("Audio driver changed, but input disablement could not be restored: " + error);
    }

    appSettings.audioDeviceType = type;
    appSettings.outputDeviceName = dm.getCurrentAudioDevice()->getName().toStdString();
    appSettings.activeOutputChannels.clear();
    saveAppSettingsToDisk();
    engine.rebuildDirectOutBusses();
    publishWebState();
    setStatus("Audio driver: " + juce::String(type));
}

void MainComponent::settingsShowAudioControlPanel() {
    if (auto* dev = engine.deviceManager().getCurrentAudioDevice()) {
        if (dev->hasControlPanel()) {
            dev->showControlPanel();
            setStatus("Opened audio control panel");
        } else {
            setStatus("Current audio driver has no control panel");
        }
    }
}

void MainComponent::settingsSetSampleRate(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    double value = 0.0;
    if (!parseJson(json, doc) || !getDouble(doc, "value", value) || value <= 0.0)
        return;

    // Pre-flight: reject unsupported rates immediately with a specific
    // message instead of relying solely on JUCE's error string -- some
    // drivers otherwise silently substitute the nearest supported rate
    // rather than erroring (caught below too, but this avoids the round
    // trip and gives a clearer message when the device already told us its
    // supported list).
    if (auto* device = engine.deviceManager().getCurrentAudioDevice()) {
        const auto available = device->getAvailableSampleRates();
        if (!available.isEmpty()) {
            bool supported = false;
            for (double r : available) {
                if (std::abs(r - value) < 1e-6) {
                    supported = true;
                    break;
                }
            }
            if (!supported) {
                juce::String list;
                for (double r : available)
                    list << juce::String(r, 0) << " ";
                setStatus("Sample rate " + juce::String(value, 0) + " Hz not supported by this device (available: "
                          + list.trim() + " Hz)");
                return;
            }
        }
    }

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.sampleRate = value;
    const juce::String error = applyDeviceSetupWithFade(engine, setup);
    if (!error.isEmpty()) {
        // Rejected -- audioDeviceAboutToStart never fires with a new rate,
        // so currentSampleRate/clock/clickGenerator/StreamingEngine stay
        // untouched at the old (still working) rate.
        setStatus("Sample rate error: " + error);
        return;
    }

    // Post-change verification: an empty error string is not proof the
    // requested rate actually took effect -- CoreAudio/JUCE can silently
    // apply the nearest supported rate instead.
    double actualRate = 0.0;
    if (auto* device = engine.deviceManager().getCurrentAudioDevice())
        actualRate = device->getCurrentSampleRate();
    appSettings.sampleRate = actualRate > 0.0 ? actualRate : value;
    saveAppSettingsToDisk();
    if (actualRate > 0.0 && std::abs(actualRate - value) > 1e-6) {
        setStatus("Sample rate: requested " + juce::String(value, 0) + " Hz, device applied "
                  + juce::String(actualRate, 0) + " Hz instead");
    } else {
        setStatus("Sample rate: " + juce::String(value, 0) + " Hz");
    }
    // Transport resume (if it was live before this reconfiguration) is
    // handled centrally by AudioEngine::audioDeviceStopped()/
    // audioDeviceAboutToStart() -- see resumeAfterDeviceRestart -- since
    // that's the only place the restart's true ordering (stop, any
    // rate-change restage, then resume) is guaranteed rather than raced.
}

void MainComponent::settingsSetBufferSize(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    int value = 0;
    if (!parseJson(json, doc) || !getInt(doc, "value", value) || value <= 0)
        return;

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.bufferSize = value;
    const juce::String error = applyDeviceSetupWithFade(engine, setup);
    if (error.isEmpty()) {
        appSettings.bufferSize = value;
        saveAppSettingsToDisk();
        setStatus("Buffer size: " + juce::String(value) + " samples");
    } else {
        setStatus("Buffer size error: " + error);
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

void MainComponent::settingsSetOutputChannels(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    if (!parseJson(json, doc))
        return;
    const auto* channels = getArray(doc, "channels");
    if (channels == nullptr)
        return;

    juce::BigInteger bits;
    for (const auto& v : *channels) {
        int idx = 0;
        if (asInt(v, idx) && idx >= 0)
            bits.setBit(idx);
    }

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.outputChannels = bits;
    setup.useDefaultOutputChannels = false;
    const juce::String error = applyDeviceSetupWithFade(engine, setup);
    if (error.isEmpty()) {
        appSettings.activeOutputChannels.clear();
        for (const auto& v : *channels) {
            int idx = 0;
            if (asInt(v, idx) && idx >= 0)
                appSettings.activeOutputChannels.push_back(idx);
        }
        rememberCurrentDeviceProfile();
        saveAppSettingsToDisk();
        engine.rebuildDirectOutBusses();
        publishWebState();
        setStatus("Output channels updated");
    } else {
        setStatus("Output channels error: " + error);
    }
}

void MainComponent::settingsSetInputChannels(const std::string& json) {
    invalidateHardwareSettingsCache();
    glz::generic doc;
    if (!parseJson(json, doc))
        return;
    const auto* channels = getArray(doc, "channels");
    if (channels == nullptr)
        return;

    juce::BigInteger bits;
    for (const auto& v : *channels) {
        int idx = 0;
        if (asInt(v, idx) && idx >= 0)
            bits.setBit(idx);
    }

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.inputChannels = bits;
    setup.useDefaultInputChannels = false;
    const juce::String error = applyDeviceSetupWithFade(engine, setup);
    if (error.isEmpty()) {
        appSettings.activeInputChannels.clear();
        for (const auto& v : *channels) {
            int idx = 0;
            if (asInt(v, idx) && idx >= 0)
                appSettings.activeInputChannels.push_back(idx);
        }
        rememberCurrentDeviceProfile();
        saveAppSettingsToDisk();
        publishWebState();
        setStatus("Input channels updated");
    } else {
        setStatus("Input channels error: " + error);
    }
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
