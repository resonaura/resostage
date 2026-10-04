/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "audio/graph/MixMath.h"
#include "audio/graph/MixRenderer.h"
#include "plugins/PluginDelayBank.h"
#include <array>
#include <atomic>
#include <cmath>
#include <limits>
#include <thread>
#include <vector>

using namespace resostage;

namespace {

// Mock processor for mono-in folding verification
void mockMonoFoldProcessor(void* /*context*/, float* left, float* right, int numSamples) noexcept {
    // Simulates a plugin that averages L+R to mono and puts it on both channels
    for (int i = 0; i < numSamples; ++i) {
        const float mono = 0.5f * (left[i] + right[i]);
        left[i] = mono;
        right[i] = mono;
    }
}

// Mock processor producing NaNs and Infs to test sanitization
void mockUnstableProcessor(void* /*context*/, float* left, float* right, int numSamples) noexcept {
    for (int i = 0; i < numSamples; ++i) {
        if (i % 3 == 0)
            left[i] = std::numeric_limits<float>::quiet_NaN();
        if (i % 5 == 0)
            right[i] = std::numeric_limits<float>::infinity();
    }
}

void sanitizeBuffers(float* left, float* right, int numSamples) noexcept {
    for (int i = 0; i < numSamples; ++i) {
        if (!std::isfinite(left[i])) left[i] = 0.0f;
        if (!std::isfinite(right[i])) right[i] = 0.0f;
    }
}

// Synthetic instrument synth note generator
struct MockInstrumentSynth {
    struct Note {
        int sampleOffset;
        int noteNumber;
        float velocity;
    };
    std::vector<Note> notes;

    void process(float* left, float* right, int numSamples) noexcept {
        for (const auto& n : notes) {
            if (n.sampleOffset < numSamples) {
                // Generate a burst at the note offset
                const float gain = n.velocity / 127.0f;
                left[n.sampleOffset] += gain;
                right[n.sampleOffset] += gain;
            }
        }
    }
};

void runMockInstrument(void* context, float* left, float* right,
                       int numSamples) noexcept {
    auto* synth = static_cast<MockInstrumentSynth*>(context);
    synth->process(left, right, numSamples);
}

} // namespace

TEST_SUITE("PluginHardening") {

TEST_CASE("Mono-in folding sums L+R correctly") {
    constexpr int kSamples = 64;
    std::vector<float> left(kSamples, 1.0f);
    std::vector<float> right(kSamples, 0.5f);

    mockMonoFoldProcessor(nullptr, left.data(), right.data(), kSamples);

    for (int i = 0; i < kSamples; ++i) {
        CHECK(left[static_cast<size_t>(i)] == doctest::Approx(0.75f));
        CHECK(right[static_cast<size_t>(i)] == doctest::Approx(0.75f));
    }
}

TEST_CASE("NaN and Inf sanitization flushes non-finite samples to zero") {
    constexpr int kSamples = 64;
    std::vector<float> left(kSamples, 0.5f);
    std::vector<float> right(kSamples, 0.5f);

    mockUnstableProcessor(nullptr, left.data(), right.data(), kSamples);
    sanitizeBuffers(left.data(), right.data(), kSamples);

    for (int i = 0; i < kSamples; ++i) {
        CHECK(std::isfinite(left[static_cast<size_t>(i)]));
        CHECK(std::isfinite(right[static_cast<size_t>(i)]));
        if (i % 3 == 0)
            CHECK(left[static_cast<size_t>(i)] == 0.0f);
        if (i % 5 == 0)
            CHECK(right[static_cast<size_t>(i)] == 0.0f);
    }
}

TEST_CASE("MixRenderer integrates strip processor with instrument synthesis") {
    MixGraph graph;
    MixStrip trackStrip;
    trackStrip.id = "audio::track:1";
    trackStrip.kind = StripKind::Track;
    trackStrip.channels = 2;
    trackStrip.gainLinear = 1.0f;
    trackStrip.pan = 0.0f;
    trackStrip.audible = true;
    graph.strips.push_back(trackStrip);

    MixStrip masterStrip;
    masterStrip.id = "audio::main";
    masterStrip.kind = StripKind::Main;
    masterStrip.channels = 2;
    masterStrip.gainLinear = 1.0f;
    masterStrip.pan = 0.0f;
    masterStrip.audible = true;
    graph.strips.push_back(masterStrip);

    MixEdge edge;
    edge.from = 0;
    edge.to = 1;
    edge.gainLinear = 1.0f;
    edge.active = true;
    graph.edges.push_back(edge);

    MixRenderer renderer;
    renderer.prepare(48000.0, 512, 4, 4);

    MockInstrumentSynth synth;
    synth.notes.push_back({10, 60, 127.0f}); // Note at sample 10

    MixStripProcessor stripProc;
    stripProc.context = &synth;
    stripProc.process = runMockInstrument;

    MixProcessorView procView;
    procView.strips = &stripProc;
    procView.count = 1;

    constexpr int kBlock = 128;
    renderer.beginBlock(graph, kBlock);
    // Track source starts silent (as an instrument track would)
    renderer.process(graph, kBlock, procView);

    // Verify instrument synthesized audio is heard on master strip
    const float* masterL = renderer.postChannel(1, 0);
    const float* masterR = renderer.postChannel(1, 1);
    REQUIRE(masterL != nullptr);
    REQUIRE(masterR != nullptr);

    CHECK(masterL[10] > 0.5f);
    CHECK(masterR[10] > 0.5f);
    // Samples before note 10 should be zero
    CHECK(masterL[0] == doctest::Approx(0.0f));
}

TEST_CASE("Dynamic PDC: unchanged delays retain the actual audio-owned ring") {
    MixGraph graph;
    graph.strips.resize(3);
    graph.routingLayoutKey = 17;
    graph.edges.push_back({.from = 0, .to = 2});
    graph.edges.push_back({.from = 1, .to = 2});
    std::vector<std::string> warnings;
    auto previous = PluginDelayBank::build(graph, {0, 4, 0}, 48000.0, warnings);
    MixProcessorView oldView;
    previous->applyTo(oldView);
    REQUIRE(oldView.edgeDelays[0].process != nullptr);
    std::array<float, 4> input{1.0f, 2.0f, 3.0f, 4.0f};
    std::array<float, 4> output{};
    const auto process = [](const MixProcessorView& view, const float* source,
                            float* destination, int count, bool enabled) {
        view.edgeDelays[0].process(view.edgeDelays[0].context, source, source,
                                   destination, destination, count, enabled);
    };
    process(oldView, input.data(), output.data(), 4, true);
    auto next = PluginDelayBank::build(graph, {0, 4, 0}, 48000.0, warnings, previous.get());
    MixProcessorView nextView;
    next->applyTo(nextView);
    CHECK(nextView.edgeDelays[0].context == oldView.edgeDelays[0].context);

    // Audio may run another block after the build finishes but before the new
    // publication wins. The replacement must see that exact latest history.
    std::array<float, 1> late{5.0f};
    process(oldView, late.data(), output.data(), 1, true);
    CHECK(output[0] == 1.0f);
    previous.reset();
    std::array<float, 4> silence{};
    process(nextView, silence.data(), output.data(), 4, false);
    CHECK(output == (std::array<float, 4>{2.0f, 3.0f, 4.0f, 5.0f}));
    process(nextView, silence.data(), output.data(), 4, false);
    CHECK(output == silence);
    CHECK(warnings.empty());
}

TEST_CASE("Dynamic PDC: only changed delay, endpoint, or sample rate resets history") {
    MixGraph graph;
    graph.strips.resize(3);
    graph.routingLayoutKey = 17;
    graph.edges.push_back({.from = 0, .to = 2});
    graph.edges.push_back({.from = 1, .to = 2});
    std::vector<std::string> warnings;
    auto previous = PluginDelayBank::build(graph, {0, 4, 0}, 48000.0, warnings);
    MixProcessorView oldView;
    previous->applyTo(oldView);
    std::array<float, 4> input{1.0f, 2.0f, 3.0f, 4.0f};
    std::array<float, 4> output{};
    oldView.edgeDelays[0].process(oldView.edgeDelays[0].context, input.data(), input.data(),
                                 output.data(), output.data(), 4, true);
    struct Scenario {
        uint32_t delay;
        uint64_t routingKey;
        double sampleRate;
        bool changeEndpoint;
        bool expectSharedHistory;
    };
    for (const auto scenario : {
             Scenario{2, 17, 48000.0, false, false},
             Scenario{6, 17, 48000.0, false, false},
             Scenario{4, 18, 48000.0, false, true},
             Scenario{4, 18, 48000.0, true, false},
             Scenario{4, 17, 96000.0, false, false}}) {
        graph.routingLayoutKey = scenario.routingKey;
        graph.edges[0].sendIndex = scenario.changeEndpoint ? 2 : MixEdge::kNoSend;
        const auto delay = scenario.delay;
        auto next = PluginDelayBank::build(graph, {0, delay, 0}, scenario.sampleRate,
                                           warnings, previous.get());
        MixProcessorView view;
        next->applyTo(view);
        REQUIRE(view.edgeDelays[0].process != nullptr);
        CHECK((view.edgeDelays[0].context == oldView.edgeDelays[0].context)
              == scenario.expectSharedHistory);
        std::array<float, 6> silence{};
        std::array<float, 6> fresh{};
        fresh.fill(1.0f);
        view.edgeDelays[0].process(view.edgeDelays[0].context, silence.data(), silence.data(),
                                  fresh.data(), fresh.data(), static_cast<int>(delay), false);
        if (scenario.expectSharedHistory) {
            for (uint32_t sample = 0; sample < delay; ++sample)
                CHECK(fresh[sample] == static_cast<float>(sample + 1));
        } else {
            for (uint32_t sample = 0; sample < delay; ++sample)
                CHECK(fresh[sample] == 0.0f);
        }
    }
}

TEST_CASE("Dynamic PDC prepares slot-aware sidechain delay lines") {
    MixGraph graph;
    graph.strips.resize(2);
    graph.strips[0].id = "audio::track:source";
    graph.strips[1].id = "audio::track:destination";
    graph.sidechainEdges.push_back({
        .from = 0, .to = 1, .pluginSlotIndex = 1,
        .inputBusIndex = 1,
        .channelMode = SidechainChannelMode::Automatic,
        .active = true,
        .pluginSlotId = "compressor"});
    const std::vector<std::vector<uint32_t>> slotLatency{{}, {5, 0}};
    std::vector<std::string> warnings;
    auto bank = PluginDelayBank::build(
        graph, {2, 5}, 48000.0, warnings, nullptr, slotLatency, 8);
    REQUIRE(bank != nullptr);
    CHECK(warnings.empty());

    MixProcessorView view;
    bank->applyTo(view);
    REQUIRE(view.sidechainEdgeDelayCount == 1);
    REQUIRE(view.sidechainEdgeDelays[0].process != nullptr);
    std::array<float, 8> input{1.0f, 2.0f, 3.0f, 4.0f,
                               5.0f, 6.0f, 7.0f, 8.0f};
    const float* outputLeft = nullptr;
    const float* outputRight = nullptr;
    view.sidechainEdgeDelays[0].process(
        view.sidechainEdgeDelays[0].context, input.data(), input.data(),
        static_cast<int>(input.size()), true, &outputLeft, &outputRight);
    REQUIRE(outputLeft != nullptr);
    REQUIRE(outputRight != nullptr);
    CHECK(outputLeft[0] == doctest::Approx(0.0f));
    CHECK(outputLeft[1] == doctest::Approx(0.0f));
    CHECK(outputLeft[2] == doctest::Approx(0.0f));
    CHECK(outputLeft[3] == doctest::Approx(1.0f));
    CHECK(outputLeft[4] == doctest::Approx(2.0f));
    CHECK(outputRight[4] == doctest::Approx(2.0f));

    // An unrelated graph-layout change must retain the ring for this same
    // sidechain endpoint, insert identity, bus and unchanged delay length.
    graph.routingLayoutKey = 9;
    auto next = PluginDelayBank::build(
        graph, {2, 5}, 48000.0, warnings, bank.get(), slotLatency, 8);
    MixProcessorView nextView;
    next->applyTo(nextView);
    CHECK(nextView.sidechainEdgeDelays[0].context
          == view.sidechainEdgeDelays[0].context);
}

TEST_CASE("Dynamic PDC reports late sources that cannot align to instrument audio") {
    MixGraph graph;
    graph.strips.resize(2);
    graph.strips[0].id = "audio::track:source";
    graph.strips[1].id = "audio::track:instrument";
    graph.strips[1].isInstrumentTrack = true;
    graph.sidechainEdges.push_back({
        .from = 0, .to = 1, .pluginSlotIndex = 1,
        .inputBusIndex = 1,
        .channelMode = SidechainChannelMode::Automatic,
        .active = true,
        .pluginSlotId = "compressor"});

    std::vector<std::string> warnings;
    auto bank = PluginDelayBank::build(
        graph, {8, 4}, 48000.0, warnings, nullptr, {{}, {4, 0}}, 8);
    REQUIRE(bank != nullptr);
    REQUIRE(warnings.size() == 1);
    CHECK(warnings[0].find("generated instrument audio") != std::string::npos);
    MixProcessorView view;
    bank->applyTo(view);
    REQUIRE(view.sidechainEdgeDelayCount == 1);
    CHECK(view.sidechainEdgeDelays[0].process == nullptr);
}

TEST_CASE("Dynamic PDC: builder never reads samples concurrently written by audio") {
    MixGraph graph;
    graph.strips.resize(3);
    graph.routingLayoutKey = 17;
    graph.edges.push_back({.from = 0, .to = 2});
    graph.edges.push_back({.from = 1, .to = 2});
    std::vector<std::string> warnings;
    auto previous = PluginDelayBank::build(graph, {0, 256, 0}, 48000.0, warnings);
    MixProcessorView view;
    previous->applyTo(view);
    std::atomic<bool> started{false};
    std::atomic<bool> stopped{false};
    std::thread audio([&] {
        std::array<float, 64> input{};
        std::array<float, 64> output{};
        started.store(true, std::memory_order_release);
        while (!stopped.load(std::memory_order_acquire))
            view.edgeDelays[0].process(view.edgeDelays[0].context, input.data(), input.data(),
                                      output.data(), output.data(), 64, true);
    });
    while (!started.load(std::memory_order_acquire))
        std::this_thread::yield();
    for (unsigned iteration = 0; iteration < 500; ++iteration) {
        const uint32_t delay = iteration % 2 == 0 ? 256 : 128;
        auto next = PluginDelayBank::build(graph, {0, delay, 0}, 48000.0, warnings, previous.get());
        MixProcessorView candidate;
        next->applyTo(candidate);
        CHECK((candidate.edgeDelays[0].context == view.edgeDelays[0].context) == (delay == 256));
    }
    stopped.store(true, std::memory_order_release);
    audio.join();
    CHECK(warnings.empty());
}

} // TEST_SUITE
