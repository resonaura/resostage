#include "doctest.h"

#include "audio/AutomationEnvelope.h"
#include "audio/EnvelopeFollower.h"
#include "audio/MixGraph.h"
#include "audio/MixRenderer.h"

#include <chrono>
#include <iostream>
#include <vector>

using namespace resostage;

namespace {

void benchInsertProcessor(void* /*context*/, float* left, float* right, int numSamples) noexcept {
    // Typical light insert processing: 2-band biquad / gain math
    for (int i = 0; i < numSamples; ++i) {
        left[i] = (left[i] * 0.95f) + 0.01f;
        right[i] = (right[i] * 0.95f) + 0.01f;
    }
}

} // namespace

TEST_SUITE("PluginPerformance") {

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

} // TEST_SUITE
