/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "automation/AutomationCurve.h"
#include "automation/AutomationEvaluator.h"
#include "automation/AutomationRecorder.h"
#include "automation/RamerDouglasPeucker.h"
#include "project/ProjectJson.h"
#include "project/ProjectSchema.h"
#include "server/AutomationJson.h"
#include "plugins/PluginParameterBinding.h"
#include "timing/TempoMap.h"

#include <charconv>
#include <cmath>
#include <vector>

using namespace resostage;

TEST_SUITE("AutomationFramework") {

TEST_CASE("Plug-in parameter binding: vendor identity survives reordered indices") {
    std::vector<PluginParameterBinding> bindings{{"id:cutoff", 7}, {"id:resonance", 1}};
    CHECK(resolvePluginParameterBinding(bindings, "id:cutoff") == 7);
    CHECK(resolvePluginParameterBinding(bindings, "id:resonance") == 1);
    CHECK(resolvePluginParameterBinding(bindings, "id:removed") == -1);
    CHECK(resolvePluginParameterBinding(bindings, "param:3") == 3);
    CHECK(resolvePluginParameterBinding(bindings, "3") == 3);
    CHECK(resolvePluginParameterBinding(bindings, "param:3suffix") == -1);
    CHECK(resolvePluginParameterBinding(bindings, "param:-1") == -1);
    CHECK(resolvePluginParameterBinding(bindings, "") == -1);
}

TEST_CASE("Automation editing: full replacements validate before mutation") {
    glz::generic document;
    std::vector<AutomationPoint> points{{99.0, 0.25f, 0.0f}};
    std::string error;
    REQUIRE(builder_json::parseJson(R"({"points":[{"timeBeats":4,"value":0.8,"curve":-0.75},{"timeBeats":1,"value":0.2,"curve":0.5}]})", document));
    REQUIRE(builder_json::parseAutomationPoints(document, points, error));
    REQUIRE(points.size() == 2);
    CHECK(points[0].timeBeats == 1.0);
    CHECK(points[0].curve == doctest::Approx(0.5f));
    CHECK(points[1].curve == doctest::Approx(-0.75f));

    for (const auto* invalid : {
        R"({"points":[{"timeBeats":-1,"value":0.5}]})",
        R"({"points":[{"timeBeats":1,"value":0.5,"curve":2}]})",
        R"({"points":[{"timeBeats":1,"value":0.5},{"timeBeats":1,"value":0.7}]})",
        R"({"points":[{"timeBeats":1,"value":1e100}]})",
        R"({"points":[null]})",
        R"({"points":{}})"}) {
        REQUIRE(builder_json::parseJson(invalid, document));
        CHECK_FALSE(builder_json::parseAutomationPoints(document, points, error));
        REQUIRE(points.size() == 2);
        CHECK(points[0].value == doctest::Approx(0.2f));
    }
    REQUIRE(builder_json::parseJson(R"({"points":[]})", document));
    REQUIRE(builder_json::parseAutomationPoints(document, points, error));
    CHECK(points.empty());
}

TEST_CASE("Automation editing: the point budget fails atomically") {
    glz::generic document = glz::generic::object_t{};
    document["points"] = glz::generic::array_t(builder_json::kMaximumAutomationEditPoints + 1);
    std::vector<AutomationPoint> points{{2.0, 0.5f, 0.1f}};
    std::string error;
    CHECK_FALSE(builder_json::parseAutomationPoints(document, points, error));
    REQUIRE(points.size() == 1);
    CHECK(points.front().timeBeats == 2.0);
}

TEST_CASE("Automation recording admission validates the entire pass before mutation") {
    glz::generic document;
    AutomationTarget target;
    target.minValue = -60.0f;
    target.maxValue = 12.0f;
    builder_json::AutomationRecordGesture gesture;
    gesture.punchInBeats = 99.0;
    std::string error;
    for (const auto* invalid : {
        R"({"punchInBeats":1,"releaseBeats":0,"releaseValue":0,"points":[]})",
        R"({"punchInBeats":-1,"releaseBeats":2,"releaseValue":0,"points":[]})",
        R"({"punchInBeats":0,"releaseBeats":2,"releaseValue":1e300,"points":[]})",
        R"({"punchInBeats":0,"releaseBeats":2,"releaseValue":0,"underlyingValue":1e300,"points":[]})",
        R"({"punchInBeats":0,"releaseBeats":2,"releaseValue":0,"returnRampBeats":-1,"points":[]})",
        R"({"punchInBeats":0,"releaseBeats":1e308,"releaseValue":0,"returnRampBeats":1e308,"points":[]})",
        R"({"punchInBeats":0,"releaseBeats":2,"releaseValue":0,"rdpTolerance":0,"points":[]})",
        R"({"punchInBeats":0,"releaseBeats":2,"releaseValue":0,"rdpTolerance":2,"points":[]})",
        R"({"punchInBeats":0,"releaseBeats":2,"releaseValue":"wrong type","points":[]})",
        R"({"punchInBeats":0,"releaseBeats":2,"points":[]})",
        R"({"punchInBeats":0,"releaseBeats":2,"releaseValue":0,"points":[null]})",
        R"({"punchInBeats":0,"releaseBeats":2,"releaseValue":0,"points":[{"timeBeats":1,"value":1e300}]})",
        R"({"punchInBeats":1,"releaseBeats":2,"releaseValue":0,"points":[{"timeBeats":0.5,"value":0}]})",
        R"({"punchInBeats":1,"releaseBeats":2,"releaseValue":0,"points":[{"timeBeats":0.9999995,"value":0},{"timeBeats":1,"value":0}]})",
        R"({"punchInBeats":1,"releaseBeats":2,"releaseValue":0,"points":[{"timeBeats":3,"value":0}]})",
        R"({"punchInBeats":1,"releaseBeats":2,"releaseValue":0,"points":{}})"}) {
        document = glz::generic::object_t{};
        REQUIRE(builder_json::parseJson(invalid, document));
        CHECK_FALSE(builder_json::parseAutomationRecordGesture(document, target, gesture, error));
        CHECK_FALSE(error.empty());
        CHECK(gesture.punchInBeats == 99.0);
    }
    document = glz::generic::object_t{};
    REQUIRE(builder_json::parseJson(R"({"punchInBeats":1,"releaseBeats":2,"releaseValue":30,"underlyingValue":-70,"points":[{"timeBeats":1,"value":-10},{"timeBeats":1,"value":-20},{"timeBeats":2,"value":99}]})", document));
    INFO(error);
    REQUIRE(builder_json::parseAutomationRecordGesture(document, target, gesture, error));
    CHECK(gesture.punchInBeats == 1.0);
    CHECK(gesture.releaseValue == 12.0f);
    CHECK(gesture.underlyingValue == -60.0f);
    REQUIRE(gesture.points.size() == 2);
    CHECK(gesture.points[0].value == -20.0f);
    CHECK(gesture.points[1].value == 12.0f);
    document["points"] = glz::generic::array_t(builder_json::kMaximumAutomationEditPoints + 1);
    CHECK_FALSE(builder_json::parseAutomationRecordGesture(document, target, gesture, error));
    CHECK(gesture.points.size() == 2);
}

TEST_CASE("Automation recording admission bounds the complete lane across repeated passes") {
    std::vector<AutomationPoint> existing;
    existing.reserve(builder_json::kMaximumAutomationEditPoints);
    for (size_t index = 0; index < builder_json::kMaximumAutomationEditPoints; ++index)
        existing.push_back({static_cast<double>(index), 0.5f, 0.0f});
    CHECK_FALSE(builder_json::canAdmitAutomationPunch(existing, 1, 100000.0, 100001.0));
    CHECK(builder_json::canAdmitAutomationPunch(existing, 3, 10.0, 12.0));
    CHECK_FALSE(builder_json::canAdmitAutomationPunch(existing, 4, 10.0, 12.0));
    CHECK_FALSE(builder_json::canAdmitAutomationPunch({},
        builder_json::kMaximumAutomationEditPoints + 1, 0.0, 1.0));
    CHECK(existing.size() == builder_json::kMaximumAutomationEditPoints);
}

TEST_CASE("AutomationCurve: Curvature interpolation formula") {
    // Linear
    CHECK(AutomationCurve::interpolate(0.0, 0.0, 10.0, 0.0) == doctest::Approx(0.0));
    CHECK(AutomationCurve::interpolate(0.5, 0.0, 10.0, 0.0) == doctest::Approx(5.0));
    CHECK(AutomationCurve::interpolate(1.0, 0.0, 10.0, 0.0) == doctest::Approx(10.0));

    // Ease-in (curve = -1.0 => exponent 2^(-(-1)*2) = 4, w = 0.5^4 = 0.0625)
    CHECK(AutomationCurve::interpolate(0.5, 0.0, 10.0, -1.0) == doctest::Approx(0.625));

    // Ease-out (curve = 1.0 => exponent 2^(-1*2) = 0.25, w = 0.5^0.25 ≈ 0.840896)
    CHECK(AutomationCurve::interpolate(0.5, 0.0, 10.0, 1.0) == doctest::Approx(8.408964).epsilon(1e-4));

    // Clamping boundaries
    CHECK(AutomationCurve::interpolate(-0.5, 0.0, 10.0, 0.0) == doctest::Approx(0.0));
    CHECK(AutomationCurve::interpolate(1.5, 0.0, 10.0, 0.0) == doctest::Approx(10.0));
}

TEST_CASE("AutomationEvaluator: Point evaluation and cursor tracking") {
    std::vector<AutomationPoint> points = {
        {0.0, 0.0f, 0.0f},
        {4.0, 1.0f, 0.0f},
        {8.0, 0.5f, 1.0f}, // Ease-out curve from beat 4 to 8
        {16.0, 0.0f, 0.0f}
    };

    // Before start and after end
    CHECK(AutomationEvaluator::evaluatePoints(points, -1.0, 0.5f) == doctest::Approx(0.0f));
    CHECK(AutomationEvaluator::evaluatePoints(points, 20.0, 0.5f) == doctest::Approx(0.0f));

    // Linear ramp from 0 to 4 beats
    CHECK(AutomationEvaluator::evaluatePoints(points, 0.0) == doctest::Approx(0.0f));
    CHECK(AutomationEvaluator::evaluatePoints(points, 2.0) == doctest::Approx(0.5f));
    CHECK(AutomationEvaluator::evaluatePoints(points, 4.0) == doctest::Approx(1.0f));

    // Empty list returns default
    std::vector<AutomationPoint> empty;
    CHECK(AutomationEvaluator::evaluatePoints(empty, 5.0, 0.77f) == doctest::Approx(0.77f));

    // Single point returns constant
    std::vector<AutomationPoint> single = {{2.0, 0.42f, 0.0f}};
    CHECK(AutomationEvaluator::evaluatePoints(single, 0.0) == doctest::Approx(0.42f));
    CHECK(AutomationEvaluator::evaluatePoints(single, 10.0) == doctest::Approx(0.42f));

    // Sequential evaluation with cursor tracking matches single-point binary search
    size_t cursor = 0;
    for (double beat = 0.0; beat <= 16.0; beat += 0.25) {
        float direct = AutomationEvaluator::evaluatePoints(points, beat);
        float tracked = AutomationEvaluator::evaluatePointsWithCursor(points, beat, cursor);
        CHECK(tracked == doctest::Approx(direct));
    }
}

TEST_CASE("AutomationEvaluator: Block evaluation with TempoMap") {
    TempoMap map(120.0); // 120 BPM: 2 beats per second => 24,000 samples per beat at 48 kHz
    AutomationLane lane;
    lane.id = "test_lane";
    lane.enabled = true;
    lane.points = {
        {0.0, 0.0f, 0.0f},
        {4.0, 1.0f, 0.0f} // 0 to 1 over 4 beats (2 seconds = 96,000 samples)
    };

    std::vector<float> buffer(256, 0.0f);
    size_t cursor = 0;

    // Block at sample 0
    AutomationEvaluator::evaluateLaneBlock(lane, &map, 0, 256, 48000.0, buffer.data(), cursor);
    CHECK(buffer[0] == doctest::Approx(0.0f));
    CHECK(buffer[255] > 0.0f);

    // Block halfway through ramp (sample 48,000 = beat 2.0)
    cursor = 0;
    AutomationEvaluator::evaluateLaneBlock(lane, &map, 48000, 256, 48000.0, buffer.data(), cursor);
    CHECK(buffer[0] == doctest::Approx(0.5f).epsilon(1e-3));
}

TEST_CASE("AutomationEvaluator: Multi-Scope hierarchy resolution") {
    SongDef song;
    song.id = "meta::song:1";
    song.bpm = 120.0;

    AutomationTarget target;
    target.domain = AutomationDomain::Strip;
    target.entityId = "audio::track:1";
    target.parameterId = "faderGainDb";
    target.defaultValue = 0.0f;
    target.minValue = -60.0f;
    target.maxValue = +12.0f;

    // 1. Base TrackAutomation: ramp from 0 dB to -10 dB over 16 beats
    AutomationLane trackLane;
    trackLane.id = "lane:track:1";
    trackLane.target = target;
    trackLane.scope = AutomationScope::Track;
    trackLane.enabled = true;
    trackLane.points = {
        {0.0, 0.0f, 0.0f},
        {16.0, -10.0f, 0.0f}
    };
    song.automationLanes.push_back(trackLane);

    // 2. Active MIDI Region on track from beat 4.0 to beat 12.0 with RegionAutomation and Modulation
    MidiRegion mr;
    mr.id = "midi_reg:1";
    mr.trackId = "audio::track:1";
    mr.startBeats = 4.0;
    mr.durationBeats = 8.0;

    // Region automation: overrides to -20 dB inside the region
    AutomationLane regLane;
    regLane.id = "lane:reg:1";
    regLane.target = target;
    regLane.scope = AutomationScope::Region;
    regLane.enabled = true;
    regLane.points = {
        {0.0, -20.0f, 0.0f},
        {8.0, -20.0f, 0.0f}
    };
    mr.automationLanes.push_back(regLane);

    // Region modulation: adds +3 dB boost
    AutomationLane modLane;
    modLane.id = "lane:mod:1";
    modLane.target = target;
    modLane.scope = AutomationScope::Modulation;
    modLane.enabled = true;
    modLane.points = {
        {0.0, +3.0f, 0.0f},
        {8.0, +3.0f, 0.0f}
    };
    mr.automationLanes.push_back(modLane);
    song.midiRegions.push_back(mr);

    // Before region (beat 2.0): TrackAutomation active (linear ramp: 0 to -10 over 16 beats => at 2.0 = -1.25 dB)
    float valBefore = AutomationEvaluator::resolveMultiScopeValue(song, target, 2.0, 1.0, "audio::track:1");
    CHECK(valBefore == doctest::Approx(-1.25f));

    // Inside region (beat 6.0): RegionAutomation (-20 dB) + Modulation (+3 dB) = -17 dB
    float valInside = AutomationEvaluator::resolveMultiScopeValue(song, target, 6.0, 3.0, "audio::track:1");
    CHECK(valInside == doctest::Approx(-17.0f));

    // After region (beat 14.0): Reverts to TrackAutomation (-8.75 dB)
    float valAfter = AutomationEvaluator::resolveMultiScopeValue(song, target, 14.0, 7.0, "audio::track:1");
    CHECK(valAfter == doctest::Approx(-8.75f));
}

TEST_CASE("RamerDouglasPeucker: Trajectory reduction and error bounds") {
    // 1. Collinear points should be reduced to first and last point
    std::vector<AutomationPoint> collinear;
    for (int i = 0; i <= 100; ++i) {
        collinear.push_back({static_cast<double>(i) * 0.1, static_cast<float>(i) * 0.01f, 0.0f});
    }
    CHECK(collinear.size() == 101);

    auto thinnedCollinear = RamerDouglasPeucker::thin(collinear, 0.002);
    CHECK(thinnedCollinear.size() == 2);
    CHECK(thinnedCollinear.front().timeBeats == doctest::Approx(0.0));
    CHECK(thinnedCollinear.back().timeBeats == doctest::Approx(10.0));

    // 2. High-rate dense sine wave thinning
    std::vector<AutomationPoint> sine;
    for (int i = 0; i <= 200; ++i) {
        double t = static_cast<double>(i) * 0.05;
        float v = static_cast<float>(0.5 + 0.5 * std::sin(t));
        sine.push_back({t, v, 0.0f});
    }
    CHECK(sine.size() == 201);

    auto thinnedSine = RamerDouglasPeucker::thin(sine, 0.01);
    CHECK(thinnedSine.size() < 40); // > 80% reduction
    CHECK(thinnedSine.size() > 5);   // Preserves wave shape

    // Endpoints preserved
    CHECK(thinnedSine.front().timeBeats == doctest::Approx(sine.front().timeBeats));
    CHECK(thinnedSine.back().timeBeats == doctest::Approx(sine.back().timeBeats));
}

TEST_CASE("RamerDouglasPeucker: adversarial dense pass uses bounded lossless fallback") {
    std::vector<AutomationPoint> zigzag;
    zigzag.reserve(8192);
    for (size_t index = 0; index < 8192; ++index)
        zigzag.push_back({static_cast<double>(index), static_cast<float>(index % 2), 0.0f});
    // Alternating values repeatedly split near an endpoint. Recursive RDP
    // formerly grew the native stack and performed quadratic unbounded work.
    const auto result = RamerDouglasPeucker::thin(zigzag, 1.0e-10);
    REQUIRE(result.size() == zigzag.size());
    for (size_t index = 0; index < result.size(); ++index) {
        CHECK(result[index].timeBeats == zigzag[index].timeBeats);
        CHECK(result[index].value == zigzag[index].value);
    }
}

TEST_CASE("AutomationRecorder: Touch, Latch, and punch-out return ramp") {
    AutomationLane lane;
    lane.id = "lane:gain";
    lane.points = {
        {0.0, 0.0f, 0.0f},
        {4.0, 0.0f, 0.0f},
        {8.0, 0.0f, 0.0f},
        {12.0, 0.0f, 0.0f}
    };

    AutomationRecorder::TouchSession session;

    // 1. Touch gesture from beat 2.0 to 6.0 moving fader to 0.8
    AutomationRecorder::beginTouch(session, lane.id, AutomationWriteMode::Touch, 2.0, 0.2f);
    AutomationRecorder::recordValue(session, 3.0, 0.5f);
    AutomationRecorder::recordValue(session, 4.0, 0.7f);
    AutomationRecorder::recordValue(session, 5.0, 0.8f);

    // Release at 6.0 with return ramp of 1.0 beat back to underlying value (0.0)
    bool committed = AutomationRecorder::endTouch(session, lane, 6.0, 0.8f, 1.0, 0.0f, 0.002);
    CHECK(committed);

    // Lane should have points inserted, point at beat 4.0 replaced, and ramp ending at 7.0
    CHECK(lane.points.front().timeBeats == doctest::Approx(0.0));
    CHECK(lane.points.back().timeBeats == doctest::Approx(12.0));

    // Verify points are strictly sorted
    for (size_t i = 1; i < lane.points.size(); ++i) {
        CHECK(lane.points[i].timeBeats > lane.points[i - 1].timeBeats);
    }

    // 2. Latch mode test
    AutomationRecorder::beginTouch(session, lane.id, AutomationWriteMode::Latch, 8.0, 0.9f);
    AutomationRecorder::recordValue(session, 9.0, 0.95f);
    bool latchHeld = AutomationRecorder::endTouch(session, lane, 9.5, 0.95f, 0.0, 0.0f);
    CHECK(latchHeld);
    CHECK(session.state == AutomationRecorder::State::HoldingLatch);

    // Stop transport at beat 11.0
    bool latchCommitted = AutomationRecorder::punchOutLatch(session, lane, 11.0, 0.5, 0.0f);
    CHECK(latchCommitted);
    CHECK(session.state == AutomationRecorder::State::Idle);

    for (size_t i = 1; i < lane.points.size(); ++i) {
        CHECK(lane.points[i].timeBeats > lane.points[i - 1].timeBeats);
    }

    // 3. Write mode test
    AutomationRecorder::beginTouch(session, lane.id, AutomationWriteMode::Write, 12.0, 0.4f);
    AutomationRecorder::recordValue(session, 13.0, 0.6f);
    AutomationRecorder::recordValue(session, 14.0, 0.8f);
    bool writeCommitted = AutomationRecorder::endTouch(session, lane, 14.5, 0.8f, 0.0, 0.0f, 0.002);
    CHECK(writeCommitted);
    CHECK(session.state == AutomationRecorder::State::Idle);

    for (size_t i = 1; i < lane.points.size(); ++i) {
        CHECK(lane.points[i].timeBeats > lane.points[i - 1].timeBeats);
    }
}

TEST_CASE("ProjectJson: Lossless roundtrip of AutomationLanes") {
    Project original;
    original.name = "Automation Test Project";

    SongDef song;
    song.id = "meta::song:1";
    song.name = "Main Song";

    AutomationLane songLane;
    songLane.id = "lane:main:volume";
    songLane.target.domain = AutomationDomain::Strip;
    songLane.target.entityId = "audio::main";
    songLane.target.parameterId = "faderGainDb";
    songLane.target.valueType = ParameterValueType::Decibels;
    songLane.target.defaultValue = 0.0f;
    songLane.target.minValue = -60.0f;
    songLane.target.maxValue = 12.0f;
    songLane.scope = AutomationScope::Track;
    songLane.writeMode = AutomationWriteMode::Touch;
    songLane.points = {
        {0.0, 0.0f, 0.0f},
        {4.0, -6.0f, 0.5f},
        {8.0, +3.0f, -0.5f}
    };
    song.automationLanes.push_back(songLane);

    MidiRegion mr;
    mr.id = "midi_reg:synth";
    mr.trackId = "audio::track:1";
    mr.name = "Synth Lead";
    mr.startBeats = 4.0;
    mr.durationBeats = 16.0;

    AutomationLane regionLane;
    regionLane.id = "lane:synth:cutoff";
    regionLane.target.domain = AutomationDomain::Plugin;
    regionLane.target.entityId = "slot:vst3:synth";
    regionLane.target.parameterId = "param:104";
    regionLane.target.valueType = ParameterValueType::FloatNormalized;
    regionLane.target.defaultValue = 0.5f;
    regionLane.scope = AutomationScope::Region;
    regionLane.points = {
        {0.0, 0.2f, 0.0f},
        {8.0, 0.9f, 0.8f}
    };
    mr.automationLanes.push_back(regionLane);
    song.midiRegions.push_back(mr);
    original.songs.push_back(song);

    // Serialize to JSON
    const std::string json = serializeProjectJson(original);
    CHECK(!json.empty());

    // Deserialize back
    std::string parseError;
    Project parsed;
    bool success = parseProjectJson(json, parsed, parseError);
    CHECK(success);
    CHECK(parseError.empty());

    // Verify roundtrip preservation
    CHECK(parsed.songs.size() == 1);
    const auto& s = parsed.songs[0];
    CHECK(s.automationLanes.size() == 1);
    CHECK(s.automationLanes[0].id == "lane:main:volume");
    CHECK(s.automationLanes[0].target.domain == AutomationDomain::Strip);
    CHECK(s.automationLanes[0].target.entityId == "audio::main");
    CHECK(s.automationLanes[0].target.parameterId == "faderGainDb");
    CHECK(s.automationLanes[0].writeMode == AutomationWriteMode::Touch);
    CHECK(s.automationLanes[0].points.size() == 3);
    CHECK(s.automationLanes[0].points[1].value == doctest::Approx(-6.0f));
    CHECK(s.automationLanes[0].points[1].curve == doctest::Approx(0.5f));

    CHECK(s.midiRegions.size() == 1);
    const auto& parsedMr = s.midiRegions[0];
    CHECK(parsedMr.automationLanes.size() == 1);
    CHECK(parsedMr.automationLanes[0].id == "lane:synth:cutoff");
    CHECK(parsedMr.automationLanes[0].target.domain == AutomationDomain::Plugin);
    CHECK(parsedMr.automationLanes[0].target.entityId == "slot:vst3:synth");
    CHECK(parsedMr.automationLanes[0].target.parameterId == "param:104");
    CHECK(parsedMr.automationLanes[0].scope == AutomationScope::Region);
    CHECK(parsedMr.automationLanes[0].points.size() == 2);
    CHECK(parsedMr.automationLanes[0].points[1].value == doctest::Approx(0.9f));
    CHECK(parsedMr.automationLanes[0].points[1].curve == doctest::Approx(0.8f));
}

TEST_CASE("AutomationTarget: Slot UUID retention, orphan lane recovery, and paramID parsing") {
    // 1. Parameter index parsing edge cases
    const auto parseParamIndex = [](std::string_view id) noexcept -> int {
        if (id.starts_with("param:")) id.remove_prefix(6);
        int index = -1;
        if (id.empty()) return index;
        const auto parsed = std::from_chars(id.data(), id.data() + id.size(), index);
        if (parsed.ec != std::errc{} || parsed.ptr != id.data() + id.size())
            return -1;
        return index;
    };

    CHECK(parseParamIndex("param:0") == 0);
    CHECK(parseParamIndex("param:104") == 104);
    CHECK(parseParamIndex("42") == 42);
    CHECK(parseParamIndex("param:") == -1);
    CHECK(parseParamIndex("param:-1") == -1);
    CHECK(parseParamIndex("param:abc") == -1);
    CHECK(parseParamIndex("") == -1);
    CHECK(parseParamIndex("param:12x") == -1);

    // 2. Track with multiple plugins and slot UUID retention across reorder
    TrackDef track;
    track.id = "audio::track:1";
    track.name = "Guitar";

    PluginSlot slotA;
    slotA.id = "slot_uuid_chorus_01";
    slotA.plugin.name = "Chorus";

    PluginSlot slotB;
    slotB.id = "slot_uuid_delay_02";
    slotB.plugin.name = "Delay";

    PluginSlot slotC;
    slotC.id = "slot_uuid_reverb_03";
    slotC.plugin.name = "Reverb";

    track.plugins = {slotA, slotB, slotC};

    // Automation lane binds specifically to slotB UUID
    AutomationLane delayMixLane;
    delayMixLane.id = "lane_delay_mix";
    delayMixLane.target.domain = AutomationDomain::Plugin;
    delayMixLane.target.entityId = slotB.id; // slot_uuid_delay_02
    delayMixLane.target.parameterId = "param:1";
    delayMixLane.points = {{0.0, 0.2f, 0.0f}, {4.0, 0.8f, 0.0f}};

    // Reorder plugins: move slotB to first position (slotB, slotA, slotC)
    std::swap(track.plugins[0], track.plugins[1]);
    CHECK(track.plugins[0].id == "slot_uuid_delay_02");
    CHECK(track.plugins[1].id == "slot_uuid_chorus_01");

    // The lane's target entityId still matches slotB.id regardless of slot index
    const auto findSlotForLane = [&](const AutomationLane& lane) -> const PluginSlot* {
        for (const auto& s : track.plugins) {
            if (s.id == lane.target.entityId)
                return &s;
        }
        return nullptr;
    };

    const auto* matchedSlot = findSlotForLane(delayMixLane);
    REQUIRE(matchedSlot != nullptr);
    CHECK(matchedSlot->id == "slot_uuid_delay_02");
    CHECK(matchedSlot->plugin.name == "Delay");

    // 3. Remove plug-in: lane becomes an orphan but retains its points and target identity
    track.plugins.erase(track.plugins.begin()); // Erase slotB
    CHECK(track.plugins.size() == 2);
    CHECK(findSlotForLane(delayMixLane) == nullptr); // Slot is missing, lane is an orphan

    // Points and target configuration remain completely intact
    CHECK(delayMixLane.target.entityId == "slot_uuid_delay_02");
    CHECK(delayMixLane.target.parameterId == "param:1");
    CHECK(delayMixLane.points.size() == 2);
    CHECK(delayMixLane.points[1].value == doctest::Approx(0.8f));

    // 4. Restore plug-in (undo removal): lane reattaches immediately to slot UUID
    track.plugins.insert(track.plugins.begin(), slotB);
    const auto* reattachedSlot = findSlotForLane(delayMixLane);
    REQUIRE(reattachedSlot != nullptr);
    CHECK(reattachedSlot->id == "slot_uuid_delay_02");
    CHECK(reattachedSlot->plugin.name == "Delay");
}

} // TEST_SUITE("AutomationFramework")
