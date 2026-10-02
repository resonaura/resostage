/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "audio/graph/MixGraph.h"
#include "audio/graph/MixRenderer.h"
#include "automation/StripAutomationPlan.h"
#include "timing/TempoMap.h"

#include <algorithm>
#include <cmath>
#include <limits>

using namespace resostage;

namespace {
constexpr int kSamples = 256;

Project automationProject() {
    Project project;
    project.click.enabled = false;
    project.main.output.type = OutputType::ExtOut;
    project.main.output.target = "audio::out:1,audio::out:2";
    TrackDef track;
    track.id = "audio::track:1";
    track.output.type = OutputType::Main;
    project.tracks.push_back(track);
    project.songs.push_back(SongDef{});
    return project;
}

AutomationLane envelope(const char* parameter, float value) {
    AutomationLane lane;
    lane.target.domain = AutomationDomain::Strip;
    lane.target.entityId = "audio::track:1";
    lane.target.parameterId = parameter;
    lane.target.minValue = parameter == std::string_view("pan") ? -1.0f : -60.0f;
    lane.target.maxValue = parameter == std::string_view("pan") ? 1.0f : 12.0f;
    lane.points.push_back({0.0, value, 0.0f});
    return lane;
}

MixGraph preparedGraph(const Project& project) {
    OutputLaneConfig output;
    output.totalChannels = 2;
    auto graph = buildMixGraph(project, output);
    std::string error;
    graph.stripAutomation = StripAutomationPlan::prepare(project, graph, error);
    REQUIRE(error.empty());
    REQUIRE(graph.stripAutomation != nullptr);
    return graph;
}

// Caller-owned scratch mimics the device callback, including its ordering:
// beginBlock -> prepared scalar intents -> source audio -> one renderer sweep.
struct AutomationRender {
    explicit AutomationRender(const MixGraph& graph) {
        renderer.prepare(48000.0, kSamples, graph.strips.size(), graph.edges.size());
    }
    void block(const MixGraph& graph, size_t songIndex, double beat, bool apply = true,
               int samples = kSamples) {
        renderer.beginBlock(graph, samples);
        if (apply) graph.stripAutomation->apply(songIndex, beat, renderer);
        const auto track = graph.find("audio::track:1");
        std::fill_n(renderer.sourceChannel(track, 0), samples, 0.25f);
        std::fill_n(renderer.sourceChannel(track, 1), samples, 0.25f);
        renderer.process(graph, samples);
        left = renderer.postChannel(track, 0)[samples - 1];
        right = renderer.postChannel(track, 1)[samples - 1];
    }
    void settle(const MixGraph& graph, size_t songIndex, double beat, bool apply = true) {
        for (int i = 0; i < 40; ++i) block(graph, songIndex, beat, apply);
    }
    MixRenderer renderer;
    float left = 0.0f;
    float right = 0.0f;
};
} // namespace

TEST_SUITE("StripAutomation") {

TEST_CASE("prepared gain and pan envelopes change actual audio without changing manual state") {
    auto project = automationProject();
    project.songs[0].automationLanes = {envelope("faderGainDb", -6.0206f), envelope("pan", 1.0f)};
    auto graph = preparedGraph(project);
    REQUIRE(graph.stripAutomation->bindingCount(0) == 2);
    AutomationRender audio(graph);
    audio.settle(graph, 0, 0.0);
    CHECK(audio.left == doctest::Approx(0.0f).epsilon(1e-5));
    CHECK(audio.right == doctest::Approx(0.125f).epsilon(1e-5));
    CHECK(project.tracks[0].gainDb == 0.0);
    CHECK(project.tracks[0].pan == 0.0);
    CHECK(graph.strips[graph.find("audio::track:1")].gainLinear == 1.0f);
    CHECK(graph.strips[graph.find("audio::track:1")].pan == 0.0f);

    // Stopped/disabled automation clears its block intent and glides back to
    // the manual coefficient instead of retaining a stale override forever.
    audio.settle(graph, 0, 0.0, false);
    CHECK(audio.left == doctest::Approx(0.25f).epsilon(1e-5));
    CHECK(audio.right == doctest::Approx(0.25f).epsilon(1e-5));
}

TEST_CASE("empty disabled muted unbound and unsupported lanes leave manual coefficients alone") {
    auto project = automationProject();
    auto empty = envelope("faderGainDb", -24.0f);
    empty.points.clear();
    auto disabled = envelope("faderGainDb", -24.0f);
    disabled.enabled = false;
    auto muted = envelope("pan", 1.0f);
    muted.muted = true;
    auto unbound = envelope("pan", 1.0f);
    unbound.target.entityId = "audio::track:removed";
    auto region = envelope("pan", 1.0f);
    region.scope = AutomationScope::Region;
    project.songs[0].automationLanes = {empty, disabled, muted, unbound, region,
                                        envelope("unsupported", 1.0f)};
    auto graph = preparedGraph(project);
    CHECK(graph.stripAutomation->bindingCount(0) == 0);
    CHECK(graph.stripAutomation->bindingCount(10) == 0);
    AutomationRender audio(graph);
    audio.settle(graph, 0, 0.0);
    CHECK(audio.left == doctest::Approx(0.25f));
    CHECK(audio.right == doctest::Approx(0.25f));
}

TEST_CASE("mute automation smoothly silences track and unmutes without clicks") {
    auto project = automationProject();
    auto muteLane = envelope("mute", 1.0f);
    muteLane.points = {{0.0, 1.0f, 0.0f}, {4.0, 0.0f, 0.0f}};
    project.songs[0].automationLanes = {muteLane};
    auto graph = preparedGraph(project);
    REQUIRE(graph.stripAutomation->bindingCount(0) == 1);
    AutomationRender audio(graph);

    const auto track = graph.find("audio::track:1");
    const auto mainStrip = graph.find("audio::main");
    REQUIRE(mainStrip != MixGraph::kNoStrip);

    // At beat 0, track is muted by automation: main mix receives 0, track strip still meters
    audio.settle(graph, 0, 0.0);
    CHECK(audio.renderer.postChannel(mainStrip, 0)[kSamples - 1] == doctest::Approx(0.0f).epsilon(1e-4));
    CHECK(audio.renderer.postChannel(mainStrip, 1)[kSamples - 1] == doctest::Approx(0.0f).epsilon(1e-4));
    CHECK(audio.left == doctest::Approx(0.25f).epsilon(1e-4));
    CHECK(audio.right == doctest::Approx(0.25f).epsilon(1e-4));
    CHECK(project.tracks[0].mute == false);
    CHECK(graph.strips[track].mute == false);

    // At beat 4, track is unmuted by automation: main mix receives audio
    audio.settle(graph, 0, 4.0);
    CHECK(audio.renderer.postChannel(mainStrip, 0)[kSamples - 1] == doctest::Approx(0.25f).epsilon(1e-4));
    CHECK(audio.renderer.postChannel(mainStrip, 1)[kSamples - 1] == doctest::Approx(0.25f).epsilon(1e-4));
    CHECK(audio.left == doctest::Approx(0.25f).epsilon(1e-4));
    CHECK(audio.right == doctest::Approx(0.25f).epsilon(1e-4));

    // When automation is stopped/cleared, audio remains at manual state (unmuted)
    audio.settle(graph, 0, 0.0, false);
    CHECK(audio.renderer.postChannel(mainStrip, 0)[kSamples - 1] == doctest::Approx(0.25f).epsilon(1e-4));
    CHECK(audio.renderer.postChannel(mainStrip, 1)[kSamples - 1] == doctest::Approx(0.25f).epsilon(1e-4));
}

TEST_CASE("aux send automation smoothly modifies send edge gain") {
    auto project = automationProject();
    SendBus sendBus;
    sendBus.id = "audio::send:1";
    sendBus.name = "Reverb";
    project.sends.push_back(sendBus);

    SendConfig sendConfig;
    sendConfig.bus = "audio::send:1";
    sendConfig.level = 100.0;
    sendConfig.enabled = true;
    project.tracks[0].output.sends.push_back(sendConfig);

    auto sendLane = envelope("send:0", 0.5f);
    sendLane.target.minValue = 0.0f;
    sendLane.target.maxValue = 1.0f;
    sendLane.points = {{0.0, 0.5f, 0.0f}, {4.0, 0.0f, 0.0f}};
    project.songs[0].automationLanes = {sendLane};

    auto graph = preparedGraph(project);
    REQUIRE(graph.stripAutomation->bindingCount(0) == 1);

    AutomationRender audio(graph);
    const auto track = graph.find("audio::track:1");
    const auto sendStrip = graph.find("audio::send:1");
    REQUIRE(sendStrip != MixGraph::kNoStrip);

    // At beat 0, send level is automated to 0.5
    for (int i = 0; i < 40; ++i) {
        audio.renderer.beginBlock(graph, kSamples);
        graph.stripAutomation->apply(0, 0.0, audio.renderer);
        std::fill_n(audio.renderer.sourceChannel(track, 0), kSamples, 0.25f);
        std::fill_n(audio.renderer.sourceChannel(track, 1), kSamples, 0.25f);
        audio.renderer.process(graph, kSamples);
    }
    CHECK(audio.renderer.postChannel(sendStrip, 0)[kSamples - 1] == doctest::Approx(0.125f).epsilon(1e-4));
    CHECK(audio.renderer.postChannel(sendStrip, 1)[kSamples - 1] == doctest::Approx(0.125f).epsilon(1e-4));

    // At beat 4, send level is automated to 0.0
    for (int i = 0; i < 40; ++i) {
        audio.renderer.beginBlock(graph, kSamples);
        graph.stripAutomation->apply(0, 4.0, audio.renderer);
        std::fill_n(audio.renderer.sourceChannel(track, 0), kSamples, 0.25f);
        std::fill_n(audio.renderer.sourceChannel(track, 1), kSamples, 0.25f);
        audio.renderer.process(graph, kSamples);
    }
    CHECK(audio.renderer.postChannel(sendStrip, 0)[kSamples - 1] == doctest::Approx(0.0f).epsilon(1e-4));
    CHECK(audio.renderer.postChannel(sendStrip, 1)[kSamples - 1] == doctest::Approx(0.0f).epsilon(1e-4));
}

TEST_CASE("plan owns points and preserves curve and first matching lane semantics") {
    auto project = automationProject();
    auto pan = envelope("pan", -1.0f);
    pan.points = {{0.0, -1.0f, 1.0f}, {4.0, 1.0f, 0.0f}};
    project.songs[0].automationLanes = {pan, envelope("pan", 0.0f)};
    auto graph = preparedGraph(project);
    REQUIRE(graph.stripAutomation->bindingCount(0) == 1);
    project.songs[0].automationLanes.clear();
    AutomationRender audio(graph);
    audio.settle(graph, 0, 1.0);
    // Curve=+1 makes normalized t=.25 become .25^(.25), giving pan≈.4142.
    const float expectedPan = 2.0f * std::pow(0.25f, 0.25f) - 1.0f;
    CHECK(audio.left == doctest::Approx(0.25f * (1.0f - expectedPan)).epsilon(1e-5));
    CHECK(audio.right == doctest::Approx(0.25f).epsilon(1e-5));
}

TEST_CASE("send automation binds only its aux edge beside a direct route to the same bus") {
    auto project = automationProject();
    SendBus sendBus;
    sendBus.id = "audio::send:1";
    project.sends.push_back(sendBus);
    auto& output = project.tracks[0].output;
    output.type = OutputType::Bus;
    output.target = sendBus.id;
    SendConfig send;
    send.bus = sendBus.id;
    send.level = 100.0;
    output.sends.push_back(send);
    auto lane = envelope("send:audio::send:1", 0.0f);
    lane.target.minValue = 0.0f;
    lane.target.maxValue = 1.0f;
    project.songs[0].automationLanes = {lane};
    const auto graph = preparedGraph(project);
    REQUIRE(graph.stripAutomation->bindingCount(0) == 1);
    const auto track = graph.find("audio::track:1");
    const auto bus = graph.find(sendBus.id);
    size_t directCount = 0, sendCount = 0;
    for (const auto& edge : graph.edges) {
        if (edge.from != track || edge.to != bus) continue;
        if (edge.sendIndex == MixEdge::kNoSend) ++directCount;
        else {
            CHECK(edge.sendIndex == 0);
            ++sendCount;
        }
    }
    CHECK(directCount == 1);
    CHECK(sendCount == 1);
    AutomationRender audio(graph);
    audio.settle(graph, 0, 0.0);
    // Only the aux is zeroed. The independent full-gain direct route survives.
    CHECK(audio.renderer.postChannel(bus, 0)[kSamples - 1]
          == doctest::Approx(0.25f).epsilon(1e-4));
}

TEST_CASE("stable send bus identity survives reordering and rejects ambiguous or missing taps") {
    auto project = automationProject();
    for (const char* id : {"audio::send:1", "audio::send:2"}) {
        SendBus bus;
        bus.id = id;
        project.sends.push_back(bus);
        SendConfig send;
        send.bus = id;
        send.level = 100.0;
        project.tracks[0].output.sends.push_back(send);
    }
    auto lane = envelope("send:audio::send:1", 0.0f);
    lane.target.minValue = 0.0f;
    lane.target.maxValue = 1.0f;
    project.songs[0].automationLanes = {lane};
    SUBCASE("send order changes") {
        std::swap(project.tracks[0].output.sends[0], project.tracks[0].output.sends[1]);
        const auto graph = preparedGraph(project);
        REQUIRE(graph.stripAutomation->bindingCount(0) == 1);
        AutomationRender audio(graph);
        audio.settle(graph, 0, 0.0);
        CHECK(audio.renderer.postChannel(graph.find("audio::send:1"), 0)[kSamples - 1]
              == doctest::Approx(0.0f).epsilon(1e-4));
        CHECK(audio.renderer.postChannel(graph.find("audio::send:2"), 0)[kSamples - 1]
              == doctest::Approx(0.25f).epsilon(1e-4));
    }
    SUBCASE("duplicate enabled bus references") {
        project.tracks[0].output.sends.push_back(project.tracks[0].output.sends[0]);
        const auto graph = preparedGraph(project);
        CHECK(graph.stripAutomation->bindingCount(0) == 0);
    }
    SUBCASE("disabled send cannot automate the remaining direct route") {
        project.tracks[0].output.type = OutputType::Bus;
        project.tracks[0].output.target = "audio::send:1";
        project.tracks[0].output.sends[0].enabled = false;
        const auto graph = preparedGraph(project);
        CHECK(graph.stripAutomation->bindingCount(0) == 0);
    }
    SUBCASE("numeric legacy slot remains exact among duplicate bus taps") {
        project.tracks[0].output.sends.push_back(project.tracks[0].output.sends[0]);
        project.songs[0].automationLanes[0].target.parameterId = "send:2";
        const auto graph = preparedGraph(project);
        CHECK(graph.stripAutomation->bindingCount(0) == 1);
        AutomationRender audio(graph);
        audio.settle(graph, 0, 0.0);
        CHECK(audio.renderer.postChannel(graph.find("audio::send:1"), 0)[kSamples - 1]
              == doctest::Approx(0.25f).epsilon(1e-4));
    }
    SUBCASE("oversized numeric legacy suffix is unbound without throwing") {
        project.songs[0].automationLanes[0].target.parameterId =
            "send:9999999999999999999999999999999999999999";
        const auto graph = preparedGraph(project);
        CHECK(graph.stripAutomation->bindingCount(0) == 0);
    }
    SUBCASE("bus identity without configured aux send stays unbound") {
        project.tracks[0].output.sends.erase(project.tracks[0].output.sends.begin());
        const auto graph = preparedGraph(project);
        CHECK(graph.stripAutomation->bindingCount(0) == 0);
    }
}

TEST_CASE("absolute source beats handle tempo changes seeks song switches and ten thousand cycles") {
    auto project = automationProject();
    auto pan = envelope("pan", -1.0f);
    pan.points = {{0.0, -1.0f, 0.0f}, {8.0, 1.0f, 0.0f}};
    project.songs[0].automationLanes.push_back(pan);
    project.songs.push_back(SongDef{});
    project.songs[1].automationLanes.push_back(envelope("pan", 1.0f));
    auto graph = preparedGraph(project);
    const TempoMap tempo(120.0, {{0.0, 120.0}, {4.0, 60.0}});
    AutomationRender audio(graph);
    const double beatAtThreeSeconds = tempo.samplesToBeats(144000, 48000.0);
    CHECK(beatAtThreeSeconds == doctest::Approx(5.0));
    audio.settle(graph, 0, beatAtThreeSeconds);
    CHECK(audio.left == doctest::Approx(0.1875f).epsilon(1e-5));
    CHECK(audio.right == doctest::Approx(0.25f).epsilon(1e-5));
    audio.settle(graph, 1, 0.0);
    CHECK(audio.left == doctest::Approx(0.0f).epsilon(1e-5));

    // Each cycle is evaluated from absolute locator samples, even after a
    // backward seek and a song hop. The callback splits at those same bounds.
    for (int lap = 0; lap < 10000; ++lap) {
        audio.renderer.resetSmoothing();
        audio.block(graph, 0, tempo.samplesToBeats(96000, 48000.0), true, 13);
        CHECK(audio.left == doctest::Approx(0.25f).epsilon(1e-5));
        CHECK(audio.right == doctest::Approx(0.25f).epsilon(1e-5));
        audio.renderer.resetSmoothing();
        audio.block(graph, 0, tempo.samplesToBeats(0, 48000.0), true, 7);
        CHECK(audio.left == doctest::Approx(0.25f).epsilon(1e-5));
        CHECK(audio.right == doctest::Approx(0.0f).epsilon(1e-5));
    }
}

TEST_CASE("automation retains coefficient smoothing and invalid override protection") {
    auto project = automationProject();
    project.songs[0].automationLanes = {envelope("pan", 1.0f)};
    auto graph = preparedGraph(project);
    AutomationRender audio(graph);
    audio.block(graph, 0, 0.0, false);
    audio.block(graph, 0, 0.0);
    CHECK(audio.left > 0.0f);
    CHECK(audio.left < 0.25f);
    audio.settle(graph, 0, 0.0);
    CHECK(audio.left < 1.0e-5f);
    audio.renderer.beginBlock(graph, kSamples);
    audio.renderer.setAutomationGain(0, std::numeric_limits<float>::infinity());
    audio.renderer.setAutomationPan(0, std::numeric_limits<float>::quiet_NaN());
    audio.renderer.setAutomationGain(100000, 1.0f);
    audio.renderer.setAutomationPan(100000, 1.0f);
    audio.settle(graph, 0, 0.0, false);
    CHECK(audio.left == doctest::Approx(0.25f).epsilon(1e-5));
}

TEST_CASE("malformed envelopes fail preparation and physical bounds contain imported gain") {
    auto project = automationProject();
    project.songs[0].automationLanes = {envelope("faderGainDb", -6.0f)};
    auto graph = preparedGraph(project);
    std::string error;
    SUBCASE("unordered points") {
        project.songs[0].automationLanes[0].points = {{1.0, 0.0f, 0.0f}, {0.0, 1.0f, 0.0f}};
        CHECK(StripAutomationPlan::prepare(project, graph, error) == nullptr);
        CHECK_FALSE(error.empty());
    }
    SUBCASE("nonfinite value") {
        project.songs[0].automationLanes[0].points[0].value = std::numeric_limits<float>::infinity();
        CHECK(StripAutomationPlan::prepare(project, graph, error) == nullptr);
    }
    SUBCASE("song admission limit") {
        project.songs.resize(StripAutomationPlan::kMaximumSongs + 1);
        CHECK(StripAutomationPlan::prepare(project, graph, error) == nullptr);
    }
    SUBCASE("typed target clamp") {
        project.songs[0].automationLanes[0].points[0].value = -120.0f;
        graph = preparedGraph(project);
        AutomationRender audio(graph);
        audio.block(graph, 0, 0.0);
        CHECK(audio.right == doctest::Approx(0.00025f).epsilon(1e-5));
    }
}

TEST_CASE("StripAutomationPlan: Write mode suppresses playback so new values overwrite cleanly") {
    auto project = automationProject();
    auto lane = envelope("faderGainDb", -6.0206f);
    lane.writeMode = AutomationWriteMode::Write;
    project.songs[0].automationLanes = {lane};
    OutputLaneConfig output{.totalChannels = 2};
    auto graph = buildMixGraph(project, output);
    std::string error;
    graph.stripAutomation = StripAutomationPlan::prepare(project, graph, error);
    REQUIRE(error.empty());
    REQUIRE(graph.stripAutomation != nullptr);
    // In Write mode, the lane should not be bound to playback
    CHECK(graph.stripAutomation->bindingCount(0) == 0);

    // Switching writeMode back to Touch or Read enables playback
    project.songs[0].automationLanes[0].writeMode = AutomationWriteMode::Touch;
    graph.stripAutomation = StripAutomationPlan::prepare(project, graph, error);
    REQUIRE(error.empty());
    CHECK(graph.stripAutomation->bindingCount(0) == 1);
}

} // TEST_SUITE
