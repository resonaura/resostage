/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "MainComponent.h"

namespace resostage {

void MainComponent::invalidateHardwareSettingsCache() {
    hardwareSettingsCacheMs = 0;
}

// The expensive half of populateSettingsState: everything that has to ask the
// OS. Called at most every couple of seconds.
void MainComponent::rescanHardwareSettings() {
    HardwareSettingsCache& out = hardwareSettingsCache;
    out = HardwareSettingsCache{};

    auto& dm = engine.deviceManager();

    juce::OwnedArray<juce::AudioIODeviceType> types;
    dm.createAudioDeviceTypes(types);
    for (auto* type : types) {
        if (type != nullptr) {
            type->scanForDevices();
            out.audioDrivers.push_back(type->getTypeName().toStdString());
        }
    }
    if (auto* curType = dm.getCurrentDeviceTypeObject()) {
        curType->scanForDevices();
        out.currentAudioDriver = curType->getTypeName().toStdString();
    }
    if (auto* dev = dm.getCurrentAudioDevice())
        out.hasControlPanel = dev->hasControlPanel();

    // Prefer the currently selected type's names first.
    if (auto* curType = dm.getCurrentDeviceTypeObject()) {
        const auto names = curType->getDeviceNames(/*wantInputNames=*/false);
        const auto inNames = curType->getDeviceNames(/*wantInputNames=*/true);

        if (curType->hasSeparateInputsAndOutputs()) {
            for (const auto& n : names)
                out.outputDevices.push_back(n.toStdString());
            for (const auto& n : inNames)
                out.inputDevices.push_back(n.toStdString());
        } else {
            // For unified device types (e.g. ASIO), probe channel counts to separate inputs and outputs.
            for (const auto& n : names) {
                std::unique_ptr<juce::AudioIODevice> testDev(curType->createDevice(n, n));
                if (testDev == nullptr)
                    testDev.reset(curType->createDevice(n, ""));
                if (testDev != nullptr) {
                    if (testDev->getOutputChannelNames().size() > 0)
                        out.outputDevices.push_back(n.toStdString());
                    if (testDev->getInputChannelNames().size() > 0)
                        out.inputDevices.push_back(n.toStdString());
                } else {
                    out.outputDevices.push_back(n.toStdString());
                    out.inputDevices.push_back(n.toStdString());
                }
            }
        }
    } else if (!types.isEmpty() && types[0] != nullptr) {
        auto* firstType = types[0];
        const auto names = firstType->getDeviceNames(false);
        for (const auto& n : names)
            out.outputDevices.push_back(n.toStdString());
        const auto inNames = firstType->getDeviceNames(true);
        for (const auto& n : inNames)
            out.inputDevices.push_back(n.toStdString());
    }

    const auto setup = dm.getAudioDeviceSetup();
    auto* curDev = dm.getCurrentAudioDevice();
    auto* curTypeObj = dm.getCurrentDeviceTypeObject();

    out.currentOutputDevice = setup.outputDeviceName.toStdString();
    if (out.currentOutputDevice.empty() && curDev != nullptr && curDev->getOutputChannelNames().size() > 0) {
        const auto activeName = curDev->getName();
        if (curTypeObj != nullptr && curTypeObj->getDeviceNames(false).contains(activeName)) {
            out.currentOutputDevice = activeName.toStdString();
        }
    }
    // Only keep currentOutputDevice if it is a valid output device in outputDevices.
    if (!out.currentOutputDevice.empty()) {
        bool found = false;
        for (const auto& d : out.outputDevices) {
            if (d == out.currentOutputDevice) {
                found = true;
                break;
            }
        }
        if (!found) {
            // Never insert an input-only device into outputDevices!
            out.currentOutputDevice.clear();
        }
    }

    out.currentInputDevice = setup.inputDeviceName.toStdString();
    if (appSettings.audioInputDisabled) {
        out.currentInputDevice.clear();
    } else {
        if (out.currentInputDevice.empty() && curDev != nullptr && curDev->getInputChannelNames().size() > 0) {
            const auto activeName = curDev->getName();
            if (curTypeObj != nullptr && curTypeObj->getDeviceNames(true).contains(activeName)) {
                out.currentInputDevice = activeName.toStdString();
            }
        }
        if (!out.currentInputDevice.empty()) {
            bool found = false;
            for (const auto& d : out.inputDevices) {
                if (d == out.currentInputDevice) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                out.currentInputDevice.clear();
            }
        }
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

        const auto inChannelNames = device->getInputChannelNames();
        const auto activeIn = device->getActiveInputChannels();
        for (int i = 0; i < inChannelNames.size(); ++i) {
            out.inputChannelNames.push_back(inChannelNames[i].toStdString());
            out.activeInputChannels.push_back(activeIn[i]);
        }

        const int inLatencySamples = device->getInputLatencyInSamples();
        const int outLatencySamples = device->getOutputLatencyInSamples();
        if (out.sampleRate > 0.0) {
            out.inputLatencyMs = (inLatencySamples * 1000.0) / out.sampleRate;
            out.outputLatencyMs = (outLatencySamples * 1000.0) / out.sampleRate;
            out.roundtripLatencyMs = ((inLatencySamples + outLatencySamples) * 1000.0) / out.sampleRate;
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
}

// Remember what is selected on the device we are about to leave.
//
// Called before every switch. Without it, stepping onto the laptop's built-in
// output to check something and stepping back leaves the interface on its
// default stereo pair -- every wedge, sub and IEM feed silently unrouted,
// which on a stage gets discovered during the show.
void MainComponent::rememberCurrentDeviceProfile() {
    const auto setup = engine.deviceManager().getAudioDeviceSetup();
    std::string name = setup.outputDeviceName.toStdString();
    if (name.empty()) {
        if (auto* dev = engine.deviceManager().getCurrentAudioDevice()) {
            if (dev->getOutputChannelNames().size() > 0)
                name = dev->getName().toStdString();
        }
    }
    if (name.empty())
        return;

    AppSettings::DeviceProfile profile;
    profile.sampleRate = setup.sampleRate;
    profile.bufferSize = setup.bufferSize;
    if (auto* device = engine.deviceManager().getCurrentAudioDevice()) {
        if (profile.sampleRate <= 0.0)
            profile.sampleRate = device->getCurrentSampleRate();
        if (profile.bufferSize <= 0)
            profile.bufferSize = device->getCurrentBufferSizeSamples();
        // The DEVICE's own view of what is active, not the settings mirror:
        // a driver can refuse a channel we asked for, and remembering the
        // request rather than the result would re-fight that every switch.
        const auto active = device->getActiveOutputChannels();
        for (int i = 0; i < active.getHighestBit() + 1; ++i) {
            if (active[i])
                profile.activeOutputChannels.push_back(i);
        }
        const auto activeIn = device->getActiveInputChannels();
        for (int i = 0; i < activeIn.getHighestBit() + 1; ++i) {
            if (activeIn[i])
                profile.activeInputChannels.push_back(i);
        }
    }
    appSettings.deviceProfiles[name] = profile;
    if (setup.inputDeviceName.isNotEmpty() && setup.inputDeviceName != setup.outputDeviceName) {
        const std::string compositeKey = setup.outputDeviceName.toStdString() + "|" + setup.inputDeviceName.toStdString();
        appSettings.deviceProfiles[compositeKey] = profile;
    }
}

} // namespace resostage
