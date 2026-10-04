/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "audio/graph/MixMath.h"
#include "audio/graph/MixLatency.h"
#include "audio/graph/MixRenderer.h"
#include "plugins/PluginDelayBank.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

using namespace resostage;

namespace {

constexpr int kBlock = 256;
// The renderer glides coefficients over ~10 ms, so a single short block never
// fully reaches the target. Every level assertion here therefore runs the
// mix for long enough that the glide has settled, exactly like real playback.
constexpr int kSettleBlocks = 40;

void applyTestGain(void* context, float* left, float* right, int samples) noexcept {
    const float gain = *static_cast<const float*>(context);
    for (int i = 0; i < samples; ++i) {
        left[i] *= gain;
        right[i] *= gain;
    }
}

struct TestDelay {
    explicit TestDelay(size_t samples)
        : left(samples, 0.0f), right(samples, 0.0f) {}
    std::vector<float> left;
    std::vector<float> right;
    size_t cursor = 0;
};

void processTestStripDelay(void* context, float* left, float* right,
                           int samples) noexcept {
    auto& delay = *static_cast<TestDelay*>(context);
    for (int i = 0; i < samples; ++i) {
        const float inputL = left[i];
        const float inputR = right[i];
        left[i] = delay.left[delay.cursor];
        right[i] = delay.right[delay.cursor];
        delay.left[delay.cursor] = inputL;
        delay.right[delay.cursor] = inputR;
        delay.cursor = (delay.cursor + 1) % delay.left.size();
    }
}

void processTestEdgeDelay(void* context,
                          const float* inputLeft,
                          const float* inputRight,
                          float* outputLeft,
                          float* outputRight,
                          int samples,
                          bool inputEnabled) noexcept {
    auto& delay = *static_cast<TestDelay*>(context);
    for (int i = 0; i < samples; ++i) {
        outputLeft[i] = delay.left[delay.cursor];
        outputRight[i] = delay.right[delay.cursor];
        delay.left[delay.cursor] = inputEnabled ? inputLeft[i] : 0.0f;
        delay.right[delay.cursor] = inputEnabled ? inputRight[i] : 0.0f;
        delay.cursor = (delay.cursor + 1) % delay.left.size();
    }
}

struct SidechainCapture {
    uint32_t pluginSlotIndex = 0;
    uint32_t inputBusIndex = 0;
    SidechainChannelMode channelMode = SidechainChannelMode::Automatic;
    bool active = false;
    float left = 0.0f;
    float right = 0.0f;
    uint32_t count = 0;
};

void captureSidechain(void* context, float*, float*, int,
                      const MixSidechainInput* inputs,
                      uint32_t inputCount) noexcept {
    auto& capture = *static_cast<SidechainCapture*>(context);
    capture.count = inputCount;
    if (inputCount == 0 || inputs == nullptr)
        return;
    capture.pluginSlotIndex = inputs[0].pluginSlotIndex;
    capture.inputBusIndex = inputs[0].inputBusIndex;
    capture.channelMode = inputs[0].channelMode;
    capture.active = inputs[0].active;
    if (inputs[0].left != nullptr && inputs[0].right != nullptr) {
        capture.left = inputs[0].left[0];
        capture.right = inputs[0].right[0];
    }
}

struct SidechainAlignmentCapture {
    float priorLeft = 0.0f;
    float priorRight = 0.0f;
    uint32_t mismatchedSamples = 0;
};

void captureAlignedSidechain(void* context, float* left, float* right,
                             int samples, const MixSidechainInput* inputs,
                             uint32_t inputCount) noexcept {
    auto& capture = *static_cast<SidechainAlignmentCapture*>(context);
    if (inputCount == 0 || inputs == nullptr || inputs[0].left == nullptr
        || inputs[0].right == nullptr)
        return;
    for (int sample = 0; sample < samples; ++sample) {
        const float alignedLeft = capture.priorLeft;
        const float alignedRight = capture.priorRight;
        capture.priorLeft = left[sample];
        capture.priorRight = right[sample];
        if (std::abs(alignedLeft - inputs[0].left[sample]) > 1.0e-6f
            || std::abs(alignedRight - inputs[0].right[sample]) > 1.0e-6f)
            ++capture.mismatchedSamples;
    }
}

Project twoTrackProject() {
    Project p;
    p.main.channels = 2;
    p.main.output.type = OutputType::ExtOut;
    p.main.output.target = "audio::out:1,audio::out:2";
    p.click.enabled = false;

    TrackDef a;
    a.id = "audio::track:1";
    a.output.type = OutputType::Main;
    p.tracks.push_back(a);

    TrackDef b;
    b.id = "audio::track:2";
    b.output.type = OutputType::Main;
    p.tracks.push_back(b);
    return p;
}

OutputLaneConfig stereoOut() {
    OutputLaneConfig cfg;
    cfg.totalChannels = 2;
    return cfg;
}

// Drives the graph with DC on the named source strips and returns the summed
// device output. DC keeps the assertions about gain/pan/fold exact.
struct MixResult {
    std::vector<float> outLeft;
    std::vector<float> outRight;
    std::vector<StripLevels> levels;
};

MixResult runMix(const MixGraph& graph, const std::vector<std::pair<std::string, std::pair<float, float>>>& sources) {
    MixRenderer renderer;
    renderer.prepare(48000.0, kBlock, graph.strips.size(),
                     std::max(graph.edges.size(), graph.sidechainEdges.size()));

    std::vector<float> left(kBlock, 0.0f);
    std::vector<float> right(kBlock, 0.0f);
    float* outs[2] = {left.data(), right.data()};

    for (int block = 0; block < kSettleBlocks; ++block) {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);

        renderer.beginBlock(graph, kBlock);
        for (const auto& [id, value] : sources) {
            const uint32_t index = graph.find(id);
            REQUIRE(index != MixGraph::kNoStrip);
            float* l = renderer.sourceChannel(index, 0);
            float* r = renderer.sourceChannel(index, 1);
            for (int i = 0; i < kBlock; ++i) {
                l[i] = value.first;
                r[i] = value.second;
            }
        }
        renderer.process(graph, kBlock);
        renderer.writeToOutputs(graph, outs, 2, kBlock);
    }

    MixResult result;
    result.outLeft = left;
    result.outRight = right;
    result.levels.resize(graph.strips.size());
    for (uint32_t s = 0; s < graph.strips.size(); ++s)
        result.levels[s] = renderer.levels(s);
    return result;
}

float lastL(const MixResult& r) { return r.outLeft[kBlock - 1]; }
float lastR(const MixResult& r) { return r.outRight[kBlock - 1]; }

const StripLevels& levelOf(const MixGraph& g, const MixResult& r, std::string_view id) {
    return r.levels[g.find(std::string(id))];
}

} // namespace

TEST_CASE("renderer: two tracks sum through master to the physical pair") {
    const MixGraph g = buildMixGraph(twoTrackProject(), stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {0.25f, 0.25f}},
                                   {"audio::track:2", {0.25f, 0.25f}}});
    CHECK(lastL(r) == doctest::Approx(0.5f).epsilon(1e-3));
    CHECK(lastR(r) == doctest::Approx(0.5f).epsilon(1e-3));
}

// ── The master strip actually works ─────────────────────────────────────────
// These four are the regression coverage for the reported bug: Mute, the
// mono/stereo switch, balance and volume all silently did nothing on Main.

TEST_CASE("renderer: master mute silences the physical output") {
    Project p = twoTrackProject();
    p.main.mute = true;
    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {0.5f, 0.5f}}});
    CHECK(lastL(r) == doctest::Approx(0.0f).epsilon(1e-4));
    CHECK(lastR(r) == doctest::Approx(0.0f).epsilon(1e-4));
}

TEST_CASE("renderer: master fader scales the physical output") {
    Project p = twoTrackProject();
    p.main.gainDb = -6.0;
    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {1.0f, 1.0f}}});
    CHECK(lastL(r) == doctest::Approx(0.5011872f).epsilon(1e-3));
    CHECK(lastR(r) == doctest::Approx(0.5011872f).epsilon(1e-3));
}

TEST_CASE("renderer: master balance attenuates one side of the physical output") {
    Project p = twoTrackProject();
    p.main.pan = -1.0; // hard left
    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {0.8f, 0.8f}}});
    CHECK(lastL(r) == doctest::Approx(0.8f).epsilon(1e-3));
    CHECK(lastR(r) == doctest::Approx(0.0f).epsilon(1e-3));
}

TEST_CASE("renderer: master mono folds L+R and feeds both output channels") {
    Project p = twoTrackProject();
    p.main.channels = 1;
    const MixGraph g = buildMixGraph(p, stereoOut());
    // Hard-panned content: stereo would keep the sides apart, mono averages.
    const MixResult r = runMix(g, {{"audio::track:1", {1.0f, 0.0f}}});
    CHECK(lastL(r) == doctest::Approx(0.5f).epsilon(1e-3));
    CHECK(lastR(r) == doctest::Approx(0.5f).epsilon(1e-3));
}

TEST_CASE("renderer: master stereo keeps the sides apart") {
    const MixGraph g = buildMixGraph(twoTrackProject(), stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {1.0f, 0.0f}}});
    CHECK(lastL(r) == doctest::Approx(1.0f).epsilon(1e-3));
    CHECK(lastR(r) == doctest::Approx(0.0f).epsilon(1e-3));
}

// ── Metering rules ──────────────────────────────────────────────────────────

TEST_CASE("meter: shows the strip's own gain and pan") {
    Project p = twoTrackProject();
    p.tracks[0].gainDb = -6.0;
    p.tracks[0].pan = 1.0; // hard right

    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {1.0f, 1.0f}}});
    const StripLevels& track = levelOf(g, r, "audio::track:1");
    CHECK(track.peakL == doctest::Approx(0.0f).epsilon(1e-3));
    CHECK(track.peakR == doctest::Approx(0.5011872f).epsilon(1e-3));
}

TEST_CASE("meter: a muted strip still meters -- mute is downstream of the meter tap") {
    Project p = twoTrackProject();
    p.tracks[0].mute = true;

    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {0.7f, 0.7f}}});
    CHECK(levelOf(g, r, "audio::track:1").peakL == doctest::Approx(0.7f).epsilon(1e-3));
    // ...but nothing of it reaches the master or the outputs.
    CHECK(levelOf(g, r, "audio::main").peakL == doctest::Approx(0.0f).epsilon(1e-4));
    CHECK(lastL(r) == doctest::Approx(0.0f).epsilon(1e-4));
}

TEST_CASE("meter: a strip silenced by someone else's solo still meters") {
    Project p = twoTrackProject();
    p.tracks[1].solo = true;

    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {0.6f, 0.6f}}});
    CHECK(levelOf(g, r, "audio::track:1").peakL == doctest::Approx(0.6f).epsilon(1e-3));
    CHECK(lastL(r) == doctest::Approx(0.0f).epsilon(1e-4));
}

TEST_CASE("meter: a bus meter includes the sends mixed into it") {
    Project p = twoTrackProject();
    SendBus send;
    send.id = "audio::send:1";
    send.channels = 2;
    send.output.type = OutputType::ExtOut;
    send.output.target = "audio::out:1,audio::out:2";
    p.sends.push_back(send);

    SendConfig row;
    row.bus = "audio::send:1";
    row.level = 50.0;
    p.tracks[0].output.sends.push_back(row);

    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {0.8f, 0.8f}}});
    CHECK(levelOf(g, r, "audio::send:1").peakL == doctest::Approx(0.4f).epsilon(1e-3));
}

TEST_CASE("meter: a bus fader shows on the bus meter, its own mute does not") {
    Project p = twoTrackProject();
    SendBus send;
    send.id = "audio::send:1";
    send.channels = 2;
    send.gainDb = -6.0;
    send.mute = true;
    send.output.type = OutputType::ExtOut;
    send.output.target = "audio::out:1,audio::out:2";
    p.sends.push_back(send);

    SendConfig row;
    row.bus = "audio::send:1";
    p.tracks[0].output.sends.push_back(row);

    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {1.0f, 1.0f}}});
    CHECK(levelOf(g, r, "audio::send:1").peakL == doctest::Approx(0.5011872f).epsilon(1e-3));
}

// ── Routing shapes ──────────────────────────────────────────────────────────

TEST_CASE("renderer: a stereo track on a pair of mono lanes keeps its image") {
    Project p = twoTrackProject();
    p.tracks[0].output.type = OutputType::ExtOut;
    p.tracks[0].output.target = "audio::out:1,audio::out:2";
    p.main.output.target = "audio::out:1,audio::out:2";
    p.tracks[1].mute = true;

    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {0.9f, 0.3f}}});
    CHECK(lastL(r) == doctest::Approx(0.9f).epsilon(1e-3));
    CHECK(lastR(r) == doctest::Approx(0.3f).epsilon(1e-3));
}

TEST_CASE("renderer: a track on a single mono lane sums L+R") {
    Project p = twoTrackProject();
    p.tracks[0].output.type = OutputType::ExtOut;
    p.tracks[0].output.target = "audio::out:1";
    p.tracks[1].mute = true;
    p.main.mute = true;

    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {1.0f, 0.0f}}});
    CHECK(lastL(r) == doctest::Approx(0.5f).epsilon(1e-3));
    CHECK(lastR(r) == doctest::Approx(0.0f).epsilon(1e-4));
}

TEST_CASE("renderer: master and an aux sharing outs 1/2 sum instead of overwriting") {
    Project p = twoTrackProject();
    p.tracks[1].mute = true;

    SendBus send;
    send.id = "audio::send:1";
    send.channels = 2;
    send.output.type = OutputType::ExtOut;
    send.output.target = "audio::out:1,audio::out:2";
    p.sends.push_back(send);

    SendConfig row;
    row.bus = "audio::send:1";
    p.tracks[0].output.sends.push_back(row);

    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {0.25f, 0.25f}}});
    // 0.25 via master + 0.25 via the aux, both landing on the same lanes.
    CHECK(lastL(r) == doctest::Approx(0.5f).epsilon(1e-3));
}

TEST_CASE("renderer: a pre-fader send ignores the source fader and mute") {
    Project p = twoTrackProject();
    p.tracks[0].gainDb = -60.0;
    p.tracks[0].mute = true;
    p.tracks[1].mute = true;
    p.main.mute = true;

    SendBus send;
    send.id = "audio::send:1";
    send.channels = 2;
    send.output.type = OutputType::ExtOut;
    send.output.target = "audio::out:1,audio::out:2";
    p.sends.push_back(send);

    SendConfig row;
    row.bus = "audio::send:1";
    row.preFader = true;
    p.tracks[0].output.sends.push_back(row);

    const MixGraph g = buildMixGraph(p, stereoOut());
    const MixResult r = runMix(g, {{"audio::track:1", {0.5f, 0.5f}}});
    CHECK(lastL(r) == doctest::Approx(0.5f).epsilon(1e-3));
}

TEST_CASE("renderer: a shadow lane swallows its input without touching real outputs") {
    Project p = twoTrackProject();
    p.tracks[0].output.type = OutputType::ExtOut;
    p.tracks[0].output.target = "audio::out:9"; // device only has 2 channels
    p.tracks[1].mute = true;
    p.main.mute = true;

    const MixGraph g = buildMixGraph(p, stereoOut());
    REQUIRE(g.find("audio::out:9") != MixGraph::kNoStrip);
    const MixResult r = runMix(g, {{"audio::track:1", {1.0f, 1.0f}}});
    CHECK(lastL(r) == doctest::Approx(0.0f).epsilon(1e-4));
    CHECK(lastR(r) == doctest::Approx(0.0f).epsilon(1e-4));
}

TEST_CASE("renderer: a non-finite sample is scrubbed and never poisons the mix") {
    const MixGraph g = buildMixGraph(twoTrackProject(), stereoOut());
    MixRenderer renderer;
    renderer.prepare(48000.0, kBlock, g.strips.size(), g.edges.size());

    std::vector<float> left(kBlock, 0.0f);
    std::vector<float> right(kBlock, 0.0f);
    float* outs[2] = {left.data(), right.data()};

    const uint32_t bad = g.find("audio::track:1");
    const uint32_t good = g.find("audio::track:2");
    for (int block = 0; block < kSettleBlocks; ++block) {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        renderer.beginBlock(g, kBlock);
        for (int i = 0; i < kBlock; ++i) {
            renderer.sourceChannel(bad, 0)[i] = std::nanf("");
            renderer.sourceChannel(bad, 1)[i] = std::numeric_limits<float>::infinity();
            renderer.sourceChannel(good, 0)[i] = 0.5f;
            renderer.sourceChannel(good, 1)[i] = 0.5f;
        }
        renderer.process(g, kBlock);
        renderer.writeToOutputs(g, outs, 2, kBlock);
    }

    CHECK(std::isfinite(left[kBlock - 1]));
    CHECK(left[kBlock - 1] == doctest::Approx(0.5f).epsilon(1e-3));
}

TEST_CASE("renderer: an unprepared renderer refuses to render rather than crashing") {
    const MixGraph g = buildMixGraph(twoTrackProject(), stereoOut());
    MixRenderer renderer;
    CHECK_FALSE(renderer.canRender(g, kBlock));
    renderer.beginBlock(g, kBlock);
    renderer.process(g, kBlock);
    CHECK(renderer.sourceChannel(0, 0) == nullptr);
    CHECK(renderer.levels(0).peakL == 0.0f);
}

TEST_CASE("renderer: a graph larger than the prepared capacity is refused, not written past") {
    const MixGraph g = buildMixGraph(twoTrackProject(), stereoOut());
    MixRenderer renderer;
    renderer.prepare(48000.0, kBlock, g.strips.size() - 1, g.edges.size());
    CHECK_FALSE(renderer.canRender(g, kBlock));

    std::vector<float> left(kBlock, 0.0f);
    std::vector<float> right(kBlock, 0.0f);
    float* outs[2] = {left.data(), right.data()};
    renderer.beginBlock(g, kBlock);
    renderer.process(g, kBlock);
    renderer.writeToOutputs(g, outs, 2, kBlock);
    CHECK(left[0] == 0.0f);
}

// ── Glide landing ───────────────────────────────────────────────────────────
// The coefficient glide is x += alpha * (target - x). In float that approaches
// the target but STALLS short of it: once alpha*(target-x) falls below the last
// bit of x the addition is a no-op, freezing roughly 1.4e-5 out (~-97 dBFS) and
// never exactly equal. Anything that treats "settled" as exact equality --
// including the renderer's own fast path -- would then never see a settled
// strip again after the first fader move. These pin the landing.

namespace {

// Drives one renderer across several graphs, so a mid-flight coefficient
// change glides from the state the previous graph left behind, exactly like a
// knob move during playback does.
struct Rig {
    MixRenderer renderer;
    std::vector<float> left{std::vector<float>(kBlock, 0.0f)};
    std::vector<float> right{std::vector<float>(kBlock, 0.0f)};

    void prepare(const MixGraph& g) {
        renderer.prepare(48000.0, kBlock, g.strips.size() + 4,
                         g.edges.size() + 8);
    }

    void run(const MixGraph& g, const std::string& sourceId, float value, int blocks) {
        float* outs[2] = {left.data(), right.data()};
        for (int b = 0; b < blocks; ++b) {
            std::fill(left.begin(), left.end(), 0.0f);
            std::fill(right.begin(), right.end(), 0.0f);
            renderer.beginBlock(g, kBlock);
            const uint32_t index = g.find(sourceId);
            REQUIRE(index != MixGraph::kNoStrip);
            float* l = renderer.sourceChannel(index, 0);
            float* r = renderer.sourceChannel(index, 1);
            for (int i = 0; i < kBlock; ++i) {
                l[i] = value;
                r[i] = value;
            }
            renderer.process(g, kBlock);
            renderer.writeToOutputs(g, outs, 2, kBlock);
        }
    }
};

} // namespace

TEST_CASE("renderer: a fader move lands exactly on its target, not a hair short") {
    Project p = twoTrackProject();
    MixGraph g = buildMixGraph(p, stereoOut());

    Rig rig;
    rig.prepare(g);
    rig.run(g, "audio::track:1", 0.5f, kSettleBlocks);
    CHECK(rig.left[kBlock - 1] == 0.5f); // unity, exact from the very first block

    // Pull the fader down and let it glide for far longer than the ~10 ms law
    // needs. Deliberately an EXACT comparison: Approx would pass either way.
    p.tracks[0].gainDb = -6.0;
    g = buildMixGraph(p, stereoOut());
    rig.run(g, "audio::track:1", 0.5f, 400);

    CHECK(rig.left[kBlock - 1] == 0.5f * mix_math::dbToGain(-6.0));
}

TEST_CASE("renderer: a send level move lands exactly on its target") {
    Project p = twoTrackProject();
    SendBus bus;
    bus.id = "audio::send:1";
    bus.channels = 2;
    bus.output.type = OutputType::ExtOut;
    bus.output.target = "audio::out:1,audio::out:2";
    p.sends.push_back(bus);

    // Track 1 feeds ONLY the send, so the physical pair carries the send level
    // alone -- no main path to blur the comparison.
    p.tracks[0].output.type = OutputType::SendsOnly;
    SendConfig send;
    send.bus = "audio::send:1";
    send.level = 100.0;
    send.enabled = true;
    p.tracks[0].output.sends.push_back(send);
    p.tracks[1].output.type = OutputType::SendsOnly; // keep it silent

    MixGraph g = buildMixGraph(p, stereoOut());
    Rig rig;
    rig.prepare(g);
    rig.run(g, "audio::track:1", 0.5f, kSettleBlocks);
    CHECK(rig.left[kBlock - 1] == 0.5f);

    p.tracks[0].output.sends[0].level = 40.0; // 0.4 linear
    g = buildMixGraph(p, stereoOut());
    rig.run(g, "audio::track:1", 0.5f, 400);

    CHECK(rig.left[kBlock - 1] == 0.5f * 0.4f);
}

TEST_CASE("renderer: a block bigger than it was prepared for is refused, not written past") {
    // The rows are laid out strip-major (stripIndex * 2 * maxBlock), so a
    // block larger than maxBlock does not fail -- the caller's copy_n walks
    // into the next strip's rows and every strip ends up carrying a slice of
    // its neighbour. That is distortion, not a dropout, and no underrun
    // counter can see it. Raising the device buffer without re-preparing the
    // renderer is exactly how it happens.
    const MixGraph g = buildMixGraph(twoTrackProject(), stereoOut());
    MixRenderer renderer;
    renderer.prepare(48000.0, kBlock, g.strips.size(), g.edges.size());

    CHECK(renderer.canRender(g, kBlock));
    CHECK(renderer.canRender(g, kBlock / 2));
    CHECK_FALSE(renderer.canRender(g, kBlock * 8));
    CHECK_FALSE(renderer.canRender(g, 0));
    CHECK(renderer.maxBlockSize() == kBlock);

    // ...and after being re-prepared for the bigger block, it accepts it.
    renderer.prepare(48000.0, kBlock * 8, g.strips.size(), g.edges.size());
    CHECK(renderer.canRender(g, kBlock * 8));
    CHECK(renderer.maxBlockSize() == kBlock * 8);
}

TEST_CASE("renderer: a buffer-size change mid-playback does not bleed one strip into another") {
    // The scenario, run by hand a dozen times: play, then walk the device
    // buffer 512 -> 1024 -> 2048 -> 4096 and back without stopping. What that
    // was catching is here as an assertion -- two strips carrying DIFFERENT
    // constants, so a row that overlaps its neighbour shows up as the wrong
    // number rather than as something that has to be listened for.
    const Project p = twoTrackProject();
    const MixGraph g = buildMixGraph(p, stereoOut());
    MixRenderer renderer;

    const uint32_t one = g.find("audio::track:1");
    const uint32_t two = g.find("audio::track:2");
    REQUIRE(one != MixGraph::kNoStrip);
    REQUIRE(two != MixGraph::kNoStrip);

    // Opening the project at the device's current size, before any hop.
    renderer.prepare(48000.0, 512, g.strips.size(), g.edges.size());

    for (const int block : {512, 1024, 2048, 4096, 2048, 1024, 512, 4096}) {
        // What ensureScratchSizes() does on a device restart: grow to the new
        // block before the first callback at that size arrives, and never
        // shrink -- see the next test.
        if (renderer.maxBlockSize() < block)
            renderer.prepare(48000.0, block, g.strips.size(), g.edges.size());
        REQUIRE(renderer.canRender(g, block));

        std::vector<float> left(static_cast<size_t>(block), 0.0f);
        std::vector<float> right(static_cast<size_t>(block), 0.0f);
        float* outs[2] = {left.data(), right.data()};

        // Let the coefficient glide settle at this size, exactly as a real
        // device would after a restart.
        for (int pass = 0; pass < kSettleBlocks; ++pass) {
            std::fill(left.begin(), left.end(), 0.0f);
            std::fill(right.begin(), right.end(), 0.0f);
            renderer.beginBlock(g, block);
            for (int i = 0; i < block; ++i) {
                renderer.sourceChannel(one, 0)[i] = 0.25f;
                renderer.sourceChannel(one, 1)[i] = 0.25f;
                renderer.sourceChannel(two, 0)[i] = -0.75f;
                renderer.sourceChannel(two, 1)[i] = -0.75f;
            }
            renderer.process(g, block);
            renderer.writeToOutputs(g, outs, 2, block);
        }

        // Each strip metered its OWN constant, start to end. A strip-major
        // overlap shows here as one strip reporting the other's peak.
        CHECK(renderer.levels(one).peakL == doctest::Approx(0.25f));
        CHECK(renderer.levels(two).peakL == doctest::Approx(0.75f));

        // ...and the sum is the sum, at every sample of the block -- not just
        // at the first one, which a short-row overlap would leave correct.
        for (int i = 0; i < block; ++i) {
            CHECK(left[static_cast<size_t>(i)] == doctest::Approx(-0.5f));
            CHECK(right[static_cast<size_t>(i)] == doctest::Approx(-0.5f));
        }
    }
}

TEST_CASE("renderer: shrinking the device buffer keeps the bigger allocation") {
    // Going 4096 -> 512 must not re-prepare downwards. It would work, and then
    // the next hop back up would have to reallocate on the audio thread's
    // critical path -- or, worse, be forgotten and overrun.
    const MixGraph g = buildMixGraph(twoTrackProject(), stereoOut());
    MixRenderer renderer;
    renderer.prepare(48000.0, 4096, g.strips.size(), g.edges.size());

    CHECK(renderer.canRender(g, 512));
    CHECK(renderer.canRender(g, 4096));
    CHECK(renderer.maxBlockSize() == 4096);
}

TEST_CASE("renderer: strip processors run post-input-sum and pre-fader") {
    Project project = twoTrackProject();
    project.tracks.resize(1);
    const MixGraph graph = buildMixGraph(project, stereoOut());
    const uint32_t track = graph.find("audio::track:1");
    REQUIRE(track != MixGraph::kNoStrip);

    MixRenderer renderer;
    renderer.prepare(48000.0, kBlock, graph.strips.size(), graph.edges.size());
    float gain = 0.25f;
    std::vector<MixStripProcessor> processors(graph.strips.size());
    processors[track] = MixStripProcessor{&gain, applyTestGain};

    renderer.beginBlock(graph, kBlock);
    std::fill_n(renderer.sourceChannel(track, 0), kBlock, 1.0f);
    std::fill_n(renderer.sourceChannel(track, 1), kBlock, -0.5f);
    renderer.process(graph, kBlock, {processors.data(), processors.size()});

    // The post-fader tap and every downstream edge see the processed signal.
    CHECK(renderer.postChannel(track, 0)[0] == doctest::Approx(0.25f));
    CHECK(renderer.postChannel(track, 1)[0] == doctest::Approx(-0.125f));
    CHECK(renderer.levels(track).peakL == doctest::Approx(0.25f));
    CHECK(renderer.levels(track).peakR == doctest::Approx(0.125f));
}

TEST_CASE("renderer delivers independent post-fader sidechain views to insert processors") {
    Project project = twoTrackProject();
    PluginSlot slot;
    slot.id = "destination-compressor";
    slot.plugin.identifier = "test:compressor";
    slot.plugin.name = "Test Compressor";
    slot.sidechain = PluginSidechainRoute{
        "audio::track:2", 1, SidechainChannelMode::Right};
    project.tracks[0].plugins.push_back(slot);

    const MixGraph graph = buildMixGraph(project, stereoOut());
    const uint32_t source = graph.find("audio::track:2");
    const uint32_t destination = graph.find("audio::track:1");
    REQUIRE(source < destination);
    REQUIRE(graph.sidechainEdges.size() == 1);

    MixRenderer renderer;
    renderer.prepare(48000.0, kBlock, graph.strips.size(),
                     std::max(graph.edges.size(), graph.sidechainEdges.size()));
    SidechainCapture capture;
    std::vector<MixStripProcessor> processors(graph.strips.size());
    processors[destination] = {&capture, nullptr, captureSidechain};
    renderer.beginBlock(graph, kBlock);
    std::fill_n(renderer.sourceChannel(source, 0), kBlock, 0.25f);
    std::fill_n(renderer.sourceChannel(source, 1), kBlock, 0.75f);
    renderer.process(graph, kBlock, {processors.data(), processors.size()});

    CHECK(capture.count == 1);
    CHECK(capture.pluginSlotIndex == 0);
    CHECK(capture.inputBusIndex == 1);
    CHECK(capture.channelMode == SidechainChannelMode::Right);
    CHECK(capture.active);
    CHECK(capture.left == doctest::Approx(0.25f));
    CHECK(capture.right == doctest::Approx(0.75f));
    CHECK(renderer.postChannel(destination, 0)[0] == doctest::Approx(0.0f));
    CHECK(renderer.postChannel(destination, 1)[0] == doctest::Approx(0.0f));
}

TEST_CASE("latency plan aligns every input at a summing strip") {
    const MixGraph graph = buildMixGraph(twoTrackProject(), stereoOut());
    const uint32_t first = graph.find("audio::track:1");
    const uint32_t second = graph.find("audio::track:2");
    const uint32_t main = graph.find("audio::main");
    REQUIRE(first != MixGraph::kNoStrip);
    REQUIRE(second != MixGraph::kNoStrip);
    REQUIRE(main != MixGraph::kNoStrip);

    std::vector<uint32_t> processorLatency(graph.strips.size(), 0);
    processorLatency[first] = 7;
    processorLatency[second] = 2;
    processorLatency[main] = 3;
    const MixLatencyPlan plan = buildMixLatencyPlan(graph, processorLatency);

    CHECK(plan.stripOutputLatencySamples[first] == 7);
    CHECK(plan.stripOutputLatencySamples[second] == 2);
    CHECK(plan.stripOutputLatencySamples[main] == 10);
    for (size_t i = 0; i < graph.edges.size(); ++i) {
        if (graph.edges[i].from == first && graph.edges[i].to == main)
            CHECK(plan.edgeDelaySamples[i] == 0);
        if (graph.edges[i].from == second && graph.edges[i].to == main)
            CHECK(plan.edgeDelaySamples[i] == 5);
    }
}

TEST_CASE("latency plan aligns a direct strip input with a sidechain at its insert") {
    MixGraph graph;
    graph.strips.resize(3);
    graph.strips[0].id = "audio::track:source";
    graph.strips[1].id = "audio::track:destination";
    graph.strips[2].id = "audio::main";
    graph.strips[2].kind = StripKind::Main;
    graph.edges.push_back({.from = 0, .to = 2});
    graph.edges.push_back({.from = 1, .to = 2});
    graph.sidechainEdges.push_back({
        .from = 0, .to = 1, .pluginSlotIndex = 1,
        .inputBusIndex = 1,
        .channelMode = SidechainChannelMode::Automatic,
        .active = true,
        .pluginSlotId = "compressor"});

    // Source chain latency is three samples. The destination's first insert
    // contributes one sample before the sidechain-aware second insert.
    const std::vector<uint32_t> stripLatency{3, 1, 0};
    const std::vector<std::vector<uint32_t>> slotLatency{
        {}, {1, 0}, {}};
    const MixLatencyPlan plan = buildMixLatencyPlan(
        graph, stripLatency, slotLatency);

    CHECK(plan.stripInputDelaySamples[0] == 0);
    CHECK(plan.stripInputDelaySamples[1] == 2);
    CHECK(plan.sidechainEdgeDelaySamples[0] == 0);
    CHECK(plan.stripOutputLatencySamples[1] == 3);
    CHECK(plan.maximumOutputLatencySamples == 3);

    // If the destination insert prefix is longer than the source path, keep
    // its direct input untouched and delay only the auxiliary feed.
    const std::vector<std::vector<uint32_t>> longerPrefix{
        {}, {6, 0}, {}};
    const std::vector<uint32_t> longerStripLatency{3, 6, 0};
    const MixLatencyPlan longerPlan = buildMixLatencyPlan(
        graph, longerStripLatency, longerPrefix);
    CHECK(longerPlan.stripInputDelaySamples[1] == 0);
    CHECK(longerPlan.sidechainEdgeDelaySamples[0] == 3);
}

TEST_CASE("latency plan does not pretend a pre-chain pad delays instrument audio") {
    MixGraph graph;
    graph.strips.resize(3);
    graph.strips[0].id = "audio::track:source";
    graph.strips[1].id = "audio::track:instrument";
    graph.strips[1].isInstrumentTrack = true;
    graph.strips[2].id = "audio::main";
    graph.strips[2].kind = StripKind::Main;
    graph.edges.push_back({.from = 0, .to = 2});
    graph.edges.push_back({.from = 1, .to = 2});
    graph.sidechainEdges.push_back({
        .from = 0, .to = 1, .pluginSlotIndex = 1,
        .inputBusIndex = 1,
        .channelMode = SidechainChannelMode::Automatic,
        .active = true,
        .pluginSlotId = "compressor"});

    const std::vector<uint32_t> stripLatency{8, 4, 0};
    const std::vector<std::vector<uint32_t>> slotLatency{
        {}, {4, 0}, {}};
    const MixLatencyPlan plan = buildMixLatencyPlan(
        graph, stripLatency, slotLatency);

    CHECK(plan.stripInputDelaySamples[1] == 0);
    CHECK(plan.sidechainEdgeDelaySamples[0] == 0);
    REQUIRE(plan.sidechainAlignmentUnavailable.size() == 1);
    CHECK(plan.sidechainAlignmentUnavailable[0]);
    CHECK(plan.stripOutputLatencySamples[1] == 4);
}

TEST_CASE("renderer aligns direct audio and sidechain at the selected insert") {
    MixGraph graph;
    graph.strips.resize(3);
    graph.strips[0].id = "audio::track:source";
    graph.strips[1].id = "audio::track:destination";
    graph.strips[2].id = "audio::main";
    graph.strips[2].kind = StripKind::Main;
    graph.edges.push_back({.from = 0, .to = 2});
    graph.edges.push_back({.from = 1, .to = 2});
    graph.sidechainEdges.push_back({
        .from = 0, .to = 1, .pluginSlotIndex = 1,
        .inputBusIndex = 1,
        .channelMode = SidechainChannelMode::Automatic,
        .active = true,
        .pluginSlotId = "compressor"});

    constexpr int samples = 16;
    const std::vector<uint32_t> stripLatency{3, 1, 0};
    const std::vector<std::vector<uint32_t>> slotLatency{
        {}, {1, 0}, {}};
    std::vector<std::string> warnings;
    auto delayBank = PluginDelayBank::build(
        graph, stripLatency, 48000.0, warnings, nullptr, slotLatency, samples);
    REQUIRE(delayBank != nullptr);
    CHECK(warnings.empty());

    MixRenderer renderer;
    renderer.prepare(48000.0, samples, graph.strips.size(),
                     std::max(graph.edges.size(), graph.sidechainEdges.size()));
    TestDelay sourceLatency(3);
    SidechainAlignmentCapture alignment;
    std::vector<MixStripProcessor> processors(graph.strips.size());
    processors[0] = {&sourceLatency, processTestStripDelay};
    processors[1] = {&alignment, nullptr, captureAlignedSidechain};
    MixProcessorView processorView{processors.data(), processors.size()};
    delayBank->applyTo(processorView);

    renderer.beginBlock(graph, samples);
    renderer.sourceChannel(0, 0)[0] = 1.0f;
    renderer.sourceChannel(0, 1)[0] = 1.0f;
    renderer.sourceChannel(1, 0)[0] = 1.0f;
    renderer.sourceChannel(1, 1)[0] = 1.0f;
    renderer.process(graph, samples, processorView);
    CHECK(alignment.mismatchedSamples == 0);
}

TEST_CASE("renderer applies prepared edge compensation without callback allocation") {
    const MixGraph graph = buildMixGraph(twoTrackProject(), stereoOut());
    const uint32_t first = graph.find("audio::track:1");
    const uint32_t second = graph.find("audio::track:2");
    const uint32_t main = graph.find("audio::main");
    REQUIRE(first != MixGraph::kNoStrip);
    REQUIRE(second != MixGraph::kNoStrip);
    REQUIRE(main != MixGraph::kNoStrip);

    constexpr int samples = 16;
    constexpr size_t latency = 3;
    MixRenderer renderer;
    renderer.prepare(48000.0, samples, graph.strips.size(), graph.edges.size());
    std::vector<MixStripProcessor> stripProcessors(graph.strips.size());
    std::vector<MixEdgeDelay> edgeDelays(graph.edges.size());
    TestDelay slowStrip(latency);
    TestDelay fastEdge(latency);
    stripProcessors[first] = {&slowStrip, processTestStripDelay};
    for (size_t i = 0; i < graph.edges.size(); ++i) {
        if (graph.edges[i].from == second && graph.edges[i].to == main)
            edgeDelays[i] = {&fastEdge, processTestEdgeDelay};
    }

    renderer.beginBlock(graph, samples);
    renderer.sourceChannel(first, 0)[0] = 1.0f;
    renderer.sourceChannel(first, 1)[0] = 1.0f;
    renderer.sourceChannel(second, 0)[0] = 2.0f;
    renderer.sourceChannel(second, 1)[0] = 2.0f;
    renderer.process(graph, samples,
                     {stripProcessors.data(), stripProcessors.size(),
                      edgeDelays.data(), edgeDelays.size()});

    for (size_t i = 0; i < latency; ++i) {
        CHECK(renderer.postChannel(main, 0)[i] == doctest::Approx(0.0f));
        CHECK(renderer.postChannel(main, 1)[i] == doctest::Approx(0.0f));
    }
    CHECK(renderer.postChannel(main, 0)[latency] == doctest::Approx(3.0f));
    CHECK(renderer.postChannel(main, 1)[latency] == doctest::Approx(3.0f));
}

TEST_CASE("renderer: polarity mask negates channels independently and pre-insert") {
    Project p = twoTrackProject();
    p.tracks[0].polarity = PolarityMask::Left;
    p.tracks[1].polarity = PolarityMask::Both;

    const MixGraph g = buildMixGraph(p, stereoOut());
    const uint32_t t1 = g.find("audio::track:1");
    const uint32_t t2 = g.find("audio::track:2");
    REQUIRE(t1 != MixGraph::kNoStrip);
    REQUIRE(t2 != MixGraph::kNoStrip);

    constexpr int samples = 32;
    MixRenderer renderer;
    renderer.prepare(48000.0, samples, g.strips.size(), g.edges.size());
    renderer.beginBlock(g, samples);
    for (int i = 0; i < samples; ++i) {
        renderer.sourceChannel(t1, 0)[i] = 1.0f;
        renderer.sourceChannel(t1, 1)[i] = 1.0f;
        renderer.sourceChannel(t2, 0)[i] = 1.0f;
        renderer.sourceChannel(t2, 1)[i] = 1.0f;
    }
    renderer.process(g, samples);

    CHECK(renderer.postChannel(t1, 0)[0] == doctest::Approx(-1.0f));
    CHECK(renderer.postChannel(t1, 1)[0] == doctest::Approx(1.0f));
    CHECK(renderer.postChannel(t2, 0)[0] == doctest::Approx(-1.0f));
    CHECK(renderer.postChannel(t2, 1)[0] == doctest::Approx(-1.0f));
}

TEST_CASE("renderer: SendTap PreFader, PostFader, and PostPan signal behavior") {
    Project p = twoTrackProject();
    p.tracks[0].gainDb = -6.0205999; // linear ~0.5
    p.tracks[0].pan = -1.0; // hard left
    p.tracks[0].output.type = OutputType::SendsOnly;

    // Create 3 send busses
    for (int i = 1; i <= 3; ++i) {
        SendBus bus;
        bus.id = "audio::send:" + std::to_string(i);
        bus.channels = 2;
        bus.output.type = OutputType::ExtOut;
        bus.output.target = "audio::out:1,audio::out:2";
        p.sends.push_back(bus);
    }

    // Send 1: Pre-Fader
    SendConfig sPre;
    sPre.bus = "audio::send:1";
    sPre.level = 100.0;
    sPre.tap = SendTap::PreFader;
    p.tracks[0].output.sends.push_back(sPre);

    // Send 2: Post-Fader (pre-pan)
    SendConfig sPostFader;
    sPostFader.bus = "audio::send:2";
    sPostFader.level = 100.0;
    sPostFader.tap = SendTap::PostFader;
    p.tracks[0].output.sends.push_back(sPostFader);

    // Send 3: Post-Pan
    SendConfig sPostPan;
    sPostPan.bus = "audio::send:3";
    sPostPan.level = 100.0;
    sPostPan.tap = SendTap::PostPan;
    p.tracks[0].output.sends.push_back(sPostPan);

    const MixGraph g = buildMixGraph(p, stereoOut());
    const uint32_t t1 = g.find("audio::track:1");
    const uint32_t send1 = g.find("audio::send:1");
    const uint32_t send2 = g.find("audio::send:2");
    const uint32_t send3 = g.find("audio::send:3");
    REQUIRE(t1 != MixGraph::kNoStrip);
    REQUIRE(send1 != MixGraph::kNoStrip);
    REQUIRE(send2 != MixGraph::kNoStrip);
    REQUIRE(send3 != MixGraph::kNoStrip);

    constexpr int samples = 32;
    MixRenderer renderer;
    renderer.prepare(48000.0, samples, g.strips.size(), g.edges.size());
    renderer.beginBlock(g, samples);
    for (int i = 0; i < samples; ++i) {
        renderer.sourceChannel(t1, 0)[i] = 1.0f;
        renderer.sourceChannel(t1, 1)[i] = 1.0f;
    }
    renderer.process(g, samples);

    // Pre-Fader: bypasses fader (-6dB) and pan (-1.0), so both channels are 1.0
    CHECK(renderer.postChannel(send1, 0)[0] == doctest::Approx(1.0f).epsilon(1e-3));
    CHECK(renderer.postChannel(send1, 1)[0] == doctest::Approx(1.0f).epsilon(1e-3));

    // Post-Fader: applies fader (-6dB ~ 0.5) but bypasses pan (-1.0), so both channels are ~0.5
    CHECK(renderer.postChannel(send2, 0)[0] == doctest::Approx(0.5f).epsilon(1e-3));
    CHECK(renderer.postChannel(send2, 1)[0] == doctest::Approx(0.5f).epsilon(1e-3));

    // Post-Pan: applies fader (-6dB ~ 0.5) AND pan (-1.0 hard left), so Left is ~0.5, Right is 0.0
    CHECK(renderer.postChannel(send3, 0)[0] == doctest::Approx(0.5f).epsilon(1e-3));
    CHECK(renderer.postChannel(send3, 1)[0] == doctest::Approx(0.0f).epsilon(1e-3));
}
