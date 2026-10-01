/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>

namespace resostage {

/**
 * One chain's DSP-owned MIDI voice intent. Silent attacks and modulation can
 * outlast a vendor's declared tail, so held/sustained notes prevent automatic
 * instrument suspension. No allocation, locks, or cross-thread readers.
 * Counts saturate conservatively; channel panic/reset clears stuck ownership.
 */
class PluginMidiActivity final {
public:
    void consume(const uint8_t* data, int bytes) noexcept {
        if (data == nullptr || bytes <= 0)
            return;
        if (data[0] == 0xff) {
            reset();
            return;
        }
        if (bytes < 3 || data[1] >= 128 || data[2] >= 128)
            return;
        const auto channel = static_cast<size_t>(data[0] & 0x0f);
        const auto pitch = static_cast<size_t>(data[1]);
        auto& count = held[channel][pitch];
        switch (data[0] & 0xf0) {
            case 0x90:
                if (data[2] != 0) {
                    if (count != std::numeric_limits<uint16_t>::max()) {
                        ++count;
                        ++heldCount;
                    }
                    break;
                }
                [[fallthrough]];
            case 0x80:
                // Saturated overlap has unknown true depth. Keep it awake
                // until channel panic/reset rather than losing held ownership.
                if (count != 0 && count != std::numeric_limits<uint16_t>::max()) {
                    --count;
                    --heldCount;
                    if (count == 0 && pedal[channel] && !sustained[channel][pitch]) {
                        sustained[channel][pitch] = true;
                        ++sustainedCount;
                    }
                }
                break;
            case 0xb0:
                if (data[1] == 64) {
                    pedal[channel] = data[2] >= 64;
                    if (!pedal[channel])
                        releaseSustain(channel);
                } else if (data[1] == 120) {
                    releaseHeld(channel, false);
                    releaseSustain(channel);
                } else if (data[1] == 123) {
                    // All Notes Off follows normal note-off semantics; the
                    // sustain pedal may keep the released voices sounding.
                    releaseHeld(channel, pedal[channel]);
                } else if (data[1] == 121) {
                    // Reset controllers releases sustain, not physically held keys.
                    pedal[channel] = false;
                    releaseSustain(channel);
                }
                break;
            default: break;
        }
    }

    [[nodiscard]] bool hasActiveNotes() const noexcept {
        return heldCount != 0 || sustainedCount != 0;
    }

    void reset() noexcept {
        held = {};
        sustained = {};
        pedal = {};
        heldCount = sustainedCount = 0;
    }

private:
    void releaseSustain(size_t channel) noexcept {
        for (auto& note : sustained[channel]) {
            if (note) {
                note = false;
                --sustainedCount;
            }
        }
    }

    void releaseHeld(size_t channel, bool sustainReleased) noexcept {
        for (size_t pitch = 0; pitch < 128; ++pitch) {
            auto& count = held[channel][pitch];
            if (count == 0)
                continue;
            heldCount -= count;
            count = 0;
            if (sustainReleased && !sustained[channel][pitch]) {
                sustained[channel][pitch] = true;
                ++sustainedCount;
            }
        }
    }

    std::array<std::array<uint16_t, 128>, 16> held{};
    std::array<std::array<bool, 128>, 16> sustained{};
    std::array<bool, 16> pedal{};
    uint32_t heldCount = 0;
    uint32_t sustainedCount = 0;
};

} // namespace resostage
