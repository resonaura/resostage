/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "CoreMidiInputListener.h"

// Windows (WinMM) implementation of CoreMidiInputListener.
//
// The macOS file (CoreMidiInputListener.cpp) uses CoreMIDI's input port
// callback. WinMM delivers input through a midiInProc callback on its own
// thread, so this implementation maps that onto the same MidiMapping logic
// (Note On / Control Change -> named action). The public behaviour is
// identical: onAction / onRawMessage fire on WinMM's callback thread, so
// callers must still marshal to their own UI thread.

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mmsystem.h>
#pragma comment(lib, "winmm.lib")

#include <array>
#include <algorithm>

namespace resostage {

namespace {

std::string devNameToUtf8(const TCHAR* name) {
#ifdef UNICODE
    const int len = WideCharToMultiByte(CP_UTF8, 0, name, -1, nullptr, 0, nullptr, nullptr);
    if (len <= 0)
        return {};
    std::string out;
    out.resize(static_cast<size_t>(len) - 1);
    WideCharToMultiByte(CP_UTF8, 0, name, -1, out.data(), len, nullptr, nullptr);
    return out;
#else
    // ANSI build: szPname is already a narrow string; reinterpret as UTF-8.
    return name ? std::string(name) : std::string();
#endif
}

std::string devDisplayName(const TCHAR* name, UINT deviceId) {
    return devNameToUtf8(name) + " [WinMM " + std::to_string(deviceId) + "]";
}

} // namespace

void CALLBACK midiInProc(void* hMidiIn, unsigned int wMsg, void* dwInstance, void* dwParam1, void* dwParam2) {
    (void)hMidiIn;
    (void)dwParam2;
    auto* self = reinterpret_cast<CoreMidiInputListener*>(dwInstance);
    if (self == nullptr)
        return;

    // MIM_DATA carries a single complete short message in dwParam1:
    // byte0 | byte1<<8 | byte2<<16.
    if (wMsg == MIM_DATA) {
        const auto msg = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(dwParam1));
        const uint8_t status = static_cast<uint8_t>(msg & 0xFF);
        const uint8_t data1 = static_cast<uint8_t>((msg >> 8) & 0xFF);
        const uint8_t data2 = static_cast<uint8_t>((msg >> 16) & 0xFF);
        self->handleIncomingMessage(status, data1, data2);
    }
}

CoreMidiInputListener::CoreMidiInputListener() = default;

CoreMidiInputListener::~CoreMidiInputListener() {
    closeSource();
}

std::string CoreMidiInputListener::currentSource() const {
    std::lock_guard<std::mutex> lock(sourceMutex);
    return currentSourceNames.empty() ? std::string{} : currentSourceNames.front();
}

std::vector<std::string> CoreMidiInputListener::availableSourceNames() const {
    std::vector<std::string> names;
    names.push_back("All Inputs");
    const UINT count = midiInGetNumDevs();
    names.reserve(count + 1);
    for (UINT i = 0; i < count; ++i) {
        MIDIINCAPS caps{};
        if (midiInGetDevCaps(i, &caps, sizeof(caps)) == MMSYSERR_NOERROR) {
            names.push_back(devDisplayName(caps.szPname, i));
        }
    }
    return names;
}

bool CoreMidiInputListener::openSource(const std::string& sourceName, std::string& error) {
    return openSources({sourceName.empty() ? "All Inputs" : sourceName}, error);
}

bool CoreMidiInputListener::openSources(const std::vector<std::string>& sourceNames, std::string& error) {
    std::lock_guard<std::mutex> lock(sourceMutex);
    closeSourceInternal();
    currentSourceNames.clear();
    for (const auto& name : sourceNames) {
        if (!name.empty() && std::find(currentSourceNames.begin(), currentSourceNames.end(), name)
                                 == currentSourceNames.end())
            currentSourceNames.push_back(name);
    }
    const bool allInputs = currentSourceNames.size() == 1
        && (currentSourceNames.front() == "All Inputs" || currentSourceNames.front() == "all");
    if (currentSourceNames.empty())
        return true;
    const UINT count = midiInGetNumDevs();
    if (count == 0) {
        error = "No Windows MIDI input devices available";
        return false;
    }

    for (UINT deviceId = 0; deviceId < count; ++deviceId) {
        MIDIINCAPS caps{};
        if (midiInGetDevCaps(deviceId, &caps, sizeof(caps)) != MMSYSERR_NOERROR)
            continue;
        const std::string name = devNameToUtf8(caps.szPname);
        if (!allInputs
            && std::find(currentSourceNames.begin(), currentSourceNames.end(), name)
                == currentSourceNames.end()
            && std::find(currentSourceNames.begin(), currentSourceNames.end(),
                    devDisplayName(caps.szPname, deviceId)) == currentSourceNames.end())
            continue;
        HMIDIIN handle = nullptr;
        const MMRESULT res = midiInOpen(&handle, deviceId, reinterpret_cast<DWORD_PTR>(&midiInProc),
                                        reinterpret_cast<DWORD_PTR>(this), CALLBACK_FUNCTION);
        if (res != MMSYSERR_NOERROR || midiInStart(handle) != MMSYSERR_NOERROR) {
            if (handle != nullptr)
                midiInClose(handle);
            if (error.empty())
                error = "Failed to open Windows MIDI input device: " + name;
            continue;
        }
        inputSources.push_back(reinterpret_cast<MidiEndpointRef>(handle));
    }

    source = inputSources.empty() ? 0 : inputSources.front();
    if (!inputSources.empty())
        return true;
    if (error.empty())
        error = "No selected Windows MIDI input device was found";
    return false;
}

void CoreMidiInputListener::closeSource() {
    std::lock_guard<std::mutex> lock(sourceMutex);
    closeSourceInternal();
}

void CoreMidiInputListener::closeSourceInternal() {
    for (const MidiEndpointRef input : inputSources) {
        HMIDIIN handle = reinterpret_cast<HMIDIIN>(input);
        midiInStop(handle);
        midiInClose(handle);
    }
    inputSources.clear();
    source = 0;
    currentSourceNames.clear();
}

void CoreMidiInputListener::setMappings(std::vector<MidiMapping> newMappings) {
    std::lock_guard<std::mutex> lock(mappingsMutex);
    mappings = std::move(newMappings);
}

// Mirrors the macOS handlePacketList logic exactly -- see that file's comment
// on why a velocity-0 Note On is treated as a Note Off.
void CoreMidiInputListener::handleIncomingMessage(uint8_t status, uint8_t data1, uint8_t data2) {
    const uint8_t statusHigh = static_cast<uint8_t>(status & 0xF0);
    const uint8_t channel = static_cast<uint8_t>(status & 0x0F);

    const uint8_t msgBytes[3] = {status, data1, data2};
    if (onMidiMessageReceived) {
        onMidiMessageReceived(msgBytes, 3);
    }

    bool haveEvent = false;
    MidiTriggerType eventType = MidiTriggerType::NoteOn;
    uint8_t number = 0;
    uint8_t rawValue = 0;

    if (statusHigh == 0x90 && data2 > 0) {
        haveEvent = true;
        eventType = MidiTriggerType::NoteOn;
        number = data1;
        rawValue = data2;
    } else if (statusHigh == 0xB0) {
        haveEvent = true;
        eventType = MidiTriggerType::ControlChange;
        number = data1;
        rawValue = data2;
    }

    if (haveEvent) {
        if (onRawMessage)
            onRawMessage(eventType, channel + 1, number, rawValue);

        std::lock_guard<std::mutex> lock(mappingsMutex);
        for (const MidiMapping& m : mappings) {
            if (m.channel != 0 && (m.channel - 1) != channel)
                continue;
            if (m.triggerType != eventType || m.number != number)
                continue;

            const bool isContinuous = (m.action.rfind("track_gain:", 0) == 0 ||
                                       m.action.rfind("track_pan:", 0) == 0 ||
                                       m.action == "master_gain" ||
                                       m.action.rfind("send_level:", 0) == 0 ||
                                       m.action.rfind("plugin_param:", 0) == 0);
            if (isContinuous && eventType == MidiTriggerType::ControlChange) {
                if (onContinuousAction) {
                    const float norm = static_cast<float>(rawValue) / 127.0f;
                    onContinuousAction(m.action, norm);
                }
            } else if (onAction) {
                onAction(m.action);
            }
        }
    }
}

} // namespace resostage

#endif // _WIN32
