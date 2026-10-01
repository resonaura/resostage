// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#include "CoreMidiInputListener.h"

#if defined(__linux__)

#include <alsa/asoundlib.h>
#include <algorithm>
#include <chrono>
#include <thread>
#include <string>
#include <vector>

namespace resostage {

namespace {

std::string portLabel(snd_seq_t* seq, int clientId, int portId, bool includeAddress) {
    snd_seq_client_info_t* clientInfo;
    snd_seq_port_info_t* portInfo;
    snd_seq_client_info_alloca(&clientInfo);
    snd_seq_port_info_alloca(&portInfo);
    snd_seq_get_any_client_info(seq, clientId, clientInfo);
    snd_seq_get_any_port_info(seq, clientId, portId, portInfo);
    std::string label = std::string(snd_seq_client_info_get_name(clientInfo)) + ": "
        + snd_seq_port_info_get_name(portInfo);
    if (includeAddress)
        label += " [" + std::to_string(clientId) + ":" + std::to_string(portId) + "]";
    return label;
}

bool hasSourceCapability(snd_seq_t* seq, int clientId, int portId) {
    snd_seq_port_info_t* portInfo;
    snd_seq_port_info_alloca(&portInfo);
    if (snd_seq_get_any_port_info(seq, clientId, portId, portInfo) < 0)
        return false;
    const unsigned int caps = snd_seq_port_info_get_capability(portInfo);
    return (caps & (SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ))
        == (SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ);
}

} // namespace

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
    snd_seq_t* seq = nullptr;
    if (snd_seq_open(&seq, "default", SND_SEQ_OPEN_INPUT, 0) < 0) {
        return names;
    }
    names.push_back("All Inputs");

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
                names.push_back(portLabel(seq, client, snd_seq_port_info_get_port(pinfo), true));
            }
        }
    }
    snd_seq_close(seq);
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

    snd_seq_t* seq = nullptr;
    if (snd_seq_open(&seq, "default", SND_SEQ_OPEN_INPUT | SND_SEQ_NONBLOCK, 0) < 0) {
        error = "Failed to open ALSA sequencer input";
        return false;
    }
    snd_seq_set_client_name(seq, "ResoStage MIDI Input");
    const int localPort = snd_seq_create_simple_port(seq, "Input",
        SND_SEQ_PORT_CAP_WRITE | SND_SEQ_PORT_CAP_SUBS_WRITE,
        SND_SEQ_PORT_TYPE_APPLICATION | SND_SEQ_PORT_TYPE_MIDI_GENERIC);
    if (localPort < 0) {
        snd_seq_close(seq);
        error = "Failed to create ALSA MIDI input port";
        return false;
    }

    std::vector<std::pair<int, int>> sources;
    snd_seq_client_info_t* cinfo;
    snd_seq_port_info_t* pinfo;
    snd_seq_client_info_alloca(&cinfo);
    snd_seq_port_info_alloca(&pinfo);
    snd_seq_client_info_set_client(cinfo, -1);
    while (snd_seq_query_next_client(seq, cinfo) >= 0) {
        const int clientId = snd_seq_client_info_get_client(cinfo);
        snd_seq_port_info_set_client(pinfo, clientId);
        snd_seq_port_info_set_port(pinfo, -1);
        while (snd_seq_query_next_port(seq, pinfo) >= 0) {
            const int portId = snd_seq_port_info_get_port(pinfo);
            if (!hasSourceCapability(seq, clientId, portId))
                continue;
            const std::string label = portLabel(seq, clientId, portId, false);
            const std::string qualified = portLabel(seq, clientId, portId, true);
            if (!allInputs
                && std::find(currentSourceNames.begin(), currentSourceNames.end(), qualified)
                    == currentSourceNames.end()
                && std::find(currentSourceNames.begin(), currentSourceNames.end(), label)
                    == currentSourceNames.end())
                continue;
            sources.emplace_back(clientId, portId);
        }
    }

    for (const auto& [clientId, portId] : sources)
        (void)snd_seq_connect_from(seq, localPort, clientId, portId);

    if (sources.empty()) {
        snd_seq_close(seq);
        error = allInputs ? "No ALSA MIDI input sources are available"
                          : "No selected ALSA MIDI input source was found";
        return false;
    }

    client = reinterpret_cast<MidiClientRef>(seq);
    inputPort = static_cast<MidiPortRef>(localPort);
    source = 1;
    sourceThreadRunning.store(true, std::memory_order_release);
    sourceThread = std::thread([this, seq] {
        while (sourceThreadRunning.load(std::memory_order_acquire)) {
            snd_seq_event_t* event = nullptr;
            const int result = snd_seq_event_input(seq, &event);
            if (result >= 0 && event != nullptr) {
                const int channel = event->data.note.channel & 0x0f;
                switch (event->type) {
                    case SND_SEQ_EVENT_NOTEON:
                        handleIncomingMessage(static_cast<uint8_t>(0x90 | channel),
                            static_cast<uint8_t>(event->data.note.note), static_cast<uint8_t>(event->data.note.velocity));
                        break;
                    case SND_SEQ_EVENT_NOTEOFF:
                        handleIncomingMessage(static_cast<uint8_t>(0x80 | channel),
                            static_cast<uint8_t>(event->data.note.note), static_cast<uint8_t>(event->data.note.velocity));
                        break;
                    case SND_SEQ_EVENT_CONTROLLER:
                        handleIncomingMessage(static_cast<uint8_t>(0xb0 | channel),
                            static_cast<uint8_t>(event->data.control.param), static_cast<uint8_t>(event->data.control.value));
                        break;
                    case SND_SEQ_EVENT_PGMCHANGE:
                        handleIncomingMessage(static_cast<uint8_t>(0xc0 | channel),
                            static_cast<uint8_t>(event->data.control.value), 0);
                        break;
                    case SND_SEQ_EVENT_PITCHBEND: {
                        const int bend = std::clamp(event->data.control.value + 8192, 0, 16383);
                        handleIncomingMessage(static_cast<uint8_t>(0xe0 | channel),
                            static_cast<uint8_t>(bend & 0x7f), static_cast<uint8_t>((bend >> 7) & 0x7f));
                        break;
                    }
                    case SND_SEQ_EVENT_CHANPRESS:
                        handleIncomingMessage(static_cast<uint8_t>(0xd0 | channel),
                            static_cast<uint8_t>(event->data.control.value), 0);
                        break;
                    default:
                        break;
                }
                snd_seq_free_event(event);
                continue;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    });
    return true;
}

void CoreMidiInputListener::closeSource() {
    std::lock_guard<std::mutex> lock(sourceMutex);
    closeSourceInternal();
}

void CoreMidiInputListener::closeSourceInternal() {
    sourceThreadRunning.store(false, std::memory_order_release);
    if (sourceThread.joinable())
        sourceThread.join();
    if (client != 0) {
        auto* seq = reinterpret_cast<snd_seq_t*>(client);
        snd_seq_close(seq);
        client = 0;
        inputPort = 0;
        source = 0;
    }
    currentSourceNames.clear();
}

void CoreMidiInputListener::setMappings(std::vector<MidiMapping> newMappings) {
    std::lock_guard<std::mutex> lock(mappingsMutex);
    mappings = std::move(newMappings);
}

void CoreMidiInputListener::handleIncomingMessage(uint8_t status, uint8_t data1, uint8_t data2) {
    const uint8_t statusHigh = static_cast<uint8_t>(status & 0xF0);
    const uint8_t channel = static_cast<uint8_t>(status & 0x0F);

    const int length = (statusHigh == 0xc0 || statusHigh == 0xd0) ? 2 : 3;
    const uint8_t message[3] = {status, data1, data2};
    if (onMidiMessageReceived)
        onMidiMessageReceived(message, length);

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
        if (onRawMessage) {
            const int value = data2;
            onRawMessage(eventType, channel + 1, number, value);
        }

        std::lock_guard<std::mutex> lock(mappingsMutex);
        for (const MidiMapping& m : mappings) {
            if (m.channel != 0 && (m.channel - 1) != channel)
                continue;
            if (m.triggerType != eventType || m.number != number)
                continue;
            if (eventType == MidiTriggerType::ControlChange
                && (m.action.rfind("track_gain:", 0) == 0
                    || m.action.rfind("track_pan:", 0) == 0
                    || m.action == "master_gain"
                    || m.action.rfind("send_level:", 0) == 0
                    || m.action.rfind("plugin_param:", 0) == 0)) {
                if (onContinuousAction)
                    onContinuousAction(m.action, static_cast<float>(data2) / 127.0f);
            } else if (onAction) {
                onAction(m.action);
            }
        }
    }
}

} // namespace resostage

#endif // __linux__
