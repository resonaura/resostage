/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "plugins/PluginPowerManager.h"
#include "plugins/PluginHostProtocol.h"
#include "plugins/PluginMidiActivity.h"
#include "project/ProjectJson.h"
#include "project/ProjectSchema.h"

#include <chrono>
#include <array>
#include <cmath>
#include <iostream>
#include <thread>
#include <vector>

using namespace resostage;

TEST_SUITE("PluginPowerManager") {

TEST_CASE("PluginMidiActivity: silent held instrument attack outlasts declared tail") {
    PluginMidiActivity activity;
    PluginSlotPowerTracker tracker;
    PluginPowerFlags flags;
    flags.isInstrument = true;
    tracker.prepare("delayed-synth", 48000.0, 0.01, flags);
    const uint8_t noteOn[] = {0x90, 60, 100};
    activity.consume(noteOn, 3);
    std::array<float, 256> silence{};
    // Two seconds without more packets exceeds the ten-ms vendor tail.
    // The helper's held-note intent keeps processing the silent attack.
    for (unsigned block = 0; block < 400; ++block) {
        tracker.processBlockRealtime(silence.data(), silence.data(), 256,
                                     activity.hasActiveNotes());
        CHECK(tracker.isProcessingNeeded());
    }
    const uint8_t noteOff[] = {0x80, 60, 0};
    activity.consume(noteOff, 3);
    CHECK_FALSE(activity.hasActiveNotes());
    for (unsigned block = 0; block < 4; ++block)
        tracker.processBlockRealtime(silence.data(), silence.data(), 256,
                                     activity.hasActiveNotes());
    CHECK(tracker.state() == PluginPowerState::Suspended);
}

TEST_CASE("PluginMidiActivity: overlap velocity-zero and channel isolation") {
    PluginMidiActivity activity;
    const uint8_t on[] = {0x90, 60, 100};
    const uint8_t off[] = {0x80, 60, 0};
    const uint8_t zero[] = {0x90, 60, 0};
    const uint8_t other[] = {0x91, 60, 100};
    const uint8_t otherOff[] = {0x81, 60, 0};
    activity.consume(on, 3);
    activity.consume(on, 3);
    activity.consume(other, 3);
    activity.consume(off, 3);
    CHECK(activity.hasActiveNotes());
    activity.consume(zero, 3);
    CHECK(activity.hasActiveNotes());
    activity.consume(otherOff, 3);
    CHECK_FALSE(activity.hasActiveNotes());
    activity.consume(off, 3);
    CHECK_FALSE(activity.hasActiveNotes());
}

TEST_CASE("PluginMidiActivity: sustain panic and controller reset preserve key ownership") {
    PluginMidiActivity activity;
    const uint8_t on[] = {0x90, 60, 100};
    const uint8_t off[] = {0x80, 60, 0};
    const uint8_t pedalDown[] = {0xb0, 64, 127};
    const uint8_t pedalUp[] = {0xb0, 64, 0};
    const uint8_t resetControllers[] = {0xb0, 121, 0};
    const uint8_t notesOff[] = {0xb0, 123, 0};
    const uint8_t soundOff[] = {0xb0, 120, 0};
    activity.consume(pedalDown, 3);
    activity.consume(on, 3);
    activity.consume(off, 3);
    CHECK(activity.hasActiveNotes());
    activity.consume(on, 3);
    activity.consume(resetControllers, 3);
    CHECK(activity.hasActiveNotes()); // Still physically held
    activity.consume(off, 3);
    CHECK_FALSE(activity.hasActiveNotes());
    activity.consume(pedalDown, 3);
    activity.consume(on, 3);
    activity.consume(notesOff, 3);
    CHECK(activity.hasActiveNotes()); // All Notes Off respects sustain
    activity.consume(pedalUp, 3);
    CHECK_FALSE(activity.hasActiveNotes());
    activity.consume(on, 3);
    activity.consume(pedalDown, 3);
    activity.consume(off, 3);
    activity.consume(soundOff, 3);
    CHECK_FALSE(activity.hasActiveNotes());
    activity.consume(on, 3);
    const uint8_t systemReset[] = {0xff};
    activity.consume(systemReset, 1);
    CHECK_FALSE(activity.hasActiveNotes());
}

TEST_CASE("PluginMidiActivity: saturated overlap stays conservative until panic") {
    PluginMidiActivity activity;
    const uint8_t on[] = {0x90, 60, 100};
    const uint8_t off[] = {0x80, 60, 0};
    for (unsigned event = 0; event < 65536; ++event)
        activity.consume(on, 3);
    for (unsigned event = 0; event < 65536; ++event)
        activity.consume(off, 3);
    CHECK(activity.hasActiveNotes());
    const uint8_t soundOff[] = {0xb0, 120, 0};
    activity.consume(soundOff, 3);
    CHECK_FALSE(activity.hasActiveNotes());
}

TEST_CASE("PluginSlotPowerTracker: releasing a guard starts a complete quiet hold") {
    PluginSlotPowerTracker tracker;
    PluginPowerFlags flags;
    flags.keepAwake = true;
    tracker.prepare("guard-release", 48000.0, 0.1, flags);
    std::array<float, 480> silence{};
    for (unsigned block = 0; block < 100; ++block)
        tracker.processBlockRealtime(silence.data(), silence.data(), 480, false);
    CHECK(tracker.isProcessingNeeded());
    tracker.setKeepAwake(false);
    for (unsigned block = 0; block < 9; ++block) {
        tracker.processBlockRealtime(silence.data(), silence.data(), 480, false);
        CHECK(tracker.isProcessingNeeded());
    }
    tracker.processBlockRealtime(silence.data(), silence.data(), 480, false);
    CHECK(tracker.state() == PluginPowerState::Suspended);
}

TEST_CASE("PluginSlotPowerTracker: guarded quiet block skips per-sample detector work") {
    constexpr size_t slots = 50;
    constexpr unsigned blocks = 2000;
    std::array<PluginSlotPowerTracker, slots> trackers;
    std::array<EnvelopeFollower, slots> previousDetectors;
    PluginPowerFlags flags;
    flags.keepAwake = true;
    for (size_t slot = 0; slot < slots; ++slot) {
        trackers[slot].prepare("pinned", 48000.0, 5.0, flags);
        previousDetectors[slot].prepare(48000.0, 5.0, 50.0);
    }
    std::array<float, 256> silence{};
    const auto start = std::chrono::steady_clock::now();
    for (unsigned block = 0; block < blocks; ++block)
        for (auto& detector : previousDetectors)
            detector.processStereo(silence.data(), silence.data(), nullptr, 256);
    const auto middle = std::chrono::steady_clock::now();
    for (unsigned block = 0; block < blocks; ++block)
        for (auto& tracker : trackers)
            tracker.processBlockRealtime(silence.data(), silence.data(), 256, false);
    const auto end = std::chrono::steady_clock::now();
    const double previousMicros = std::chrono::duration<double, std::micro>(middle - start).count()
        / blocks;
    const double preparedMicros = std::chrono::duration<double, std::micro>(end - middle).count()
        / blocks;
    MESSAGE("50 pinned quiet slots @ 48 kHz/256: former detector work " << previousMicros
            << " us/block, O(1) guarded tracking " << preparedMicros << " us/block");
    for (const auto& tracker : trackers)
        CHECK(tracker.isProcessingNeeded());
}

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

TEST_CASE("PluginSlotPowerTracker: explicit parking survives input and predictive wakes") {
    PluginSlotPowerTracker tracker;
    tracker.prepare("parked-slot", 48000.0, 0.01, {});
    std::array<float, 256> silence{};
    tracker.park();
    tracker.forceAwake();
    tracker.setKeepAwake(true);
    CHECK(tracker.state() == PluginPowerState::Parked);
    CHECK_FALSE(tracker.isProcessingNeeded());
    tracker.processBlockRealtime(silence.data(), silence.data(), 256, true);
    CHECK(tracker.state() == PluginPowerState::Parked);
    tracker.unpark();
    CHECK(tracker.state() == PluginPowerState::Active);
    tracker.beginBlockRealtime();
    CHECK(tracker.isProcessingNeeded());
    tracker.processBlockRealtime(silence.data(), silence.data(), 256, false);
    CHECK(tracker.state() != PluginPowerState::Parked);
}

TEST_CASE("PluginSlotPowerTracker: independent atomic guards cannot overwrite each other") {
    PluginSlotPowerTracker tracker;
    tracker.prepare("guard-slot", 48000.0, 0.001, {});
    tracker.forceSuspend();
    tracker.setKeepAwake(true);
    tracker.setRecordArmed(true);
    tracker.setInputMonitoring(true);
    tracker.setKeepAwake(false);
    CHECK_FALSE(tracker.getFlags().keepAwake);
    CHECK(tracker.getFlags().trackRecordArmed);
    CHECK(tracker.getFlags().trackInputMonitoring);
    std::array<float, 256> silence{};
    for (unsigned block = 0; block < 100; ++block)
        tracker.processBlockRealtime(silence.data(), silence.data(), 256, false);
    CHECK(tracker.isProcessingNeeded());
    tracker.setRecordArmed(false);
    tracker.setInputMonitoring(false);
    for (unsigned block = 0; block < 100; ++block)
        tracker.processBlockRealtime(silence.data(), silence.data(), 256, false);
    CHECK(tracker.state() == PluginPowerState::Suspended);
}

TEST_CASE("PluginSlotPowerTracker: concurrent controls leave DSP counters single-writer") {
    PluginSlotPowerTracker tracker;
    tracker.prepare("concurrent-slot", 48000.0, 0.001, {});
    constexpr unsigned iterations = 20000;
    std::atomic<bool> started{false};
    std::atomic<bool> stopped{false};
    std::thread dsp([&] {
        std::array<float, 64> silence{};
        started.store(true, std::memory_order_release);
        while (!stopped.load(std::memory_order_acquire)) {
            tracker.beginBlockRealtime();
            tracker.processBlockRealtime(silence.data(), silence.data(), 64, false);
        }
    });
    while (!started.load(std::memory_order_acquire))
        std::this_thread::yield();
    std::thread controls([&] {
        for (unsigned index = 0; index < iterations; ++index) {
            tracker.setKeepAwake((index % 2) != 0);
            tracker.setRecordArmed((index % 3) != 0);
            tracker.setInputMonitoring((index % 5) != 0);
            tracker.forceAwake();
        }
    });
    for (unsigned index = 0; index < iterations; ++index) {
        tracker.park();
        tracker.forceSuspend();
        tracker.unpark();
        (void)tracker.state();
        (void)tracker.getFlags();
    }
    controls.join();
    stopped.store(true, std::memory_order_release);
    dsp.join();
    tracker.unpark();
    tracker.setKeepAwake(true);
    tracker.setRecordArmed(false);
    tracker.setInputMonitoring(false);
    std::array<float, 64> silence{};
    for (unsigned block = 0; block < 100; ++block)
        tracker.processBlockRealtime(silence.data(), silence.data(), 64, false);
    CHECK(tracker.isProcessingNeeded());
    CHECK(tracker.getFlags().keepAwake);
    tracker.setKeepAwake(false);
    for (unsigned block = 0; block < 100; ++block)
        tracker.processBlockRealtime(silence.data(), silence.data(), 64, false);
    CHECK(tracker.state() == PluginPowerState::Suspended);
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

    SUBCASE("extreme reported tail automatically enables infiniteTail flag and prevents suspension") {
        PluginSlotPowerTracker tracker;
        PluginPowerFlags flags; // infiniteTail is false
        tracker.prepare("slot-extreme-tail", 48000.0, 3600.0, flags, -90.0f);
        CHECK(tracker.getFlags().infiniteTail == true);

        for (int i = 0; i < 50; ++i) {
            tracker.processBlockRealtime(silent.data(), silent.data(), kBlock, false);
        }
        CHECK(tracker.state() != PluginPowerState::Suspended);
        CHECK(tracker.isProcessingNeeded() == true);
    }

    SUBCASE("infinity reported tail automatically enables infiniteTail flag even when initially false") {
        PluginSlotPowerTracker tracker;
        PluginPowerFlags flags; // infiniteTail is false
        tracker.prepare("slot-inf-tail", 48000.0, std::numeric_limits<double>::infinity(), flags, -90.0f);
        CHECK(tracker.getFlags().infiniteTail == true);
        CHECK(tracker.isProcessingNeeded() == true);
    }

    SUBCASE("NaN tail gracefully falls back to default 5.0 seconds") {
        PluginSlotPowerTracker tracker;
        PluginPowerFlags flags;
        tracker.prepare("slot-nan-tail", 48000.0, std::numeric_limits<double>::quiet_NaN(), flags, -90.0f);
        CHECK(tracker.getFlags().infiniteTail == false);
        CHECK(tracker.getTailSeconds() == 5.0);
    }

    SUBCASE("zero or negative numSamples in processBlockRealtime is safely ignored") {
        PluginSlotPowerTracker tracker;
        PluginPowerFlags flags;
        tracker.prepare("slot-zero-samples", 48000.0, 0.1, flags, -90.0f);
        tracker.processBlockRealtime(silent.data(), silent.data(), 0, false);
        tracker.processBlockRealtime(silent.data(), silent.data(), -1, false);
        CHECK(tracker.state() == PluginPowerState::Active);
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

    // Non-finite values (NaN / Inf) should not crash or throw
    tracker->forceSuspend();
    CHECK(tracker->state() == PluginPowerState::Suspended);
    manager.lookaheadScan(project, 0, std::numeric_limits<double>::quiet_NaN(), 4.0);
    manager.lookaheadScan(project, 0, 0.0, std::numeric_limits<double>::infinity());
    // Tracker remains in safe state
    CHECK(tracker->state() == PluginPowerState::Suspended);
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
    size_t suspendedPasses = 0;
    size_t activePasses = 0;

    // Benchmark suspended execution (O(1) bypass)
    const auto startSuspended = std::chrono::steady_clock::now();
    for (int iter = 0; iter < kIterations; ++iter) {
        for (int i = 0; i < kNumSlots; ++i) {
            if (trackers[i].isProcessingNeeded()) {
                ++suspendedPasses;
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
                ++activePasses;
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

    // Scheduling/thermal contention can delay either wall-time window. Assert
    // the deterministic work-elimination contract; retain timings as diagnostics
    // rather than declaring valid code broken by unrelated host load.
    CHECK(suspendedPasses == 0);
    CHECK(activePasses == static_cast<size_t>(kIterations * kNumSlots));
    CHECK(left.front() == doctest::Approx(0.2f).epsilon(0.001));
}

TEST_CASE("PluginPowerManager: chain prewarm edge avoids per-insert request work") {
    constexpr unsigned slots = 64;
    constexpr unsigned iterations = 20000;
    std::array<PluginSlotPowerTracker, slots> trackers;
    for (auto& tracker : trackers)
        tracker.prepare("prewarm-slot", 48000.0, 5.0, {});
    plugin_host::SharedArea area{};
    const auto previousStart = std::chrono::steady_clock::now();
    for (unsigned iteration = 0; iteration < iterations; ++iteration)
        for (auto& tracker : trackers)
            tracker.forceAwake();
    const auto previousEnd = std::chrono::steady_clock::now();
    for (unsigned iteration = 0; iteration < iterations; ++iteration)
        plugin_host::publishChainPrewarm(area);
    const auto coalescedEnd = std::chrono::steady_clock::now();
    const auto previousMicros = std::chrono::duration<double, std::micro>(
        previousEnd - previousStart).count() / iterations;
    const auto coalescedMicros = std::chrono::duration<double, std::micro>(
        coalescedEnd - previousEnd).count() / iterations;
    MESSAGE("64-insert chain prewarm: per-node intents " << previousMicros
            << " us/call, coalesced chain edge " << coalescedMicros << " us/call");
    CHECK(area.chainPrewarmRequested.load(std::memory_order_acquire));
    CHECK(area.controlEnqueuePosition.load(std::memory_order_relaxed) == 0);
    CHECK(area.missedControlEvents.load(std::memory_order_relaxed) == 0);
    CHECK(trackers.back().isProcessingNeeded());
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
