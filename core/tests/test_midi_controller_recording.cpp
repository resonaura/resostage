/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"
#include "midi/MidiControllerRecording.h"

using namespace resostage::midi_controller;

TEST_CASE("MIDI recording classifies the six standard pedal controllers") {
    for (uint8_t controller = kFirstPedalController;
         controller <= kLastPedalController; ++controller)
        CHECK(isPedalController(controller));

    CHECK_FALSE(isPedalController(63));
    CHECK_FALSE(isPedalController(70));
    CHECK_FALSE(isPedalController(127));
}

TEST_CASE("MIDI recording pedal state keeps the original down edge") {
    CapturedPedalState state;

    updateCapturedPedalState(state, 1, 128, 4);
    CHECK(state.held);
    CHECK(state.startSample == 128);
    CHECK(state.startEventIndex == 4);
    CHECK(state.startValue == 1);

    updateCapturedPedalState(state, 100, 256, 5);
    CHECK(state.held);
    CHECK(state.startSample == 128);
    CHECK(state.startEventIndex == 4);
    CHECK(state.startValue == 1);

    updateCapturedPedalState(state, 0, 512, 6);
    CHECK_FALSE(state.held);

    updateCapturedPedalState(state, 127, 768, 7);
    CHECK(state.held);
    CHECK(state.startSample == 768);
    CHECK(state.startEventIndex == 7);
}
