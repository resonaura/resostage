#include "doctest.h"

#include "audio/MixMath.h"
#include "audio/MixRenderer.h"

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
    renderer.prepare(48000.0, kBlock, graph.strips.size());

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

const StripLevels& levelOf(const MixGraph& g, const MixResult& r, const std::string& id) {
    return r.levels[g.find(id)];
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
    renderer.prepare(48000.0, kBlock, g.strips.size());

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
    renderer.prepare(48000.0, kBlock, g.strips.size() - 1);
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

    void prepare(const MixGraph& g) { renderer.prepare(48000.0, kBlock, g.strips.size() + 4); }

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
    renderer.prepare(48000.0, kBlock, g.strips.size());

    CHECK(renderer.canRender(g, kBlock));
    CHECK(renderer.canRender(g, kBlock / 2));
    CHECK_FALSE(renderer.canRender(g, kBlock * 8));
    CHECK_FALSE(renderer.canRender(g, 0));
    CHECK(renderer.maxBlockSize() == kBlock);

    // ...and after being re-prepared for the bigger block, it accepts it.
    renderer.prepare(48000.0, kBlock * 8, g.strips.size());
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
    renderer.prepare(48000.0, 512, g.strips.size());

    for (const int block : {512, 1024, 2048, 4096, 2048, 1024, 512, 4096}) {
        // What ensureScratchSizes() does on a device restart: grow to the new
        // block before the first callback at that size arrives, and never
        // shrink -- see the next test.
        if (renderer.maxBlockSize() < block)
            renderer.prepare(48000.0, block, g.strips.size());
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
    renderer.prepare(48000.0, 4096, g.strips.size());

    CHECK(renderer.canRender(g, 512));
    CHECK(renderer.canRender(g, 4096));
    CHECK(renderer.maxBlockSize() == 4096);
}
