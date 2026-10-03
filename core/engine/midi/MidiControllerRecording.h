/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <cstdint>

namespace resostage::midi_controller {

inline constexpr uint8_t kFirstPedalController = 64;
inline constexpr uint8_t kLastPedalController = 69;
inline constexpr uint8_t kMidiChannelCount = 16;
inline constexpr uint8_t kPedalControllerCount =
    kLastPedalController - kFirstPedalController + 1;

struct CapturedPedalState {
    int64_t startSample = 0;
    uint32_t startEventIndex = 0;
    uint8_t startValue = 0;
    bool held = false;
};

[[nodiscard]] inline constexpr bool isPedalController(uint8_t controller) noexcept {
    return controller >= kFirstPedalController && controller <= kLastPedalController;
}

/**
 * Update the compact live-held state for a captured switch pedal. A non-zero
 * event starts a held span; repeated non-zero values retain its original start.
 * Zero releases it. The exact event remains in the MIDI clip independently.
 */
inline void updateCapturedPedalState(
    CapturedPedalState& state,
    uint8_t value,
    int64_t sample,
    uint32_t eventIndex) noexcept {
    if (value == 0) {
        state.held = false;
        return;
    }
    if (state.held)
        return;
    state.startSample = sample;
    state.startEventIndex = eventIndex;
    state.startValue = value;
    state.held = true;
}

} // namespace resostage::midi_controller
