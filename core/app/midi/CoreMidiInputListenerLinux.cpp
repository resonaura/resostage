#include "CoreMidiInputListener.h"

#if defined(__linux__)

#include <alsa/asoundlib.h>
#include <string>
#include <vector>

namespace resostage {

CoreMidiInputListener::CoreMidiInputListener() = default;

CoreMidiInputListener::~CoreMidiInputListener() {
    closeSource();
}

std::vector<std::string> CoreMidiInputListener::availableSourceNames() const {
    std::vector<std::string> names;
    snd_seq_t* seq = nullptr;
    if (snd_seq_open(&seq, "default", SND_SEQ_OPEN_INPUT, 0) < 0) {
        return names;
    }

    snd_seq_client_info_t* cinfo;
    snd_seq_port_info_t* pinfo;
    snd_seq_client_info_alloca(&cinfo);
    snd_seq_port_info_alloca(&pinfo);

    snd_seq_client_info_set_client(cinfo, -1);
    while (snd_seq_query_next_client(seq, cinfo) >= 0) {
        int client = snd_seq_client_info_get_client(cinfo);
        snd_seq_port_info_set_client(pinfo, client);
        snd_seq_port_info_set_port(pinfo, -1);
        while (snd_seq_query_next_port(seq, pinfo) >= 0) {
            unsigned int caps = snd_seq_port_info_get_capability(pinfo);
            if ((caps & (SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ)) ==
                (SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ)) {
                names.push_back(std::string(snd_seq_client_info_get_name(cinfo)) + ": " + snd_seq_port_info_get_name(pinfo));
            }
        }
    }
    snd_seq_close(seq);
    return names;
}

bool CoreMidiInputListener::openSource(const std::string& sourceName, std::string& error) {
    (void)sourceName;
    closeSource();
    snd_seq_t* seq = nullptr;
    if (snd_seq_open(&seq, "default", SND_SEQ_OPEN_INPUT, 0) < 0) {
        error = "Failed to open ALSA sequencer input";
        return false;
    }
    client = reinterpret_cast<MidiClientRef>(seq);
    source = 1;
    return true;
}

void CoreMidiInputListener::closeSource() {
    if (client != 0) {
        auto* seq = reinterpret_cast<snd_seq_t*>(client);
        snd_seq_close(seq);
        client = 0;
        source = 0;
    }
}

void CoreMidiInputListener::setMappings(std::vector<MidiMapping> newMappings) {
    std::lock_guard<std::mutex> lock(mappingsMutex);
    mappings = std::move(newMappings);
}

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

#endif // __linux__
