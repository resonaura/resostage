// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#pragma once

#include "project/ProjectSchema.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>

namespace resostage {

// The current JUCE plug-in and external MIDI lanes accept MIDI 1.0 messages.
// Keep this conversion identical in live and offline rendering. The original
// high-resolution values and UMP packets remain in the project for MIDI 2.0
// file export and for a future negotiated UMP device/plug-in lane.
struct Midi1CompatibleMessage {
    uint8_t status = 0;
    uint8_t data1 = 0;
    uint8_t data2 = 0;
    uint8_t dataLength = 0;
};

[[nodiscard]] inline uint8_t midi1NoteVelocity(const MidiNote& note, bool noteOn) noexcept {
    if (note.midi2) {
        // M2-115: downscale 16-bit velocity to 7 bits by discarding the nine
        // least significant bits. MIDI 1.0 Note On velocity zero means Off.
        const auto value = static_cast<uint8_t>((noteOn
            ? note.midi2->velocity : note.midi2->releaseVelocity) >> 9);
        return noteOn ? std::max<uint8_t>(1, value) : value;
    }
    const float normalized = noteOn ? note.velocity : note.releaseVelocity;
    const int value = std::isfinite(normalized)
        ? static_cast<int>(std::lround(std::clamp(normalized, 0.0f, 1.0f) * 127.0f)) : 0;
    return static_cast<uint8_t>(noteOn ? std::max(1, value) : value);
}

/** Translate only MIDI 1.0-equivalent UMP channel controls. No allocation. */
[[nodiscard]] inline std::optional<Midi1CompatibleMessage>
umpToMidi1ChannelControl(const MidiUmpEvent& event) noexcept {
    if (event.wordCount < 1 || event.wordCount > 2)
        return std::nullopt;
    const uint32_t first = event.words[0];
    const uint8_t type = static_cast<uint8_t>(first >> 28);
    const uint8_t kind = static_cast<uint8_t>((first >> 20) & 0x0f);
    if ((type == 2 && event.wordCount != 1)
        || (type == 4 && event.wordCount != 2)
        || (type != 2 && type != 4))
        return std::nullopt;
    // Note messages are represented as editable MidiNote objects. Other MIDI
    // 2.0 messages, including per-note controls and banked Program Change,
    // cannot be represented by one legacy channel message and stay opaque.
    if (kind != 0x0a && kind != 0x0b && kind != 0x0d && kind != 0x0e
        && !(type == 2 && kind == 0x0c))
        return std::nullopt;

    Midi1CompatibleMessage result;
    result.status = static_cast<uint8_t>(
        (static_cast<uint32_t>(kind) << 4) | ((first >> 16) & 0x0f));
    result.data1 = static_cast<uint8_t>((first >> 8) & 0x7f);
    result.data2 = static_cast<uint8_t>(first & 0x7f);
    result.dataLength = (kind == 0x0c || kind == 0x0d) ? 1 : 2;
    if (type == 2)
        return result;

    // M2-104 reserves these CC numbers for compound MIDI 1.0 RPN/NRPN,
    // Bank Select, and high-resolution velocity. MIDI 2.0 receivers ignore
    // them; manufacturing legacy CC side effects would change the music.
    if (kind == 0x0b && (result.data1 == 0 || result.data1 == 6
        || result.data1 == 32 || result.data1 == 38 || result.data1 == 88
        || (result.data1 >= 98 && result.data1 <= 101)))
        return std::nullopt;

    const uint32_t value = event.words[1];
    if (kind == 0x0e) {
        const uint16_t scaled = static_cast<uint16_t>(value >> 18);
        result.data1 = static_cast<uint8_t>(scaled & 0x7f);
        result.data2 = static_cast<uint8_t>((scaled >> 7) & 0x7f);
    } else {
        const uint8_t scaled = static_cast<uint8_t>(value >> 25);
        if (kind == 0x0d)
            result.data1 = scaled;
        else
            result.data2 = scaled;
    }
    return result;
}

} // namespace resostage
