#include "doctest.h"

#include "lighting/LightOutputResolver.h"

using namespace resostage;

TEST_CASE("dbToLinearLevel maps -60..0 dBFS to 0..1") {
    CHECK(dbToLinearLevel(-60.0f) == doctest::Approx(0.0f));
    CHECK(dbToLinearLevel(0.0f) == doctest::Approx(1.0f));
    CHECK(dbToLinearLevel(-30.0f) == doctest::Approx(0.5f));
}

TEST_CASE("dbToLinearLevel clamps outside the range") {
    CHECK(dbToLinearLevel(-100.0f) == doctest::Approx(0.0f));
    CHECK(dbToLinearLevel(6.0f) == doctest::Approx(1.0f));
}

TEST_CASE("meterLedColor: LEDs at or above litCount are off") {
    uint8_t r, g, b;
    meterLedColor(5, 5, 10, GradientPreset::Solid, 255, 0, 0, r, g, b);
    CHECK(r == 0);
    CHECK(g == 0);
    CHECK(b == 0);
}

TEST_CASE("meterLedColor: solid preset uses the base color for every lit LED") {
    uint8_t r, g, b;
    meterLedColor(0, 5, 10, GradientPreset::Solid, 10, 20, 30, r, g, b);
    CHECK(r == 10);
    CHECK(g == 20);
    CHECK(b == 30);
    meterLedColor(4, 5, 10, GradientPreset::Solid, 10, 20, 30, r, g, b);
    CHECK(r == 10);
}

TEST_CASE("meterLedColor: greenYellowRed colors by position, ignoring the base color") {
    uint8_t r, g, b;
    // Bottom LED (index 0 of 10) -> green band.
    meterLedColor(0, 10, 10, GradientPreset::GreenYellowRed, 0, 0, 0, r, g, b);
    CHECK(g > r);
    CHECK(g > b);
    // Top LED (index 9 of 10) -> red band.
    meterLedColor(9, 10, 10, GradientPreset::GreenYellowRed, 0, 0, 0, r, g, b);
    CHECK(r > g);
}

TEST_CASE("parseGradientPreset round-trips the two known strings and defaults to Solid") {
    CHECK(parseGradientPreset("solid") == GradientPreset::Solid);
    CHECK(parseGradientPreset("greenYellowRed") == GradientPreset::GreenYellowRed);
    CHECK(parseGradientPreset("bogus") == GradientPreset::Solid);
    CHECK(parseGradientPreset("") == GradientPreset::Solid);
}

namespace {

LightTrack makeTrack(std::string id, std::vector<std::string> fixtureIds) {
    LightTrack t;
    t.id = std::move(id);
    t.fixtureIds = std::move(fixtureIds);
    return t;
}

LightCue makeCue(std::string trackId, double start, double dur, std::string effectType = "none") {
    LightCue c;
    c.trackId = std::move(trackId);
    c.startSeconds = start;
    c.durationSeconds = dur;
    c.colorR = 100;
    c.colorG = 150;
    c.colorB = 200;
    c.intensity = 1.0;
    c.effectType = std::move(effectType);
    return c;
}

} // namespace

TEST_CASE("resolveLightOutputs: no active cue on a track yields no rows for its fixtures") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1"})};
    std::vector<LightCue> cues; // no cues at all
    auto out = resolveLightOutputs(tracks, cues, 5.0, 120.0, nullptr);
    CHECK(out.empty());
}

TEST_CASE("resolveLightOutputs: one row per fixture on an active track") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1", "fx2"})};
    std::vector<LightCue> cues = {makeCue("t1", 0.0, 10.0)};
    auto out = resolveLightOutputs(tracks, cues, 5.0, 120.0, nullptr);
    REQUIRE(out.size() == 2);
    CHECK(out[0].fixtureId == "fx1");
    CHECK(out[1].fixtureId == "fx2");
    CHECK(out[0].value.r == 100);
    CHECK(out[0].meterLevel01 == doctest::Approx(0.0f));
}

TEST_CASE("resolveLightOutputs: Meter effect reads the source level via the callback and sets meterLevel01") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1"})};
    std::vector<LightCue> cues = {makeCue("t1", 0.0, 10.0, "meter")};
    cues[0].effectSourceType = "track";
    cues[0].effectSourceId = "trk_5";
    cues[0].effectIntensity = 1.0f;

    bool sawExpectedArgs = false;
    auto sourceLevelDb = [&](const std::string& type, const std::string& id) -> SourceLevels {
        if (type == "track" && id == "trk_5") sawExpectedArgs = true;
        SourceLevels lv;
        lv.peakDb = -30.0f; // -> 0.5 linear
        return lv;
    };

    auto out = resolveLightOutputs(tracks, cues, 2.0, 120.0, sourceLevelDb);
    REQUIRE(out.size() == 1);
    CHECK(sawExpectedArgs);
    CHECK(out[0].meterLevel01 == doctest::Approx(0.5f));
    CHECK(out[0].value.intensity < 1.0); // quantized/scaled down from the cue's full intensity
}

TEST_CASE("resolveLightOutputs: gradient preset is carried through from the active cue") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1"})};
    std::vector<LightCue> cues = {makeCue("t1", 0.0, 10.0, "meter")};
    cues[0].gradientPreset = "greenYellowRed";
    auto out = resolveLightOutputs(tracks, cues, 1.0, 120.0, [](const std::string&, const std::string&) { return SourceLevels{}; });
    REQUIRE(out.size() == 1);
    CHECK(out[0].gradient == GradientPreset::GreenYellowRed);
}

TEST_CASE("resolveLightOutputs: a null source-level callback just leaves meterLevel01 at 0") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1"})};
    std::vector<LightCue> cues = {makeCue("t1", 0.0, 10.0, "meter")};
    auto out = resolveLightOutputs(tracks, cues, 1.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].meterLevel01 == doctest::Approx(0.0f));
}

TEST_CASE("resolveLightOutputs: tempo-synced effects phase-lock to absolute song time, not cue start") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1"})};
    std::vector<LightCue> cues = {makeCue("t1", 10.0, 20.0, "strobe")};
    cues[0].tempoSync = true;
    cues[0].tempoSubdiv = "1/4";
    // A cue starting mid-beat (not on a bar boundary) must still phase-lock
    // to the song's beat grid -- effectTSec should equal the absolute
    // playhead time, not (playhead - cue start).
    auto out = resolveLightOutputs(tracks, cues, 14.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].effectTSec == doctest::Approx(14.0));
}

TEST_CASE("resolveLightOutputs: free-rate (non-synced) effects stay relative to cue start") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1"})};
    std::vector<LightCue> cues = {makeCue("t1", 10.0, 20.0, "strobe")};
    cues[0].tempoSync = false;
    auto out = resolveLightOutputs(tracks, cues, 14.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].effectTSec == doctest::Approx(4.0)); // 14 - cue start (10)
}

TEST_CASE("resolveLightOutputs: forwards effect identity and phase for Converge/GradientFlow") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1"})};
    std::vector<LightCue> cues = {makeCue("t1", 10.0, 20.0, "converge")};
    cues[0].effectRateHz = 3.0f;
    auto out = resolveLightOutputs(tracks, cues, 14.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].effectType == EffectParams::Type::Converge);
    CHECK(out[0].effectTSec == doctest::Approx(4.0)); // 14 - cue start (10)
    CHECK(out[0].effectRateHz == doctest::Approx(3.0f));
    CHECK(out[0].meterLevel01 == doctest::Approx(0.0f)); // only Meter sets this
}

TEST_CASE("resolveLightOutputs: querying between cues leaves effectType at None (black, no effect)") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1"})};
    std::vector<LightCue> cues = {makeCue("t1", 0.0, 2.0, "gradientflow")};
    // The track still has a cue somewhere, just not active at this instant --
    // still yields a row (black/off), unlike a track with no cues at all
    // (see "no active cue on a track yields no rows" above).
    auto out = resolveLightOutputs(tracks, cues, 100.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].effectType == EffectParams::Type::None);
    CHECK(out[0].value.intensity == doctest::Approx(0.0));
}

// ─── Cross-track layering / blend modes ────────────────────────────────────
//
// A fixture driven by exactly one track (every test above) must never run
// any blend math at all -- confirmed above by every value matching the
// pre-layering implementation exactly. These tests cover what happens when
// TWO tracks list the same fixture and both have simultaneously active cues.

TEST_CASE("resolveLightOutputs: two tracks sharing a fixture, second layer 'normal', is a plain replace") {
    std::vector<LightTrack> tracks = {
        makeTrack("base", {"fx1"}),
        makeTrack("accent", {"fx1"}),
    };
    LightCue baseCue = makeCue("base", 0.0, 10.0);
    baseCue.colorR = 10; baseCue.colorG = 20; baseCue.colorB = 30;
    LightCue accentCue = makeCue("accent", 0.0, 10.0);
    accentCue.colorR = 200; accentCue.colorG = 210; accentCue.colorB = 220;
    accentCue.blendMode = "normal";
    std::vector<LightCue> cues = {baseCue, accentCue};

    auto out = resolveLightOutputs(tracks, cues, 5.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    // "normal" replaces outright -- the topmost (accent) layer wins,
    // matching what an unlayered single cue on that fixture would show.
    CHECK(out[0].value.r == 200);
    CHECK(out[0].value.g == 210);
    CHECK(out[0].value.b == 220);
}

TEST_CASE("resolveLightOutputs: additive blend combines two layers' effective brightness") {
    std::vector<LightTrack> tracks = {
        makeTrack("base", {"fx1"}),
        makeTrack("accent", {"fx1"}),
    };
    LightCue baseCue = makeCue("base", 0.0, 10.0);
    baseCue.colorR = 100; baseCue.colorG = 0; baseCue.colorB = 0;
    baseCue.intensity = 1.0;
    LightCue accentCue = makeCue("accent", 0.0, 10.0);
    accentCue.colorR = 0; accentCue.colorG = 0; accentCue.colorB = 80;
    accentCue.intensity = 1.0;
    accentCue.blendMode = "additive";
    std::vector<LightCue> cues = {baseCue, accentCue};

    auto out = resolveLightOutputs(tracks, cues, 5.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].value.r == 100); // base channel untouched by a zero accent channel
    CHECK(out[0].value.b == 80);  // accent channel untouched by a zero base channel
    CHECK(out[0].value.intensity == doctest::Approx(1.0)); // baked into r/g/b already
}

TEST_CASE("resolveLightOutputs: additive blend clamps at full brightness, never overflows") {
    std::vector<LightTrack> tracks = {
        makeTrack("base", {"fx1"}),
        makeTrack("accent", {"fx1"}),
    };
    LightCue baseCue = makeCue("base", 0.0, 10.0);
    baseCue.colorR = 200; baseCue.colorG = 200; baseCue.colorB = 200;
    LightCue accentCue = makeCue("accent", 0.0, 10.0);
    accentCue.colorR = 200; accentCue.colorG = 200; accentCue.colorB = 200;
    accentCue.blendMode = "additive";
    std::vector<LightCue> cues = {baseCue, accentCue};

    auto out = resolveLightOutputs(tracks, cues, 5.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].value.r == 255);
    CHECK(out[0].value.g == 255);
    CHECK(out[0].value.b == 255);
}

TEST_CASE("resolveLightOutputs: multiply blend uses the accent as a dimmer mask") {
    std::vector<LightTrack> tracks = {
        makeTrack("base", {"fx1"}),
        makeTrack("accent", {"fx1"}),
    };
    LightCue baseCue = makeCue("base", 0.0, 10.0);
    baseCue.colorR = 255; baseCue.colorG = 255; baseCue.colorB = 255;
    LightCue accentCue = makeCue("accent", 0.0, 10.0);
    accentCue.colorR = 0; accentCue.colorG = 128; accentCue.colorB = 255;
    accentCue.blendMode = "multiply";
    std::vector<LightCue> cues = {baseCue, accentCue};

    auto out = resolveLightOutputs(tracks, cues, 5.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].value.r == 0);   // full white base * zero accent channel -> off
    CHECK(out[0].value.b == 255); // full white base * full accent channel -> unchanged
    CHECK(out[0].value.g > 0);
    CHECK(out[0].value.g < 255);
}

TEST_CASE("resolveLightOutputs: an idle second track never blacks out an active first one") {
    // "accent" track has a cue elsewhere in the timeline but nothing active
    // at this instant -- must contribute NOTHING, not a black multiply/
    // normal layer, or simply co-existing on a shared fixture would be a
    // footgun (any authored idle track downstream would blank the rig).
    std::vector<LightTrack> tracks = {
        makeTrack("base", {"fx1"}),
        makeTrack("accent", {"fx1"}),
    };
    LightCue baseCue = makeCue("base", 0.0, 10.0);
    baseCue.colorR = 111; baseCue.colorG = 22; baseCue.colorB = 33;
    LightCue accentCue = makeCue("accent", 50.0, 10.0); // active 50..60, not at t=5
    std::vector<LightCue> cues = {baseCue, accentCue};

    auto out = resolveLightOutputs(tracks, cues, 5.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].value.r == 111);
    CHECK(out[0].value.g == 22);
    CHECK(out[0].value.b == 33);
}

TEST_CASE("resolveLightOutputs: the topmost active layer with a spatial effect wins the forwarded effect slot") {
    std::vector<LightTrack> tracks = {
        makeTrack("base", {"fx1"}),
        makeTrack("accent", {"fx1"}),
    };
    LightCue baseCue = makeCue("base", 0.0, 10.0, "plasma");
    LightCue accentCue = makeCue("accent", 0.0, 10.0, "sonicboom");
    accentCue.blendMode = "lighten";
    std::vector<LightCue> cues = {baseCue, accentCue};

    auto out = resolveLightOutputs(tracks, cues, 5.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].effectType == EffectParams::Type::SonicBoom);
}

TEST_CASE("parseBlendMode / blendModeToString round-trip every known mode and default to Normal") {
    for (auto mode : {BlendMode::Normal, BlendMode::Additive, BlendMode::Multiply,
                       BlendMode::Difference, BlendMode::Lighten, BlendMode::Subtractive}) {
        CHECK(parseBlendMode(blendModeToString(mode)) == mode);
    }
    CHECK(parseBlendMode("bogus") == BlendMode::Normal);
    CHECK(parseBlendMode("") == BlendMode::Normal);
}
