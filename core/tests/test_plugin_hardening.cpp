#include "doctest.h"

#include "audio/MixMath.h"
#include "audio/MixRenderer.h"
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

} // TEST_SUITE
