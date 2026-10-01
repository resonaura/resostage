/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "MainComponent.h"
#include "server/BuilderJson.h"

#include <cmath>

namespace resostage {

using namespace builder_json;

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

    auto& dm = engine.deviceManager();
    auto* curType = dm.getCurrentDeviceTypeObject();
    if (curType != nullptr) {
        const auto outNames = curType->getDeviceNames(/*wantInputNames=*/false);
        if (!outNames.contains(juce::String(name))) {
            setStatus("Audio output device not available or input-only: " + juce::String(name));
            return;
        }
        if (!curType->hasSeparateInputsAndOutputs()) {
            std::unique_ptr<juce::AudioIODevice> testDev(curType->createDevice(name, name));
            if (testDev == nullptr)
                testDev.reset(curType->createDevice(name, ""));
            if (testDev != nullptr && testDev->getOutputChannelNames().size() == 0) {
                setStatus("Audio device has no output channels: " + juce::String(name));
                return;
            }
        }
    }

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
    if (!name.empty()) {
        auto& dm = engine.deviceManager();
        auto* curType = dm.getCurrentDeviceTypeObject();
        if (curType != nullptr) {
            const auto inNames = curType->getDeviceNames(/*wantInputNames=*/true);
            if (!inNames.contains(juce::String(name))) {
                setStatus("Audio input device not available or output-only: " + juce::String(name));
                return;
            }
            if (!curType->hasSeparateInputsAndOutputs()) {
                std::unique_ptr<juce::AudioIODevice> testDev(curType->createDevice(name, name));
                if (testDev == nullptr)
                    testDev.reset(curType->createDevice("", name));
                if (testDev != nullptr && testDev->getInputChannelNames().size() == 0) {
                    setStatus("Audio device has no input channels: " + juce::String(name));
                    return;
                }
            }
        }
    }

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
    auto* curTypeObj = dm.getCurrentDeviceTypeObject();
    if (auto* dev = dm.getCurrentAudioDevice()) {
        if (dev->getOutputChannelNames().size() > 0 &&
            (curTypeObj == nullptr || curTypeObj->getDeviceNames(false).contains(dev->getName()))) {
            appSettings.outputDeviceName = dev->getName().toStdString();
        } else if (curTypeObj != nullptr) {
            const auto outNames = curTypeObj->getDeviceNames(false);
            const int defIdx = curTypeObj->getDefaultDeviceIndex(false);
            if (defIdx >= 0 && defIdx < outNames.size())
                appSettings.outputDeviceName = outNames[defIdx].toStdString();
            else if (!outNames.isEmpty())
                appSettings.outputDeviceName = outNames[0].toStdString();
            else
                appSettings.outputDeviceName.clear();
        }
    }
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

} // namespace resostage
