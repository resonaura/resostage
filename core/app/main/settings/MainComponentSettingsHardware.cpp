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
        for (const auto& n : names)
            out.outputDevices.push_back(n.toStdString());
        const auto inNames = curType->getDeviceNames(/*wantInputNames=*/true);
        for (const auto& n : inNames)
            out.inputDevices.push_back(n.toStdString());
    }
    // Then any other types (aggregate, no dups).
    {
        juce::StringArray seen;
        for (const auto& s : out.outputDevices)
            seen.add(juce::String(s));
        juce::StringArray seenIn;
        for (const auto& s : out.inputDevices)
            seenIn.add(juce::String(s));
        for (auto* type : types) {
            if (type == nullptr || type == dm.getCurrentDeviceTypeObject())
                continue;
            const auto names = type->getDeviceNames(false);
            for (const auto& n : names) {
                if (seen.contains(n))
                    continue;
                seen.add(n);
                out.outputDevices.push_back(n.toStdString());
            }
            const auto inNames = type->getDeviceNames(true);
            for (const auto& n : inNames) {
                if (seenIn.contains(n))
                    continue;
                seenIn.add(n);
                out.inputDevices.push_back(n.toStdString());
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

    out.currentInputDevice = setup.inputDeviceName.toStdString();
    if (!out.currentInputDevice.empty()) {
        bool found = false;
        for (const auto& d : out.inputDevices) {
            if (d == out.currentInputDevice) {
                found = true;
                break;
            }
        }
        if (!found)
            out.inputDevices.insert(out.inputDevices.begin(), out.currentInputDevice);
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
        if (auto* dev = engine.deviceManager().getCurrentAudioDevice())
            name = dev->getName().toStdString();
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
