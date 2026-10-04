/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "audio/dsp/AutomationEnvelope.h"
#include "audio/dsp/EnvelopeFollower.h"
#include "audio/graph/MixGraph.h"
#include "audio/graph/MixRenderer.h"

#if defined(RESOSTAGE_TEST_PLUGIN_HOST)
#include "plugins/PluginMIDIBuffer.h"
#endif

#include "plugins/PluginDelayBank.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <new>
#include <vector>

using namespace resostage;

namespace {

thread_local bool sAudioRenderAllocProbeActive = false;
thread_local uint64_t sAudioRenderAllocProbeCount = 0;

} // namespace

#if !defined(_MSC_VER)
void* operator new(std::size_t size) {
    if (sAudioRenderAllocProbeActive) {
        ++sAudioRenderAllocProbeCount;
    }
    void* ptr = std::malloc(size);
    if (!ptr) throw std::bad_alloc();
    return ptr;
}

void operator delete(void* ptr) noexcept {
    std::free(ptr);
}

void operator delete(void* ptr, std::size_t) noexcept {
    std::free(ptr);
}

void* operator new[](std::size_t size) {
    if (sAudioRenderAllocProbeActive) {
        ++sAudioRenderAllocProbeCount;
    }
    void* ptr = std::malloc(size);
    if (!ptr) throw std::bad_alloc();
    return ptr;
}

void operator delete[](void* ptr) noexcept {
    std::free(ptr);
}

void operator delete[](void* ptr, std::size_t) noexcept {
    std::free(ptr);
}

void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
    if (sAudioRenderAllocProbeActive) {
        ++sAudioRenderAllocProbeCount;
    }
    return std::malloc(size);
}

void operator delete(void* ptr, const std::nothrow_t&) noexcept {
    std::free(ptr);
}

void* operator new[](std::size_t size, const std::nothrow_t&) noexcept {
    if (sAudioRenderAllocProbeActive) {
        ++sAudioRenderAllocProbeCount;
    }
    return std::malloc(size);
}

void operator delete[](void* ptr, const std::nothrow_t&) noexcept {
    std::free(ptr);
}
#endif

namespace {

void benchInsertProcessor(void* /*context*/, float* left, float* right,
                          int numSamples) noexcept {
    // Typical light insert processing: 2-band biquad / gain math
    for (int i = 0; i < numSamples; ++i) {
        left[i] = (left[i] * 0.95f) + 0.01f;
        right[i] = (right[i] * 0.95f) + 0.01f;
    }
}

} // namespace

TEST_SUITE("PluginPerformance") {

#if defined(RESOSTAGE_TEST_PLUGIN_HOST)
TEST_CASE("plug-in MIDI packet preparation measures empty sparse and dense blocks") {
    using namespace resostage::plugin_host;
    // Retain the previous preparation algorithm only in this comparison. It
    // models the 512-entry clear and owning JUCE iterator from processChain;
    // the production path now reuses storage and traverses raw event views.
    const auto previousCopy = [](const juce::MidiBuffer& source,
                                 std::array<MidiEvent, kMaximumMidiEventsPerBlock>& output) {
        output.fill(MidiEvent{});
        uint32_t count = 0;
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#endif
        juce::MidiBuffer::Iterator iterator(source);
#if defined(__clang__)
#pragma clang diagnostic pop
#endif
        juce::MidiMessage message;
        int samplePosition = 0;
        while (count < output.size() && iterator.getNextEvent(message, samplePosition)) {
            const int bytes = message.getRawDataSize();
            if (bytes <= 0 || bytes > static_cast<int>(kMaximumMidiEventBytes)
                || samplePosition < 0 || samplePosition >= 512)
                continue;
            auto& event = output[count++];
            event.sampleOffset = static_cast<uint32_t>(samplePosition);
            event.size = static_cast<uint8_t>(bytes);
            std::copy_n(message.getRawData(), bytes, event.data);
        }
        return count;
    };
    std::array<MidiEvent, kMaximumMidiEventsPerBlock> previousOutput{};
    std::array<MidiEvent, kMaximumMidiEventsPerBlock> preparedOutput{};
    for (const uint32_t eventCount : {0u, 4u, 512u}) {
        PluginMIDIBuffer source;
        for (uint32_t index = 0; index < eventCount; ++index)
            REQUIRE(source.add(juce::MidiMessage::noteOn(1, 60,
                               static_cast<uint8_t>(100)), static_cast<int>(index)));
        constexpr unsigned trials = 20000;
        uint64_t previousCount = 0;
        uint64_t preparedCount = 0;
        const auto previousStart = std::chrono::steady_clock::now();
        for (unsigned trial = 0; trial < trials; ++trial) {
            previousCount += previousCopy(source.buffer(), previousOutput);
            // Escape prepared packets so a compiler cannot remove the old
            // full-array initialization when the test fixture is empty.
#if defined(__GNUC__) || defined(__clang__)
            asm volatile("" : : "g"(previousOutput.data()) : "memory");
#endif
        }
        const auto previousEnd = std::chrono::steady_clock::now();
        for (unsigned trial = 0; trial < trials; ++trial) {
            preparedCount += copyPluginMIDIEventsToHost(
                source.buffer(), preparedOutput.data(),
                static_cast<uint32_t>(preparedOutput.size()), 512).copied;
#if defined(__GNUC__) || defined(__clang__)
            asm volatile("" : : "g"(preparedOutput.data()) : "memory");
#endif
        }
        const auto preparedEnd = std::chrono::steady_clock::now();
        CHECK(previousCount == preparedCount);
        CHECK(preparedCount == static_cast<uint64_t>(trials) * eventCount);
        const double previousMicros = std::chrono::duration<double, std::micro>(
            previousEnd - previousStart).count() / trials;
        const double preparedMicros = std::chrono::duration<double, std::micro>(
            preparedEnd - previousEnd).count() / trials;
        MESSAGE(eventCount << " MIDI events: previous preparation " << previousMicros
                << " us/block, prepared raw views " << preparedMicros << " us/block");
    }
}
#endif

TEST_CASE("AutomationEnvelope evaluateBlock throughput benchmark") {
    AutomationEnvelope env;
    // Set up a complex automation curve with 100 points
    for (int i = 0; i < 100; ++i) {
        const double t = i * 0.1;
        const double v = (i % 2 == 0) ? 0.2 : 0.8;
        const double curve = (i % 3 == 0) ? 0.5 : -0.5;
        env.addPoint(t, v, curve);
    }

    constexpr int kBlockSize = 512;
    constexpr int kIterations = 2000; // 1,024,000 samples
    std::vector<float> buffer(kBlockSize, 0.0f);
    size_t cursor = 0;

    const auto start = std::chrono::steady_clock::now();
    for (int iter = 0; iter < kIterations; ++iter) {
        const double t = (iter * kBlockSize) / 48000.0;
        env.evaluateBlock(t, 48000.0, buffer.data(), kBlockSize, cursor);
    }
    const auto elapsed = std::chrono::steady_clock::now() - start;
    const double elapsedMs = std::chrono::duration<double, std::milli>(elapsed).count();

    const double totalSamples = static_cast<double>(kIterations * kBlockSize);
    const double megaSamplesPerSec = (totalSamples / 1.0e6) / (elapsedMs / 1000.0);

    MESSAGE("AutomationEnvelope throughput: " << megaSamplesPerSec << " MSamples/sec ("
            << elapsedMs << " ms for " << totalSamples << " samples)");

    // Should easily exceed 50 MegaSamples/sec on Apple Silicon / modern CPU
    CHECK(megaSamplesPerSec > 20.0);
}

TEST_CASE("EnvelopeFollower process throughput benchmark") {
    EnvelopeFollower follower(48000.0, 5.0, 50.0);

    constexpr int kBlockSize = 512;
    constexpr int kIterations = 2000; // 1,024,000 samples
    std::vector<float> input(kBlockSize, 0.7f);
    std::vector<float> output(kBlockSize, 0.0f);

    const auto start = std::chrono::steady_clock::now();
    for (int iter = 0; iter < kIterations; ++iter) {
        follower.process(input.data(), output.data(), kBlockSize);
    }
    const auto elapsed = std::chrono::steady_clock::now() - start;
    const double elapsedMs = std::chrono::duration<double, std::milli>(elapsed).count();

    const double totalSamples = static_cast<double>(kIterations * kBlockSize);
    const double megaSamplesPerSec = (totalSamples / 1.0e6) / (elapsedMs / 1000.0);

    MESSAGE("EnvelopeFollower throughput: " << megaSamplesPerSec << " MSamples/sec ("
            << elapsedMs << " ms for " << totalSamples << " samples)");

    CHECK(megaSamplesPerSec > 50.0);
}

TEST_CASE("MixRenderer process timing across block sizes") {
    // Build a typical live-show graph: 8 audio tracks, 2 aux sends, 1 master bus
    MixGraph graph;
    for (int t = 1; t <= 8; ++t) {
        MixStrip track;
        track.id = "audio::track:" + std::to_string(t);
        track.kind = StripKind::Track;
        track.channels = 2;
        track.gainLinear = 1.0f;
        track.audible = true;
        graph.strips.push_back(track);
    }
    for (int s = 1; s <= 2; ++s) {
        MixStrip send;
        send.id = "audio::send:" + std::to_string(s);
        send.kind = StripKind::Send;
        send.channels = 2;
        send.gainLinear = 1.0f;
        send.audible = true;
        graph.strips.push_back(send);
    }
    MixStrip master;
    master.id = "audio::main";
    master.kind = StripKind::Main;
    master.channels = 2;
    master.gainLinear = 1.0f;
    master.audible = true;

    graph.strips.push_back(master);

    // Wire tracks to master and sends
    for (uint32_t t = 0; t < 8; ++t) {
        MixEdge toMain;
        toMain.from = t;
        toMain.to = 10; // Master
        toMain.gainLinear = 1.0f;
        toMain.active = true;
        graph.edges.push_back(toMain);

        MixEdge toSend1;
        toSend1.from = t;
        toSend1.to = 8; // Send 1
        toSend1.gainLinear = 0.5f;
        toSend1.active = true;
        graph.edges.push_back(toSend1);
    }

    // Sends wire to master
    for (uint32_t s = 8; s <= 9; ++s) {
        MixEdge toMain;
        toMain.from = s;
        toMain.to = 10;
        toMain.gainLinear = 1.0f;
        toMain.active = true;
        graph.edges.push_back(toMain);
    }

    MixRenderer renderer;
    renderer.prepare(48000.0, 1024, 16, 32);

    // Benchmarking block sizes: 64, 128, 256, 512, 1024
    const int blockSizes[] = {64, 128, 256, 512, 1024};

    for (int blockSize : blockSizes) {
        constexpr int kTrials = 1000;
        renderer.beginBlock(graph, blockSize);

        const auto start = std::chrono::steady_clock::now();
        for (int i = 0; i < kTrials; ++i) {
            renderer.process(graph, blockSize);
        }
        const auto elapsed = std::chrono::steady_clock::now() - start;
        const double totalUs = std::chrono::duration<double, std::micro>(elapsed).count();
        const double avgUsPerBlock = totalUs / kTrials;

        const double audioDeadlineUs = (static_cast<double>(blockSize) / 48000.0) * 1.0e6;
        const double cpuPercent = (avgUsPerBlock / audioDeadlineUs) * 100.0;

        MESSAGE("Block " << blockSize << " frames: " << avgUsPerBlock << " µs per block ("
                << cpuPercent << "% of " << audioDeadlineUs << " µs deadline)");

        // Audio sweep must complete in a tiny fraction of hardware deadline (< 5% CPU budget)
        CHECK(cpuPercent < 5.0);
    }
}

TEST_CASE("MixRenderer with 8 insert plug-in chains performance") {
    MixGraph graph;
    for (int t = 1; t <= 8; ++t) {
        MixStrip track;
        track.id = "audio::track:" + std::to_string(t);
        track.kind = StripKind::Track;
        track.channels = 2;
        track.gainLinear = 1.0f;
        track.audible = true;
        graph.strips.push_back(track);
    }
    MixStrip master;
    master.id = "audio::main";
    master.kind = StripKind::Main;
    master.channels = 2;
    master.gainLinear = 1.0f;
    master.audible = true;

    graph.strips.push_back(master);

    for (uint32_t t = 0; t < 8; ++t) {
        MixEdge toMain;
        toMain.from = t;
        toMain.to = 8;
        toMain.gainLinear = 1.0f;
        toMain.active = true;
        graph.edges.push_back(toMain);
    }

    MixRenderer renderer;
    renderer.prepare(48000.0, 512, 16, 16);

    std::vector<MixStripProcessor> stripProcessors(8);
    for (int i = 0; i < 8; ++i) {
        stripProcessors[static_cast<size_t>(i)].context = nullptr;
        stripProcessors[static_cast<size_t>(i)].process = benchInsertProcessor;
    }

    MixProcessorView procView;
    procView.strips = stripProcessors.data();
    procView.count = stripProcessors.size();

    constexpr int kBlock = 256;
    constexpr int kTrials = 1000;
    renderer.beginBlock(graph, kBlock);

    const auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < kTrials; ++i) {
        renderer.process(graph, kBlock, procView);
    }
    const auto elapsed = std::chrono::steady_clock::now() - start;
    const double avgUsPerBlock = std::chrono::duration<double, std::micro>(elapsed).count() / kTrials;
    const double deadlineUs = (256.0 / 48000.0) * 1.0e6; // 5333.3 µs
    const double cpuPercent = (avgUsPerBlock / deadlineUs) * 100.0;

    MESSAGE("8 active plug-in inserts @ 256 frames: " << avgUsPerBlock << " µs per block ("
            << cpuPercent << "% of audio deadline)");

    CHECK(avgUsPerBlock < 200.0); // Far below 5333 µs deadline
    CHECK(cpuPercent < 4.0);
}

TEST_CASE("MixRenderer allocator probe: zero heap allocation during block render with PDC and strip processing") {
    MixGraph graph;
    constexpr uint32_t kTracks = 16;
    constexpr uint32_t kSends = 4;
    graph.strips.resize(kTracks + kSends + 1); // 16 tracks, 4 sends, 1 master
    for (uint32_t t = 0; t < kTracks; ++t) {
        auto& strip = graph.strips[t];
        strip.id = "track:" + std::to_string(t);
        strip.kind = StripKind::Track;
        strip.channels = 2;
        strip.gainLinear = 1.0f;
        strip.audible = true;

        MixEdge toMaster;
        toMaster.from = t;
        toMaster.to = static_cast<uint32_t>(graph.strips.size() - 1);
        toMaster.gainLinear = 0.8f;
        toMaster.active = true;
        graph.edges.push_back(toMaster);

        for (uint32_t s = 0; s < kSends; ++s) {
            MixEdge toSend;
            toSend.from = t;
            toSend.to = kTracks + s;
            toSend.gainLinear = 0.3f;
            toSend.active = true;
            graph.edges.push_back(toSend);
        }
    }

    for (uint32_t s = 0; s < kSends; ++s) {
        auto& strip = graph.strips[kTracks + s];
        strip.id = "send:" + std::to_string(s);
        strip.kind = StripKind::Send;
        strip.channels = 2;
        strip.gainLinear = 1.0f;
        strip.audible = true;

        MixEdge toMaster;
        toMaster.from = kTracks + s;
        toMaster.to = static_cast<uint32_t>(graph.strips.size() - 1);
        toMaster.gainLinear = 1.0f;
        toMaster.active = true;
        graph.edges.push_back(toMaster);
    }

    auto& master = graph.strips.back();
    master.id = "main";
    master.kind = StripKind::Main;
    master.channels = 2;
    master.gainLinear = 1.0f;
    master.audible = true;

    // Exercise the renderer's bounded per-destination sidechain view assembly
    // under the allocator probe below, in addition to the ordinary send edges.
    for (uint32_t source = 0; source < kMaximumSidechainFeedsPerStrip; ++source) {
        graph.sidechainEdges.push_back({
            source, 8, source, 1, SidechainChannelMode::Automatic, true});
    }
    std::stable_sort(graph.edges.begin(), graph.edges.end(),
                     [](const MixEdge& left, const MixEdge& right) {
                         return left.to < right.to;
                     });

    // Set up strip processors
    std::vector<MixStripProcessor> stripProcessors(graph.strips.size());
    for (auto& proc : stripProcessors) {
        proc.context = nullptr;
        proc.process = benchInsertProcessor;
    }

    // Set up PDC delays on odd tracks
    std::vector<uint32_t> stripLatencies(graph.strips.size(), 0);
    for (size_t t = 0; t < kTracks; t += 2) {
        stripLatencies[t] = 64;
    }
    std::vector<std::string> warnings;
    auto delayBank = PluginDelayBank::build(graph, stripLatencies, 48000.0, warnings);
    REQUIRE(delayBank != nullptr);

    MixProcessorView procView;
    procView.strips = stripProcessors.data();
    procView.count = stripProcessors.size();
    delayBank->applyTo(procView);

    MixRenderer renderer;
    renderer.prepare(48000.0, 512, graph.strips.size(),
                     std::max(graph.edges.size(), graph.sidechainEdges.size()));

#if !defined(_MSC_VER)
    // Verify probe is sensitive to heap allocations:
    sAudioRenderAllocProbeCount = 0;
    sAudioRenderAllocProbeActive = true;
    void* testAlloc = ::operator new(64);
    sAudioRenderAllocProbeActive = false;
    ::operator delete(testAlloc);
    CHECK(sAudioRenderAllocProbeCount > 0);
#endif

    // Warm up one block to stabilize smoothers
    renderer.beginBlock(graph, 256);
    renderer.process(graph, 256, procView);

    // Now test zero allocations over 1000 audio blocks:
    sAudioRenderAllocProbeCount = 0;
    sAudioRenderAllocProbeActive = true;
    for (int block = 0; block < 1000; ++block) {
        renderer.beginBlock(graph, 256);
        renderer.process(graph, 256, procView);
    }
    sAudioRenderAllocProbeActive = false;

    CHECK(sAudioRenderAllocProbeCount == 0);
}

TEST_CASE("MixRenderer latency percentiles (p50/p95/p99/max) and PDC alignment across 64, 128, 256, 512 frames") {
    const int blockSizes[] = {64, 128, 256, 512};

    for (int blockSize : blockSizes) {
        MixGraph graph;
        graph.strips.resize(3);
        graph.routingLayoutKey = 42;
        graph.strips[0].id = "track:0";
        graph.strips[0].kind = StripKind::Track;
        graph.strips[0].channels = 2;
        graph.strips[0].gainLinear = 1.0f;
        graph.strips[0].audible = true;

        graph.strips[1].id = "track:1";
        graph.strips[1].kind = StripKind::Track;
        graph.strips[1].channels = 2;
        graph.strips[1].gainLinear = 1.0f;
        graph.strips[1].audible = true;

        graph.strips[2].id = "main";
        graph.strips[2].kind = StripKind::Main;
        graph.strips[2].channels = 2;
        graph.strips[2].gainLinear = 1.0f;
        graph.strips[2].audible = true;

        MixEdge edge0{.from = 0, .to = 2, .gainLinear = 1.0f, .active = true};
        MixEdge edge1{.from = 1, .to = 2, .gainLinear = 1.0f, .active = true};
        graph.edges.push_back(edge0);
        graph.edges.push_back(edge1);

        // Track 0 has 128 samples latency, Track 1 has 0 samples latency
        constexpr uint32_t kLatency = 128;
        std::vector<std::string> warnings;
        auto delayBank = PluginDelayBank::build(graph, {kLatency, 0, 0}, 48000.0, warnings);
        REQUIRE(delayBank != nullptr);

        MixProcessorView procView;
        delayBank->applyTo(procView);

        MixRenderer renderer;
        renderer.prepare(48000.0, 512, 3, 2);

        // 1. Benchmark latency across 2000 blocks
        constexpr int kTrials = 2000;
        std::vector<double> timingsUs;
        timingsUs.reserve(kTrials);

        // Warmup
        for (int i = 0; i < 50; ++i) {
            renderer.beginBlock(graph, blockSize);
            renderer.process(graph, blockSize, procView);
        }

        for (int i = 0; i < kTrials; ++i) {
            renderer.beginBlock(graph, blockSize);
            const auto t0 = std::chrono::high_resolution_clock::now();
            renderer.process(graph, blockSize, procView);
            const auto t1 = std::chrono::high_resolution_clock::now();
            timingsUs.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());
        }

        std::sort(timingsUs.begin(), timingsUs.end());
        const double p50 = timingsUs[static_cast<size_t>(kTrials * 0.50)];
        const double p95 = timingsUs[static_cast<size_t>(kTrials * 0.95)];
        const double p99 = timingsUs[static_cast<size_t>(kTrials * 0.99)];
        const double maxTime = timingsUs.back();
        const double deadlineUs = (static_cast<double>(blockSize) / 48000.0) * 1.0e6;

        MESSAGE("Block " << blockSize << " frames (deadline " << deadlineUs << " µs): "
                << "p50=" << p50 << " µs (" << (p50 / deadlineUs * 100.0) << "% CPU), "
                << "p95=" << p95 << " µs (" << (p95 / deadlineUs * 100.0) << "% CPU), "
                << "p99=" << p99 << " µs (" << (p99 / deadlineUs * 100.0) << "% CPU), "
                << "max=" << maxTime << " µs (" << (maxTime / deadlineUs * 100.0) << "% CPU)");

        CHECK(maxTime < deadlineUs); // Zero underruns
        CHECK(p99 < deadlineUs * 0.10); // Under 10% CPU at 99th percentile

        // 2. Verify PDC alignment:
        // Track 0 has 128 samples latency, so Edge 1 (track 1 -> main) is delayed by 128 samples.
        // Rebuild clean delay line
        renderer.prepare(48000.0, 512, 3, 2);
        delayBank = PluginDelayBank::build(graph, {kLatency, 0, 0}, 48000.0, warnings);
        delayBank->applyTo(procView);

        int sampleCounter = 0;
        int impulseArrivedSample = -1;

        for (int b = 0; b < 10; ++b) {
            renderer.beginBlock(graph, blockSize);
            if (b == 0) {
                float* track1L = renderer.sourceChannel(1, 0);
                REQUIRE(track1L != nullptr);
                track1L[0] = 1.0f; // Impulse on Track 1 at sample 0
            }
            renderer.process(graph, blockSize, procView);
            const float* mainL = renderer.postChannel(2, 0);
            REQUIRE(mainL != nullptr);
            for (int s = 0; s < blockSize; ++s) {
                if (mainL[s] > 0.5f && impulseArrivedSample < 0) {
                    impulseArrivedSample = sampleCounter + s;
                }
            }
            sampleCounter += blockSize;
        }

        CHECK(impulseArrivedSample == static_cast<int>(kLatency));
    }
}

TEST_CASE("Dynamic PDC changed-latency refill continuity and alignment during active rendering") {
    // Synthetic MixRenderer/PluginDelayBank transition from 64 to 128 samples
    // at representative block sizes. This does not run a vendor or reconfigure
    // a physical device. The allocation probe covers ordinary C++ new/new[].
    // Verifies:
    // 1. Zero probed C++ allocations during the renderer transition.
    // 2. Refill transient is bounded exactly to the new delay length.
    // 3. Signal continuity: zero NaN/Inf, outputs clean delayed stream.
    // 4. Phase and alignment match the newly declared latency exactly.
    const int blockSizes[] = {64, 128, 256, 512};

    for (int blockSize : blockSizes) {
        MixGraph graph;
        graph.strips.resize(3);
        graph.routingLayoutKey = 100 + static_cast<uint64_t>(blockSize);
        graph.strips[0].id = "track:0";
        graph.strips[0].kind = StripKind::Track;
        graph.strips[0].channels = 2;
        graph.strips[0].gainLinear = 1.0f;
        graph.strips[0].audible = true;

        graph.strips[1].id = "track:1";
        graph.strips[1].kind = StripKind::Track;
        graph.strips[1].channels = 2;
        graph.strips[1].gainLinear = 1.0f;
        graph.strips[1].audible = true;

        graph.strips[2].id = "main";
        graph.strips[2].kind = StripKind::Main;
        graph.strips[2].channels = 2;
        graph.strips[2].gainLinear = 1.0f;
        graph.strips[2].audible = true;

        MixEdge edge0{.from = 0, .to = 2, .gainLinear = 1.0f, .active = true};
        MixEdge edge1{.from = 1, .to = 2, .gainLinear = 1.0f, .active = true};
        graph.edges.push_back(edge0);
        graph.edges.push_back(edge1);

        MixRenderer renderer;
        renderer.prepare(48000.0, 512, 3, 2);

        std::vector<std::string> warnings;
        // Initial latency: Track 0 has 64 samples latency -> Edge 1 gets 64 samples delay
        uint32_t currentLatency = 64;
        auto delayBank = PluginDelayBank::build(graph, {currentLatency, 0, 0}, 48000.0, warnings);
        REQUIRE(delayBank != nullptr);

        MixProcessorView procView;
        delayBank->applyTo(procView);

        constexpr double freq = 440.0;
        constexpr double sr = 48000.0;
        int globalSample = 0;

        auto renderBlock = [&](MixProcessorView& view) {
            renderer.beginBlock(graph, blockSize);
            float* track1L = renderer.sourceChannel(1, 0);
            float* track1R = renderer.sourceChannel(1, 1);
            for (int s = 0; s < blockSize; ++s) {
                const float val = static_cast<float>(std::sin(2.0 * 3.141592653589793 * freq * (globalSample + s) / sr));
                track1L[s] = val;
                track1R[s] = val;
            }
            renderer.process(graph, blockSize, view);
            globalSample += blockSize;
        };

        // Render enough blocks to establish continuous steady state (at least 640 samples)
        const int warmupBlocks = std::max(10, 640 / blockSize);
        for (int b = 0; b < warmupBlocks; ++b) {
            renderBlock(procView);
            const float* mainL = renderer.postChannel(2, 0);
            for (int s = 0; s < blockSize; ++s) {
                REQUIRE_FALSE(std::isnan(mainL[s]));
                REQUIRE_FALSE(std::isinf(mainL[s]));
            }
        }

        // Now, change latency from 64 to 128 samples (e.g. plugin lookahead or oversampling increased)
        currentLatency = 128;
        auto nextDelayBank = PluginDelayBank::build(graph, {currentLatency, 0, 0}, 48000.0, warnings, delayBank.get());
        REQUIRE(nextDelayBank != nullptr);

        MixProcessorView nextView;
        nextDelayBank->applyTo(nextView);

#if !defined(_MSC_VER)
        sAudioRenderAllocProbeCount = 0;
        sAudioRenderAllocProbeActive = true;
#endif

        // Render through transition (enough to clear 128-sample refill transient)
        const int transitionBlocks = std::max(10, (128 / blockSize) + 4);
        for (int b = 0; b < transitionBlocks; ++b) {
            renderBlock(nextView);
            const float* mainL = renderer.postChannel(2, 0);
            for (int s = 0; s < blockSize; ++s) {
                REQUIRE_FALSE(std::isnan(mainL[s]));
                REQUIRE_FALSE(std::isinf(mainL[s]));
                // A changed-delay ring is fresh: exactly its first 128 output
                // frames are zero, then every frame must match the new source
                // origin. Checking only the final block missed long refill gaps.
                const int elapsed = b * blockSize + s;
                const int source = globalSample - blockSize + s
                    - static_cast<int>(currentLatency);
                const float expected = elapsed < static_cast<int>(currentLatency)
                    ? 0.0f : static_cast<float>(std::sin(
                        2.0 * 3.141592653589793 * freq * source / sr));
                CHECK(mainL[s] == doctest::Approx(expected).epsilon(0.001f));
            }
        }

#if !defined(_MSC_VER)
        sAudioRenderAllocProbeActive = false;
        CHECK(sAudioRenderAllocProbeCount == 0); // Zero allocations across latency change
#endif

        // Verify steady-state output after refill matches exactly 128-sample delayed sine
        const float* mainL = renderer.postChannel(2, 0);
        const int checkBlockStart = globalSample - blockSize;
        for (int s = 0; s < blockSize; ++s) {
            const int expectedSample = (checkBlockStart + s) - static_cast<int>(currentLatency);
            const float expectedVal = static_cast<float>(std::sin(2.0 * 3.141592653589793 * freq * expectedSample / sr));
            CHECK(doctest::Approx(mainL[s]).epsilon(0.001f) == expectedVal);
        }
    }
}

TEST_CASE("MixRenderer varying block sizes (64, 128, 256, 512 frames) with PDC maintain probed zero allocations and phase continuity") {
    MixGraph graph;
    graph.strips.resize(3);
    graph.routingLayoutKey = 200;
    graph.strips[0].id = "track:0";
    graph.strips[0].kind = StripKind::Track;
    graph.strips[0].channels = 2;
    graph.strips[0].gainLinear = 1.0f;
    graph.strips[0].audible = true;

    graph.strips[1].id = "track:1";
    graph.strips[1].kind = StripKind::Track;
    graph.strips[1].channels = 2;
    graph.strips[1].gainLinear = 1.0f;
    graph.strips[1].audible = true;

    graph.strips[2].id = "main";
    graph.strips[2].kind = StripKind::Main;
    graph.strips[2].channels = 2;
    graph.strips[2].gainLinear = 1.0f;
    graph.strips[2].audible = true;

    MixEdge edge0{.from = 0, .to = 2, .gainLinear = 1.0f, .active = true};
    MixEdge edge1{.from = 1, .to = 2, .gainLinear = 1.0f, .active = true};
    graph.edges.push_back(edge0);
    graph.edges.push_back(edge1);

    MixRenderer renderer;
    renderer.prepare(48000.0, 512, 3, 2);

    constexpr uint32_t kLatency = 128;
    std::vector<std::string> warnings;
    auto delayBank = PluginDelayBank::build(graph, {kLatency, 0, 0}, 48000.0, warnings);
    REQUIRE(delayBank != nullptr);

    MixProcessorView procView;
    delayBank->applyTo(procView);

    constexpr double freq = 440.0;
    constexpr double sr = 48000.0;
    int globalSample = 0;

    // Sequence of alternating buffer sizes spanning small (64), medium (128, 256) and large (512)
    const int blockSequence[] = {
        64, 128, 256, 512, 64, 256, 128, 512, 64, 64, 128, 256, 512, 128, 64, 512
    };

#if !defined(_MSC_VER)
    sAudioRenderAllocProbeCount = 0;
    sAudioRenderAllocProbeActive = true;
#endif

    for (int curBlockSize : blockSequence) {
        renderer.beginBlock(graph, curBlockSize);
        float* track1L = renderer.sourceChannel(1, 0);
        float* track1R = renderer.sourceChannel(1, 1);
        for (int s = 0; s < curBlockSize; ++s) {
            const float val = static_cast<float>(std::sin(2.0 * 3.141592653589793 * freq * (globalSample + s) / sr));
            track1L[s] = val;
            track1R[s] = val;
        }
        renderer.process(graph, curBlockSize, procView);

        const float* mainL = renderer.postChannel(2, 0);
        for (int s = 0; s < curBlockSize; ++s) {
            REQUIRE_FALSE(std::isnan(mainL[s]));
            REQUIRE_FALSE(std::isinf(mainL[s]));
            // After initial 128-sample delay line fill, verify phase continuity:
            if (globalSample + s >= static_cast<int>(kLatency)) {
                const int expectedSample = (globalSample + s) - static_cast<int>(kLatency);
                const float expectedVal = static_cast<float>(std::sin(2.0 * 3.141592653589793 * freq * expectedSample / sr));
                CHECK(doctest::Approx(mainL[s]).epsilon(0.001f) == expectedVal);
            }
        }
        globalSample += curBlockSize;
    }

#if !defined(_MSC_VER)
    sAudioRenderAllocProbeActive = false;
    CHECK(sAudioRenderAllocProbeCount == 0); // Zero allocations across all buffer transitions
#endif
}

} // TEST_SUITE
