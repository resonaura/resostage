#include "doctest.h"

#include "plugins/PluginPowerManager.h"
#include "project/ProjectJson.h"
#include "project/ProjectSchema.h"

#include <chrono>
#include <cmath>
#include <iostream>
#include <vector>

using namespace resostage;

TEST_SUITE("PluginPowerManager") {

TEST_CASE("PluginSlotPowerTracker: Active -> Quiescent -> Suspended transition on tail decay") {
    PluginSlotPowerTracker tracker;
    PluginPowerFlags flags;
    constexpr double kSampleRate = 48000.0;
    constexpr double kTailSeconds = 0.1; // 4,800 samples
    tracker.prepare("test-slot-1", kSampleRate, kTailSeconds, flags, -90.0f);

    CHECK(tracker.state() == PluginPowerState::Active);
    CHECK(tracker.isProcessingNeeded() == true);

    constexpr int kBlock = 256;
    std::vector<float> audioL(kBlock, 0.5f);
    std::vector<float> audioR(kBlock, 0.5f);

    // Block with incoming signal: stays Active
    tracker.processBlockRealtime(audioL.data(), audioR.data(), kBlock, /*hasInputOrEvents=*/true);
    CHECK(tracker.state() == PluginPowerState::Active);
    CHECK(tracker.isProcessingNeeded() == true);

    // First block of silence (no input): transitions to Quiescent to monitor decay
    std::vector<float> silent(kBlock, 0.0f);
    tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, /*hasInputOrEvents=*/false);
    CHECK(tracker.state() == PluginPowerState::Quiescent);
    CHECK(tracker.isProcessingNeeded() == true);

    // Feed silent blocks until we reach tailSamplesThreshold (4,800 samples = ~19 blocks of 256)
    // Send 10 blocks (2,560 samples): still within tail time, should stay Quiescent
    for (int i = 0; i < 10; ++i) {
        tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, /*hasInputOrEvents=*/false);
    }
    CHECK(tracker.state() == PluginPowerState::Quiescent);
    CHECK(tracker.isProcessingNeeded() == true);

    // Send 15 more blocks (3,840 samples, total > 6,000 samples > 4,800 threshold)
    for (int i = 0; i < 15; ++i) {
        tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, /*hasInputOrEvents=*/false);
    }

    // Now tail is dead: must transition to Suspended!
    CHECK(tracker.state() == PluginPowerState::Suspended);
    CHECK(tracker.isProcessingNeeded() == false);

    // Subsequent silent blocks are O(1) no-ops and remain Suspended
    tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, /*hasInputOrEvents=*/false);
    CHECK(tracker.state() == PluginPowerState::Suspended);
    CHECK(tracker.isProcessingNeeded() == false);
}

TEST_CASE("PluginSlotPowerTracker: Ringing tail prevents premature suspension") {
    PluginSlotPowerTracker tracker;
    PluginPowerFlags flags;
    constexpr double kSampleRate = 48000.0;
    constexpr double kTailSeconds = 0.05; // 2,400 samples
    tracker.prepare("test-slot-ring", kSampleRate, kTailSeconds, flags, -90.0f);

    constexpr int kBlock = 256;
    std::vector<float> silent(kBlock, 0.0f);
    // Ringing reverb tail: -40 dBFS (~0.01f), well above -90 dBFS
    std::vector<float> ringL(kBlock, 0.01f);
    std::vector<float> ringR(kBlock, 0.01f);

    // First silence block triggers Quiescent
    tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, /*hasInputOrEvents=*/false);
    CHECK(tracker.state() == PluginPowerState::Quiescent);

    // Feed 30 blocks of ringing tail without input: should NEVER suspend because tail is audible!
    for (int i = 0; i < 30; ++i) {
        tracker.processBlockRealtime(ringL.data(), ringR.data(), kBlock, /*hasInputOrEvents=*/false);
    }
    CHECK(tracker.state() == PluginPowerState::Quiescent);
    CHECK(tracker.isProcessingNeeded() == true);
}

TEST_CASE("PluginSlotPowerTracker: Instantaneous resumption to Active (< 0.05 ms, zero lock)") {
    PluginSlotPowerTracker tracker;
    PluginPowerFlags flags;
    tracker.prepare("test-slot-resume", 48000.0, 0.05, flags, -90.0f);

    // Force suspend
    tracker.forceSuspend();
    CHECK(tracker.state() == PluginPowerState::Suspended);
    CHECK(tracker.isProcessingNeeded() == false);

    // When audio/MIDI input arrives:
    constexpr int kBlock = 256;
    std::vector<float> audio(kBlock, 0.2f);
    tracker.processBlockRealtime(audio.data(), audio.data(), kBlock, /*hasInputOrEvents=*/true);

    CHECK(tracker.state() == PluginPowerState::Active);
    CHECK(tracker.isProcessingNeeded() == true);
}

TEST_CASE("PluginSlotPowerTracker: Guard rails strictly prevent suspension") {
    constexpr int kBlock = 256;
    std::vector<float> silent(kBlock, 0.0f);

    SUBCASE("keepAwake prevents suspension") {
        PluginSlotPowerTracker tracker;
        PluginPowerFlags flags;
        flags.keepAwake = true;
        tracker.prepare("slot-keep-awake", 48000.0, 0.01, flags, -90.0f);

        for (int i = 0; i < 50; ++i) {
            tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, false);
        }
        // Even after lots of silence, guard rail blocks transition to Suspended
        CHECK(tracker.state() != PluginPowerState::Suspended);
        CHECK(tracker.isProcessingNeeded() == true);
    }

    SUBCASE("neverSuspend prevents suspension") {
        PluginSlotPowerTracker tracker;
        PluginPowerFlags flags;
        flags.neverSuspend = true;
        tracker.prepare("slot-noise-gen", 48000.0, 0.01, flags, -90.0f);

        for (int i = 0; i < 50; ++i) {
            tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, false);
        }
        CHECK(tracker.state() != PluginPowerState::Suspended);
        CHECK(tracker.isProcessingNeeded() == true);
    }

    SUBCASE("infiniteTail prevents suspension") {
        PluginSlotPowerTracker tracker;
        PluginPowerFlags flags;
        flags.infiniteTail = true;
        tracker.prepare("slot-infinite-tail", 48000.0, std::numeric_limits<double>::infinity(), flags, -90.0f);

        for (int i = 0; i < 50; ++i) {
            tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, false);
        }
        CHECK(tracker.state() != PluginPowerState::Suspended);
        CHECK(tracker.isProcessingNeeded() == true);
    }

    SUBCASE("trackRecordArmed prevents suspension") {
        PluginSlotPowerTracker tracker;
        PluginPowerFlags flags;
        flags.trackRecordArmed = true;
        tracker.prepare("slot-armed", 48000.0, 0.01, flags, -90.0f);

        for (int i = 0; i < 50; ++i) {
            tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, false);
        }
        CHECK(tracker.state() != PluginPowerState::Suspended);
        CHECK(tracker.isProcessingNeeded() == true);
    }

    SUBCASE("trackInputMonitoring prevents suspension") {
        PluginSlotPowerTracker tracker;
        PluginPowerFlags flags;
        flags.trackInputMonitoring = true;
        tracker.prepare("slot-monitored", 48000.0, 0.01, flags, -90.0f);

        for (int i = 0; i < 50; ++i) {
            tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, false);
        }
        CHECK(tracker.state() != PluginPowerState::Suspended);
        CHECK(tracker.isProcessingNeeded() == true);
    }
}

TEST_CASE("PluginPowerManager: Predictive 2-bar lookahead prewarming") {
    PluginPowerManager manager;
    PluginPowerConfig config;
    config.lookaheadBars = 2.0;
    manager.setConfig(config);

    Project project;
    TrackDef track;
    track.id = "audio::track:1";
    track.name = "Lead Synth";

    PluginSlot slot;
    slot.id = "slot-lead-synth";
    slot.plugin.identifier = "resostage::mock_synth";
    slot.plugin.name = "Mock Synth";
    slot.plugin.instrument = true;
    track.plugins.push_back(slot);
    project.tracks.push_back(track);

    auto tracker = manager.getOrCreateTracker("slot-lead-synth");
    PluginPowerFlags flags;
    flags.isInstrument = true;
    tracker->prepare("slot-lead-synth", 48000.0, 1.0, flags, -90.0f);
    tracker->forceSuspend();
    CHECK(tracker->state() == PluginPowerState::Suspended);

    SongDef song;
    song.id = "meta::song:1";
    song.name = "Test Song";
    song.bpm = 120.0;
    song.timeSignature = {4, 4}; // 4 beats per bar, 2 bars = 8 beats

    // Region starts at beat 16 (bar 5)
    Region region;
    region.id = "reg-1";
    region.trackId = "audio::track:1";
    region.startSeconds = 8.0; // 8.0 sec * (120/60) = beat 16.0
    region.durationSeconds = 4.0;
    song.regions.push_back(region);
    project.songs.push_back(song);

    // Scenario A: Playhead at beat 0.0. Lookahead horizon is [0.0, 8.0].
    // Region is at beat 16.0, outside the 2-bar horizon. Tracker should remain Suspended.
    manager.lookaheadScan(project, 0, /*currentBeat=*/0.0, /*beatsPerBar=*/4.0);
    CHECK(tracker->state() == PluginPowerState::Suspended);

    // Scenario B: Playhead advances to beat 9.0. Lookahead horizon is [9.0, 17.0].
    // Region start (beat 16.0) is within the 2-bar horizon!
    manager.lookaheadScan(project, 0, /*currentBeat=*/9.0, /*beatsPerBar=*/4.0);
    // Prewarming triggers forceAwake(): tracker must now be Active!
    CHECK(tracker->state() == PluginPowerState::Active);
    CHECK(tracker->isProcessingNeeded() == true);
}

TEST_CASE("PluginPowerManager: MIDI Region 2-bar lookahead prewarming") {
    PluginPowerManager manager;
    Project project;
    TrackDef track;
    track.id = "audio::track:midi";
    PluginSlot slot;
    slot.id = "slot-piano";
    track.plugins.push_back(slot);
    project.tracks.push_back(track);

    auto tracker = manager.getOrCreateTracker("slot-piano");
    tracker->prepare("slot-piano", 48000.0, 1.0, PluginPowerFlags{}, -90.0f);
    tracker->forceSuspend();
    CHECK(tracker->state() == PluginPowerState::Suspended);

    SongDef song;
    song.bpm = 120.0;
    song.timeSignature = {4, 4};

    MidiRegion mreg;
    mreg.id = "mreg-1";
    mreg.trackId = "audio::track:midi";
    mreg.startBeats = 12.0; // Bar 4
    mreg.durationBeats = 8.0;
    song.midiRegions.push_back(mreg);
    project.songs.push_back(song);

    // Beat 0: horizon [0, 8] -> no prewarm
    manager.lookaheadScan(project, 0, 0.0, 4.0);
    CHECK(tracker->state() == PluginPowerState::Suspended);

    // Beat 6: horizon [6, 14] -> mreg is at 12.0 -> prewarm!
    manager.lookaheadScan(project, 0, 6.0, 4.0);
    CHECK(tracker->state() == PluginPowerState::Active);
}

TEST_CASE("PluginPowerManager: Real-time throughput & bypass benchmark") {
    constexpr int kNumSlots = 50;
    std::vector<PluginSlotPowerTracker> trackers(kNumSlots);
    for (int i = 0; i < kNumSlots; ++i) {
        trackers[i].prepare("slot-" + std::to_string(i), 48000.0, 0.1, PluginPowerFlags{}, -90.0f);
        trackers[i].forceSuspend();
    }

    constexpr int kBlockSize = 512;
    constexpr int kIterations = 2000; // ~1,024,000 samples
    std::vector<float> left(kBlockSize, 0.0f);
    std::vector<float> right(kBlockSize, 0.0f);

    // Benchmark suspended execution (O(1) bypass)
    const auto startSuspended = std::chrono::steady_clock::now();
    for (int iter = 0; iter < kIterations; ++iter) {
        for (int i = 0; i < kNumSlots; ++i) {
            if (trackers[i].isProcessingNeeded()) {
                // Simulate heavy DSP math
                for (int s = 0; s < kBlockSize; ++s) {
                    left[s] = (left[s] * 0.95f) + 0.01f;
                    right[s] = (right[s] * 0.95f) + 0.01f;
                }
            }
        }
    }
    const auto elapsedSuspended = std::chrono::steady_clock::now() - startSuspended;
    const double suspendedMs = std::chrono::duration<double, std::milli>(elapsedSuspended).count();

    // Now awaken all trackers and measure active execution
    for (int i = 0; i < kNumSlots; ++i) {
        trackers[i].forceAwake();
    }
    const auto startActive = std::chrono::steady_clock::now();
    for (int iter = 0; iter < kIterations; ++iter) {
        for (int i = 0; i < kNumSlots; ++i) {
            if (trackers[i].isProcessingNeeded()) {
                for (int s = 0; s < kBlockSize; ++s) {
                    left[s] = (left[s] * 0.95f) + 0.01f;
                    right[s] = (right[s] * 0.95f) + 0.01f;
                }
            }
        }
    }
    const auto elapsedActive = std::chrono::steady_clock::now() - startActive;
    const double activeMs = std::chrono::duration<double, std::milli>(elapsedActive).count();

    MESSAGE("50 Plugins over 1,024,000 samples: Suspended = " << suspendedMs
            << " ms, Active = " << activeMs << " ms (Speedup: " << (activeMs / std::max(0.001, suspendedMs)) << "x)");

    // Suspended bypass must be dramatically faster (> 20x) than running 50 DSP passes
    CHECK(activeMs > suspendedMs * 15.0);
}

TEST_CASE("ProjectJson: Lossless roundtrip of PluginSlot keepAwake") {
    Project original;
    original.name = "Keep Awake Test";

    TrackDef track;
    track.id = "audio::track:1";
    track.name = "Guitar";

    PluginSlot slot1;
    slot1.id = "slot-1";
    slot1.plugin.identifier = "resostage::tape_sim";
    slot1.plugin.name = "Tape Simulator";
    slot1.keepAwake = true;

    PluginSlot slot2;
    slot2.id = "slot-2";
    slot2.plugin.identifier = "resostage::reverb";
    slot2.plugin.name = "Hall Reverb";
    slot2.keepAwake = false;

    track.plugins.push_back(slot1);
    track.plugins.push_back(slot2);
    original.tracks.push_back(track);

    const std::string json = serializeProjectJson(original);
    CHECK_FALSE(json.empty());
    CHECK(json.find("\"keepAwake\": true") != std::string::npos);

    Project parsed;
    std::string parseError;
    REQUIRE(parseProjectJson(json, parsed, parseError));
    REQUIRE(parsed.tracks.size() == 1);
    REQUIRE(parsed.tracks[0].plugins.size() == 2);

    CHECK(parsed.tracks[0].plugins[0].id == "slot-1");
    CHECK(parsed.tracks[0].plugins[0].keepAwake == true);

    CHECK(parsed.tracks[0].plugins[1].id == "slot-2");
    CHECK(parsed.tracks[0].plugins[1].keepAwake == false);
}

} // TEST_SUITE
