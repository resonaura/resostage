#pragma once

#include <cstdint>

#if defined(__APPLE__)
#include <CoreMIDI/CoreMIDI.h>
// The macOS implementation (CoreMidiInputListener.cpp) uses these native
// opaque handles directly; other platforms use plain integer slots cast to
// their own handle type by the per-platform implementation.
using MidiClientRef = MIDIClientRef;
using MidiPortRef = MIDIPortRef;
using MidiEndpointRef = MIDIEndpointRef;
#else
using MidiClientRef = std::uintptr_t;
using MidiPortRef = std::uintptr_t;
using MidiEndpointRef = std::uintptr_t;
#endif

#include "project/ProjectSchema.h"

#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace resostage {

#ifdef _WIN32
// WinMM midiInProc callback -- declared here so the class below can friend it.
void midiInProc(void* hMidiIn, unsigned int wMsg, void* dwInstance, void* dwParam1, void* dwParam2);
#endif

// Opens a CoreMIDI input port and maps incoming Note On / Control Change
// messages to named actions via the project's MidiMapping list (footswitch/
// pad -> Play/Stop/Next/Prev/etc.). CoreMIDI delivers input on its own
// internal driver thread; `onAction` is invoked directly on that thread, so
// callers that need to touch UI/JUCE message-thread state (which is the
// normal case) must marshal it themselves (e.g. via
// juce::MessageManager::callAsync).
class CoreMidiInputListener {
public:
    CoreMidiInputListener();
    ~CoreMidiInputListener();

    CoreMidiInputListener(const CoreMidiInputListener&) = delete;
    CoreMidiInputListener& operator=(const CoreMidiInputListener&) = delete;

    std::vector<std::string> availableSourceNames() const;
    bool openSource(const std::string& sourceName, std::string& error);
    void closeSource();

    // Mapping changes are rare (project load / remap) relative to how often
    // they're read (every incoming MIDI message), so a plain mutex here is
    // the right tool -- this is CoreMIDI's own callback thread, not the
    // audio thread, so brief lock contention has no real-time consequence.
    void setMappings(std::vector<MidiMapping> newMappings);

    std::function<void(const std::string& action)> onAction;

    // Fires for every recognized Note On (velocity > 0) / Control Change
    // message, regardless of whether it currently matches a mapping -- feeds
    // "MIDI learn" UI (arm learn mode, wait for one message, fill in
    // channel/type/number). Same threading rule as onAction: called directly
    // on CoreMIDI's driver thread, callers must marshal to the message thread.
    std::function<void(MidiTriggerType type, int channel1to16, int number)> onRawMessage;

private:
#if defined(__APPLE__)
    static void readProc(const MIDIPacketList* packetList, void* readProcRefCon, void* srcConnRefCon);
    void handlePacketList(const MIDIPacketList* packetList);
#elif defined(_WIN32)
    friend void midiInProc(void* hMidiIn, unsigned int wMsg, void* dwInstance, void* dwParam1, void* dwParam2);
    void handleIncomingMessage(uint8_t status, uint8_t data1, uint8_t data2);
#endif

    MidiClientRef client = 0;
    MidiPortRef inputPort = 0;
    MidiEndpointRef source = 0;

    std::mutex mappingsMutex;
    std::vector<MidiMapping> mappings;
};

} // namespace resostage
