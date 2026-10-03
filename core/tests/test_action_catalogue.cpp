/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "main/ActionCatalogue.h"
#include "midi/MidiContinuousTargets.h"
#include "midi/CoreMidiInputListener.h"

#include "doctest.h"

using namespace resostage;

TEST_CASE("MIDI action catalogue accepts rotary controls and rejects unsafe edits") {
    CHECK(isMidiMappableAction("track_pan:audio::track:1"));
    CHECK(isMidiMappableAction("bus_pan:audio::send:1"));
    CHECK(isMidiMappableAction("master_pan"));
    CHECK(isMidiMappableAction("click_pan"));
    CHECK(isMidiMappableAction("track_send:audio::track:1|audio::send:1"));
    CHECK(isMidiMappableAction("click_send:audio::send:1"));

    CHECK_FALSE(isMidiMappableAction("track_pan:"));
    CHECK_FALSE(isMidiMappableAction("track_send:|audio::send:1"));
    CHECK_FALSE(isMidiMappableAction("track_send:audio::track:1|"));
    CHECK_FALSE(isMidiMappableAction("piano_roll_transpose_octave"));
    CHECK_FALSE(isMidiMappableAction("editor_split_region"));
}

TEST_CASE("rotary MIDI target actions use continuous CC value dispatch") {
    CHECK(isContinuousMidiTarget("track_pan:audio::track:1"));
    CHECK(isContinuousMidiTarget("bus_pan:audio::send:1"));
    CHECK(isContinuousMidiTarget("master_pan"));
    CHECK(isContinuousMidiTarget("click_pan"));
    CHECK(isContinuousMidiTarget("track_send:audio::track:1|audio::send:1"));
    CHECK(isContinuousMidiTarget("click_send:audio::send:1"));
    CHECK(supportsMidiTriggerForTarget(
        "track_pan:audio::track:1", MidiTriggerType::ControlChange));
    CHECK_FALSE(supportsMidiTriggerForTarget(
        "track_pan:audio::track:1", MidiTriggerType::NoteOn));
    CHECK(supportsMidiTriggerForTarget("next", MidiTriggerType::NoteOn));
    CHECK_FALSE(isContinuousMidiTarget("next"));
    CHECK_FALSE(isContinuousMidiTarget("piano_roll_transpose_octave"));
}

TEST_CASE("rotary MIDI target resolution survives track and bus reordering") {
    Project project;
    TrackDef first;
    first.id = "audio::track:1";
    TrackDef second;
    second.id = "audio::track:2";
    project.tracks = {second, first};

    SendBus send;
    send.id = "audio::send:7";
    project.sends.push_back(send);

    CHECK(midi_control::trackIndexForTarget(project, "audio::track:1")
          == std::optional<size_t>(1));
    CHECK(midi_control::trackIndexForTarget(project, "0")
          == std::optional<size_t>(0));
    CHECK_FALSE(midi_control::trackIndexForTarget(project, "audio::track:9"));
    CHECK(midi_control::sendBusIndexForTarget(project, "audio::send:7")
          == std::optional<size_t>(1));

    const auto sendTarget = midi_control::parseTrackSendTarget(
        "audio::track:1|audio::send:7");
    REQUIRE(sendTarget.has_value());
    CHECK(sendTarget->trackId == "audio::track:1");
    CHECK(sendTarget->busId == "audio::send:7");
    CHECK_FALSE(midi_control::parseTrackSendTarget("|audio::send:7"));
    CHECK_FALSE(midi_control::parseTrackSendTarget("audio::track:1|"));
    CHECK_FALSE(midi_control::parseTrackSendTarget("audio::track:1|a|b"));
}
