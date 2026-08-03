#include "CoreMidiInputListener.h"

#include <CoreFoundation/CoreFoundation.h>

namespace resostage {

namespace {
std::string cfStringToStd(CFStringRef ref) {
    if (ref == nullptr)
        return {};
    const CFIndex length = CFStringGetLength(ref);
    const CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
    std::vector<char> buffer(static_cast<size_t>(maxSize));
    if (CFStringGetCString(ref, buffer.data(), maxSize, kCFStringEncodingUTF8))
        return std::string(buffer.data());
    return {};
}
} // namespace

CoreMidiInputListener::CoreMidiInputListener() {
    MIDIClientCreate(CFSTR("ResoStage MIDI Input"), nullptr, nullptr, &client);
    if (client != 0)
        MIDIInputPortCreate(client, CFSTR("ResoStage Input"), &readProc, this, &inputPort);
}

CoreMidiInputListener::~CoreMidiInputListener() {
    closeSource();
    if (inputPort != 0)
        MIDIPortDispose(inputPort);
    if (client != 0)
        MIDIClientDispose(client);
}

std::vector<std::string> CoreMidiInputListener::availableSourceNames() const {
    std::vector<std::string> names;
    const ItemCount count = MIDIGetNumberOfSources();
    names.reserve(count);
    for (ItemCount i = 0; i < count; ++i) {
        MIDIEndpointRef src = MIDIGetSource(i);
        CFStringRef nameRef = nullptr;
        MIDIObjectGetStringProperty(src, kMIDIPropertyName, &nameRef);
        names.push_back(cfStringToStd(nameRef));
        if (nameRef != nullptr)
            CFRelease(nameRef);
    }
    return names;
}

bool CoreMidiInputListener::openSource(const std::string& sourceName, std::string& error) {
    closeSource();

    const ItemCount count = MIDIGetNumberOfSources();
    if (count == 0) {
        error = "No CoreMIDI sources available";
        return false;
    }

    MIDIEndpointRef chosen = 0;
    if (sourceName.empty()) {
        chosen = MIDIGetSource(0);
    } else {
        for (ItemCount i = 0; i < count; ++i) {
            MIDIEndpointRef src = MIDIGetSource(i);
            CFStringRef nameRef = nullptr;
            MIDIObjectGetStringProperty(src, kMIDIPropertyName, &nameRef);
            const std::string name = cfStringToStd(nameRef);
            if (nameRef != nullptr)
                CFRelease(nameRef);
            if (name == sourceName) {
                chosen = src;
                break;
            }
        }
    }

    if (chosen == 0) {
        error = "CoreMIDI source not found: " + sourceName;
        return false;
    }

    if (MIDIPortConnectSource(inputPort, chosen, nullptr) != noErr) {
        error = "Failed to connect to CoreMIDI source: " + sourceName;
        return false;
    }

    source = chosen;
    return true;
}

void CoreMidiInputListener::closeSource() {
    if (source != 0 && inputPort != 0)
        MIDIPortDisconnectSource(inputPort, source);
    source = 0;
}

void CoreMidiInputListener::setMappings(std::vector<MidiMapping> newMappings) {
    std::lock_guard<std::mutex> lock(mappingsMutex);
    mappings = std::move(newMappings);
}

void CoreMidiInputListener::readProc(const MIDIPacketList* packetList, void* readProcRefCon, void* /*srcConnRefCon*/) {
    auto* self = static_cast<CoreMidiInputListener*>(readProcRefCon);
    if (self != nullptr)
        self->handlePacketList(packetList);
}

void CoreMidiInputListener::handlePacketList(const MIDIPacketList* packetList) {
    const MIDIPacket* packet = &packetList->packet[0];
    for (UInt32 i = 0; i < packetList->numPackets; ++i) {
        const uint8_t status = packet->length >= 1 ? packet->data[0] : 0;
        const uint8_t statusHigh = static_cast<uint8_t>(status & 0xF0);
        const uint8_t channel = static_cast<uint8_t>(status & 0x0F);

        // Note On with velocity 0 is, by MIDI convention, a de-facto Note
        // Off (used for running-status efficiency by many controllers). A
        // footswitch/pad sending press+release would otherwise fire the
        // mapped action twice per press if velocity were ignored, so a real
        // Note On requires 3 bytes and velocity > 0.
        bool haveEvent = false;
        MidiTriggerType eventType = MidiTriggerType::NoteOn;
        uint8_t number = 0;

        if (statusHigh == 0x90 && packet->length >= 3) {
            const uint8_t note = packet->data[1];
            const uint8_t velocity = packet->data[2];
            if (velocity > 0) {
                haveEvent = true;
                eventType = MidiTriggerType::NoteOn;
                number = note;
            }
        } else if (statusHigh == 0xB0 && packet->length >= 3) {
            haveEvent = true;
            eventType = MidiTriggerType::ControlChange;
            number = packet->data[1];
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
        packet = MIDIPacketNext(packet);
    }
}

} // namespace resostage
