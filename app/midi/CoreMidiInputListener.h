#pragma once

#include <CoreMIDI/CoreMIDI.h>

#include "project/ProjectSchema.h"

#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace resoset {

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
    static void readProc(const MIDIPacketList* packetList, void* readProcRefCon, void* srcConnRefCon);
    void handlePacketList(const MIDIPacketList* packetList);

    MIDIClientRef client = 0;
    MIDIPortRef inputPort = 0;
    MIDIEndpointRef source = 0;

    std::mutex mappingsMutex;
    std::vector<MidiMapping> mappings;
};

} // namespace resoset
