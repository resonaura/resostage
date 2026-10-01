/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "audio/graph/MixMath.h"
#include "audio/graph/MixRenderer.h"
#include <cmath>
#include <limits>
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

void runMockInstrument(void* context, float* left, float* right, int numSamples) noexcept {
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

TEST_CASE("Dynamic PDC: history seeding preserves continuity and applies Hann taper on expansion") {
    struct TestDelayLine {
        explicit TestDelayLine(uint32_t len) : left(len, 0.0f), right(len, 0.0f) {}
        std::vector<float> left;
        std::vector<float> right;
        std::atomic<uint32_t> cursor{0};

        void seedFrom(const TestDelayLine* prev) {
            if (prev == nullptr) return;
            const uint32_t delaySamples = static_cast<uint32_t>(left.size());
            const uint32_t prevLen = static_cast<uint32_t>(prev->left.size());
            if (prevLen == 0 || delaySamples == 0) return;
            const uint32_t prevCursor = prev->cursor.load(std::memory_order_relaxed) % prevLen;
            for (uint32_t i = 0; i < delaySamples; ++i) {
                const uint32_t k = delaySamples - i;
                if (k <= prevLen) {
                    const uint32_t prevIdx = (prevCursor + prevLen
                        - (k % prevLen == 0 ? prevLen : (k % prevLen))) % prevLen;
                    left[i] = prev->left[prevIdx];
                    right[i] = prev->right[prevIdx];
                }
            }
            if (delaySamples > prevLen) {
                const uint32_t boundary = delaySamples - prevLen;
                const uint32_t fadeSamples = std::min<uint32_t>(64, prevLen);
                for (uint32_t f = 0; f < fadeSamples; ++f) {
                    const float ramp = 0.5f * (1.0f - std::cos(
                        3.14159265358979323846f * static_cast<float>(f)
                        / static_cast<float>(fadeSamples)));
                    left[boundary + f] *= ramp;
                    right[boundary + f] *= ramp;
                }
            }
        }
    };

    SUBCASE("Equal length delay lines preserve exact history and cursor continuity") {
        constexpr uint32_t kLen = 100;
        TestDelayLine prev(kLen);
        for (uint32_t i = 0; i < kLen; ++i) {
            prev.left[i] = static_cast<float>(i + 1);
            prev.right[i] = static_cast<float>(i + 1);
        }
        prev.cursor.store(25, std::memory_order_relaxed);

        TestDelayLine next(kLen);
        next.seedFrom(&prev);

        // At index 0, the next sample to be output should be the sample at prev.cursor (25)
        // because k = delaySamples = 100 -> prevIdx = (25 + 100 - 100) % 100 = 25
        CHECK(next.left[0] == doctest::Approx(prev.left[25]));
        // The most recently written sample was at index 24 (1 sample in the past, k = 1)
        // It must appear at next.left[99]
        CHECK(next.left[99] == doctest::Approx(prev.left[24]));
    }

    SUBCASE("Delay line expansion applies Hann taper on the zero-to-audio boundary") {
        constexpr uint32_t kPrevLen = 100;
        constexpr uint32_t kNextLen = 150;
        TestDelayLine prev(kPrevLen);
        for (uint32_t i = 0; i < kPrevLen; ++i) {
            prev.left[i] = 1.0f;
            prev.right[i] = 1.0f;
        }
        prev.cursor.store(0, std::memory_order_relaxed);

        TestDelayLine next(kNextLen);
        next.seedFrom(&prev);

        // Samples from 0 to boundary - 1 (0 to 49) must be 0.0f
        for (uint32_t i = 0; i < 50; ++i) {
            CHECK(next.left[i] == 0.0f);
        }

        // At boundary (index 50), ramp = 0.5 * (1 - cos(0)) = 0.0f
        CHECK(next.left[50] == doctest::Approx(0.0f));

        // Over the 64-sample Hann fade, audio smoothly increases towards 1.0f
        CHECK(next.left[50 + 32] > 0.4f);
        CHECK(next.left[50 + 32] < 0.6f);
        CHECK(next.left[50 + 63] > 0.95f);

        // After the fade (index >= 114), audio is fully at 1.0f
        for (uint32_t i = 114; i < kNextLen; ++i) {
            CHECK(next.left[i] == doctest::Approx(1.0f));
        }
    }

    SUBCASE("Delay line contraction preserves newest history") {
        constexpr uint32_t kPrevLen = 100;
        constexpr uint32_t kNextLen = 40;
        TestDelayLine prev(kPrevLen);
        for (uint32_t i = 0; i < kPrevLen; ++i) {
            prev.left[i] = static_cast<float>(i);
        }
        prev.cursor.store(0, std::memory_order_relaxed);

        TestDelayLine next(kNextLen);
        next.seedFrom(&prev);

        // Most recent sample (k = 1) is at prev index 99
        CHECK(next.left[39] == doctest::Approx(99.0f));
        // Sample 40 steps ago (k = 40) is at prev index 60
        CHECK(next.left[0] == doctest::Approx(60.0f));
    }
}

} // TEST_SUITE
