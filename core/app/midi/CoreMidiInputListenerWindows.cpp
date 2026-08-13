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
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mmsystem.h>
#pragma comment(lib, "winmm.lib")

#include <array>

namespace resostage {

namespace {

void CALLBACK midiInProc(HMIDIIN hMidiIn, UINT wMsg, DWORD_PTR dwInstance, DWORD_PTR dwParam1, DWORD_PTR dwParam2) {
    (void)hMidiIn;
    (void)dwParam2;
    auto* self = reinterpret_cast<CoreMidiInputListener*>(dwInstance);
    if (self == nullptr)
        return;

    // MIM_DATA carries a single complete short message in dwParam1:
    // byte0 | byte1<<8 | byte2<<16.
    if (wMsg == MIM_DATA) {
        const DWORD msg = static_cast<DWORD>(dwParam1);
        const uint8_t status = static_cast<uint8_t>(msg & 0xFF);
        const uint8_t data1 = static_cast<uint8_t>((msg >> 8) & 0xFF);
        const uint8_t data2 = static_cast<uint8_t>((msg >> 16) & 0xFF);
        self->handleIncomingMessage(status, data1, data2);
    }
}

} // namespace

CoreMidiInputListener::CoreMidiInputListener() = default;

CoreMidiInputListener::~CoreMidiInputListener() {
    closeSource();
}

std::vector<std::string> CoreMidiInputListener::availableSourceNames() const {
    std::vector<std::string> names;
    const UINT count = midiInGetNumDevs();
    names.reserve(count);
    for (UINT i = 0; i < count; ++i) {
        MIDIINCAPS caps{};
        if (midiInGetDevCaps(i, &caps, sizeof(caps)) == MMSYSERR_NOERROR) {
            const int len = WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, nullptr, 0, nullptr, nullptr);
            std::string name;
            if (len > 0) {
                name.resize(static_cast<size_t>(len) - 1);
                WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, name.data(), len, nullptr, nullptr);
            }
            names.push_back(name);
        }
    }
    return names;
}

bool CoreMidiInputListener::openSource(const std::string& sourceName, std::string& error) {
    closeSource();

    const UINT count = midiInGetNumDevs();
    if (count == 0) {
        error = "No Windows MIDI input devices available";
        return false;
    }

    UINT deviceId = 0;
    bool found = false;
    if (sourceName.empty()) {
        deviceId = 0;
        found = true;
    } else {
        for (UINT i = 0; i < count; ++i) {
            MIDIINCAPS caps{};
            if (midiInGetDevCaps(i, &caps, sizeof(caps)) != MMSYSERR_NOERROR)
                continue;
            const int len = WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, nullptr, 0, nullptr, nullptr);
            std::string name;
            if (len > 0) {
                name.resize(static_cast<size_t>(len) - 1);
                WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, name.data(), len, nullptr, nullptr);
            }
            if (name == sourceName) {
                deviceId = i;
                found = true;
                break;
            }
        }
    }

    if (!found) {
        error = "Windows MIDI input device not found: " + sourceName;
        return false;
    }

    HMIDIIN handle = nullptr;
    MMRESULT res = midiInOpen(&handle, deviceId, reinterpret_cast<DWORD_PTR>(&midiInProc),
                              reinterpret_cast<DWORD_PTR>(this), CALLBACK_FUNCTION);
    if (res != MMSYSERR_NOERROR) {
        error = "Failed to open Windows MIDI input device (MMRESULT " + std::to_string(res) + ")";
        return false;
    }
    if (midiInStart(handle) != MMSYSERR_NOERROR) {
        midiInClose(handle);
        error = "Failed to start Windows MIDI input device";
        return false;
    }

    client = 0;    // unused on Windows
    inputPort = 0; // unused on Windows
    source = reinterpret_cast<MidiEndpointRef>(handle);
    return true;
}

void CoreMidiInputListener::closeSource() {
    if (source != 0) {
        HMIDIIN handle = reinterpret_cast<HMIDIIN>(source);
        midiInStop(handle);
        midiInClose(handle);
        source = 0;
    }
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

    bool haveEvent = false;
    MidiTriggerType eventType = MidiTriggerType::NoteOn;
    uint8_t number = 0;

    if (statusHigh == 0x90 && data2 > 0) {
        haveEvent = true;
        eventType = MidiTriggerType::NoteOn;
        number = data1;
    } else if (statusHigh == 0xB0) {
        haveEvent = true;
        eventType = MidiTriggerType::ControlChange;
        number = data1;
    }

    if (haveEvent) {
        if (onRawMessage)
            onRawMessage(eventType, channel + 1, number);

        std::lock_guard<std::mutex> lock(mappingsMutex);
        for (const MidiMapping& m : mappings) {
            if (m.channel != 0 && (m.channel - 1) != channel)
                continue;
            if (m.triggerType != eventType || m.number != number)
                continue;
            if (onAction)
                onAction(m.action);
        }
    }
}

} // namespace resostage

#endif // _WIN32