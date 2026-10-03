/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

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
using MIDIClientRef = std::uintptr_t;
using MIDIPortRef = std::uintptr_t;
using MIDIEndpointRef = std::uintptr_t;
using MidiClientRef = MIDIClientRef;
using MidiPortRef = MIDIPortRef;
using MidiEndpointRef = MIDIEndpointRef;
#endif

#include "project/ProjectSchema.h"

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace resostage {

// Keep controller-value dispatch consistent across CoreMIDI, WinMM and ALSA.
// These actions consume normalized CC values; all other learned actions are
// intentionally treated as discrete note/foot-switch commands.
inline bool isContinuousMidiTarget(const std::string& action) noexcept {
    return action.rfind("track_gain:", 0) == 0
        || action.rfind("track_pan:", 0) == 0
        || action.rfind("bus_pan:", 0) == 0
        || action == "master_gain"
        || action == "master_pan"
        || action == "click_pan"
        || action.rfind("send_level:", 0) == 0
        || action.rfind("plugin_param:", 0) == 0
        || action.rfind("track_send:", 0) == 0
        || action.rfind("click_send:", 0) == 0;
}

inline bool supportsMidiTriggerForTarget(
    const std::string& action, MidiTriggerType trigger) noexcept {
    return !isContinuousMidiTarget(action)
        || trigger == MidiTriggerType::ControlChange;
}

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
    bool openSources(const std::vector<std::string>& sourceNames, std::string& error);
    void closeSource();

    // Mapping changes are rare (project load / remap) relative to how often
    // they're read (every incoming MIDI message), so a plain mutex here is
    // the right tool -- this is CoreMIDI's own callback thread, not the
    // audio thread, so brief lock contention has no real-time consequence.
    void setMappings(std::vector<MidiMapping> newMappings);

    std::string currentSource() const;
    std::function<void(const std::string& action)> onAction;
    std::function<void(const std::string& target, float normalizedValue)> onContinuousAction;
    std::function<void(const uint8_t* data, int length)> onMidiMessageReceived;

    // Fires for every recognized Note On (velocity > 0) / Control Change
    // message, regardless of whether it currently matches a mapping -- feeds
    // "MIDI learn" UI (arm learn mode, wait for one message, fill in
    // channel/type/number). Same threading rule as onAction: called directly
    // on CoreMIDI's driver thread, callers must marshal to the message thread.
    std::function<void(MidiTriggerType type, int channel1to16, int number, int value)> onRawMessage;

    // Fired when MIDI devices are hotplugged / removed or ports change
    std::function<void()> onSourcesChanged;

private:
    void closeSourceInternal();

#if defined(__APPLE__)
    static void readProc(const MIDIPacketList* packetList, void* readProcRefCon, void* srcConnRefCon);
    static void notifyProc(const MIDINotification* message, void* refCon);
    void handlePacketList(const MIDIPacketList* packetList);
    std::vector<MidiEndpointRef> connectedSources;
#elif defined(_WIN32)
    friend void midiInProc(void* hMidiIn, unsigned int wMsg, void* dwInstance, void* dwParam1, void* dwParam2);
    void handleIncomingMessage(uint8_t status, uint8_t data1, uint8_t data2);
#else
    void handleIncomingMessage(uint8_t status, uint8_t data1, uint8_t data2);
#endif

    MidiClientRef client = 0;
    MidiPortRef inputPort = 0;
    MidiEndpointRef source = 0;
    std::vector<MidiEndpointRef> inputSources;
    std::vector<std::string> currentSourceNames;
    mutable std::mutex sourceMutex;
    std::thread sourceThread;
    std::atomic<bool> sourceThreadRunning{false};

    std::mutex mappingsMutex;
    std::vector<MidiMapping> mappings;
};

using CoreMIDIInputListener = CoreMidiInputListener;

} // namespace resostage
