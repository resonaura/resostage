/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "MidiRegionAdmission.h"

#include <cmath>
#include <cstdint>
#include <limits>

namespace resostage::midi_region_admission {
namespace {

bool getExactInt(const glz::generic& object, const char* key, int& out) {
    double value = 0.0;
    if (!builder_json::getDouble(object, key, value)
        || !std::isfinite(value)
        || std::floor(value) != value
        || value < static_cast<double>(std::numeric_limits<int>::min())
        || value > static_cast<double>(std::numeric_limits<int>::max()))
        return false;
    out = static_cast<int>(value);
    return true;
}

bool isUint32(const glz::generic& value) {
    if (!value.is_number())
        return false;
    const double number = value.get_number();
    return std::isfinite(number) && number >= 0.0
        && number <= static_cast<double>(std::numeric_limits<uint32_t>::max())
        && std::floor(number) == number;
}

int expectedWordCount(uint32_t firstWord) {
    const auto messageType = firstWord >> 28;
    if (messageType <= 2 || messageType == 6 || messageType == 7)
        return 1;
    if (messageType == 3 || messageType == 4 || (messageType >= 8 && messageType <= 10))
        return 2;
    if (messageType == 11 || messageType == 12)
        return 3;
    return 4;
}

} // namespace

bool validateMidiRegionCollectionLimits(const glz::generic& document,
                                        std::string& error) {
    if (document.contains("notes") && !document["notes"].is_array()) {
        error = "MIDI region notes must be an array";
        return false;
    }
    if (document.contains("events") && !document["events"].is_array()) {
        error = "MIDI region events must be an array";
        return false;
    }
    if (document.contains("umpEvents") && !document["umpEvents"].is_array()) {
        error = "MIDI region UMP events must be an array";
        return false;
    }

    const auto* notes = builder_json::getArray(document, "notes");
    if (notes && notes->size() > kMaximumMidiRegionRows) {
        error = "MIDI region contains too many note rows";
        return false;
    }

    const auto* events = builder_json::getArray(document, "events");
    if (events && events->size() > kMaximumMidiRegionRows) {
        error = "MIDI region contains too many MIDI 1.0 event rows";
        return false;
    }
    std::size_t totalEventDataBytes = 0;
    if (events) {
        for (const auto& event : *events) {
            if (!event.is_object()) {
                error = "MIDI 1.0 event rows must be objects";
                return false;
            }
            double beat = 0.0;
            int status = 0;
            if (!builder_json::getDouble(event, "beat", beat)
                || !std::isfinite(beat) || beat < 0.0
                || !getExactInt(event, "status", status) || status < 0 || status > 255) {
                error = "MIDI 1.0 event has an invalid beat or status";
                return false;
            }
            if (!event.contains("data"))
                continue;
            const auto& dataValue = event["data"];
            if (!dataValue.is_array()) {
                error = "MIDI 1.0 event data must be an array";
                return false;
            }
            const auto& data = dataValue.get_array();
            if (data.size() > kMaximumMidiEventDataBytes) {
                error = "MIDI 1.0 event data exceeds the 65,536-byte project limit";
                return false;
            }
            if (data.size() > kMaximumMidiRegionEventDataBytes - totalEventDataBytes) {
                error = "MIDI region event data exceeds the 8 MiB project limit";
                return false;
            }
            totalEventDataBytes += data.size();
            for (const auto& byte : data) {
                if (!byte.is_number()) {
                    error = "MIDI 1.0 event data must contain numeric bytes";
                    return false;
                }
                const double value = byte.get_number();
                if (!std::isfinite(value) || value < 0.0 || value > 255.0
                    || std::floor(value) != value) {
                    error = "MIDI 1.0 event data contains an invalid byte";
                    return false;
                }
            }
        }
    }

    const auto* umpEvents = builder_json::getArray(document, "umpEvents");
    if (umpEvents && umpEvents->size() > kMaximumMidiRegionRows) {
        error = "MIDI region contains too many UMP event rows";
        return false;
    }
    std::size_t totalUmpWords = 0;
    if (umpEvents) {
        for (const auto& event : *umpEvents) {
            if (!event.is_object()) {
                error = "UMP event rows must be objects";
                return false;
            }
            double beat = 0.0;
            int wordCount = 0;
            if (!builder_json::getDouble(event, "beat", beat)
                || !std::isfinite(beat) || beat < 0.0
                || !getExactInt(event, "wordCount", wordCount)
                || wordCount < 1 || wordCount > 4
                || !event.contains("words") || !event["words"].is_array()) {
                error = "UMP event has an invalid word count or payload";
                return false;
            }
            const auto& words = event["words"].get_array();
            if (words.size() < static_cast<std::size_t>(wordCount) || words.size() > 4) {
                error = "UMP event payload does not match its word count";
                return false;
            }
            if (!isUint32(words.front())) {
                error = "UMP event contains an invalid 32-bit word";
                return false;
            }
            const auto firstWord = static_cast<uint32_t>(words.front().get_number());
            if (wordCount != expectedWordCount(firstWord)) {
                error = "UMP event word count does not match its message type";
                return false;
            }
            if (static_cast<std::size_t>(wordCount) > kMaximumMidiRegionUmpWords - totalUmpWords) {
                error = "MIDI region contains too many UMP words";
                return false;
            }
            totalUmpWords += static_cast<std::size_t>(wordCount);
            for (const auto& word : words) {
                if (!isUint32(word)) {
                    error = "UMP event contains an invalid 32-bit word";
                    return false;
                }
            }
            for (const char* key : {"configurationHeader", "profileConfigurationHeader"}) {
                if (event.contains(key) && !event[key].is_boolean()) {
                    error = "UMP event configuration flags must be boolean";
                    return false;
                }
            }
        }
    }

    return true;
}

} // namespace resostage::midi_region_admission
