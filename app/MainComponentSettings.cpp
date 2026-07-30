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
#include <cmath>

namespace resostage {

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
    // Fresh vectors every call (publishWebState builds a new WebUiState, but
    // be explicit so a reused SettingsRow can never accumulate stale names).
    out = WebUiState::SettingsRow{};

    auto& dm = engine.deviceManager();

    // Touch the device-type list (JUCE lazy-creates types on first access)
    // then rescan so hot-plug names appear.
    (void)dm.getAvailableDeviceTypes();
    for (auto* type : dm.getAvailableDeviceTypes()) {
        if (type != nullptr)
            type->scanForDevices();
    }

    // Prefer the currently selected type's names first.
    if (auto* curType = dm.getCurrentDeviceTypeObject()) {
        const auto names = curType->getDeviceNames(/*wantInputNames=*/false);
        for (const auto& n : names)
            out.outputDevices.push_back(n.toStdString());
    }
    // Then any other types (aggregate, no dups).
    {
        juce::StringArray seen;
        for (const auto& s : out.outputDevices)
            seen.add(juce::String(s));
        for (auto* type : dm.getAvailableDeviceTypes()) {
            if (type == nullptr || type == dm.getCurrentDeviceTypeObject())
                continue;
            const auto names = type->getDeviceNames(false);
            for (const auto& n : names) {
                if (seen.contains(n))
                    continue;
                seen.add(n);
                out.outputDevices.push_back(n.toStdString());
            }
        }
    }

    const auto setup = dm.getAudioDeviceSetup();
    out.currentOutputDevice = setup.outputDeviceName.toStdString();
    if (out.currentOutputDevice.empty()) {
        if (auto* dev = dm.getCurrentAudioDevice())
            out.currentOutputDevice = dev->getName().toStdString();
    }
    // Always list the active device even if scan returned nothing.
    if (!out.currentOutputDevice.empty()) {
        bool found = false;
        for (const auto& d : out.outputDevices) {
            if (d == out.currentOutputDevice) {
                found = true;
                break;
            }
        }
        if (!found)
            out.outputDevices.insert(out.outputDevices.begin(), out.currentOutputDevice);
    }

    out.sampleRate = setup.sampleRate;
    out.bufferSize = setup.bufferSize;
    if (auto* device = dm.getCurrentAudioDevice()) {
        if (out.sampleRate <= 0.0)
            out.sampleRate = device->getCurrentSampleRate();
        if (out.bufferSize <= 0)
            out.bufferSize = device->getCurrentBufferSizeSamples();
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
    // Fallback so selects are never blank when the device is open.
    if (out.availableSampleRates.empty() && out.sampleRate > 0.0)
        out.availableSampleRates.push_back(out.sampleRate);
    if (out.availableBufferSizes.empty() && out.bufferSize > 0)
        out.availableBufferSizes.push_back(out.bufferSize);

    for (const auto& n : engine.midi().availableDestinationNames())
        out.midiOutputs.push_back(n);
    for (const auto& n : midiInput.availableSourceNames())
        out.midiInputs.push_back(n);
    out.virtualMidiPortEnabled = engine.midi().hasVirtualSource();

    const auto& bindings = engine.project().keybindings;
    for (const char* action : kActions) {
        WebUiState::SettingsRow::Keybinding kb;
        kb.action = action;
        const auto it = bindings.find(action);
        kb.key = (it != bindings.end()) ? it->second : "";
        out.keybindings.push_back(std::move(kb));
    }

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
    const juce::String error = engine.setAudioDeviceSetup(setup, true);
    setStatus(error.isEmpty() ? ("Audio output: " + juce::String(name)) : ("Audio device error: " + error));
}

void MainComponent::settingsSetSampleRate(const std::string& json) {
    simdjson::dom::element doc;
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
    const juce::String error = engine.setAudioDeviceSetup(setup, true);
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
    simdjson::dom::element doc;
    int value = 0;
    if (!parseJson(json, doc) || !getInt(doc, "value", value) || value <= 0)
        return;

    auto setup = engine.deviceManager().getAudioDeviceSetup();
    setup.bufferSize = value;
    const juce::String error = engine.setAudioDeviceSetup(setup, true);
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

void MainComponent::settingsSetMidiVirtualPort(const std::string& json) {
    simdjson::dom::element doc;
    bool enabled = false;
    if (!parseJson(json, doc) || !getBool(doc, "enabled", enabled))
        return;

    if (enabled) {
        std::string error;
        if (!engine.midi().enableVirtualSource(error))
            setStatus("Virtual MIDI port failed: " + juce::String(error));
        else
            setStatus("Virtual MIDI port enabled: ResoStage Sync");
    } else {
        engine.midi().disableVirtualSource();
        setStatus("Virtual MIDI port disabled");
    }
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
    const juce::String error = engine.setAudioDeviceSetup(setup, true);
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
    setStatus("MIDI cleared: " + juce::String(action));
}

} // namespace resostage
