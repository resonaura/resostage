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
    c.color.r = 100;
    c.color.g = 150;
    c.color.b = 200;
    c.intensity = 1.0;
    c.effect.type = std::move(effectType);
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
    cues[0].effect.sourceType = "track";
    cues[0].effect.sourceId = "trk_5";
    cues[0].effect.intensity = 1.0f;

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
    cues[0].gradient.preset = "greenYellowRed";
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
    cues[0].effect.tempoSync = true;
    cues[0].effect.tempoSubdivision = "1/4";
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
    cues[0].effect.tempoSync = false;
    auto out = resolveLightOutputs(tracks, cues, 14.0, 120.0, nullptr);
    REQUIRE(out.size() == 1);
    CHECK(out[0].effectTSec == doctest::Approx(4.0)); // 14 - cue start (10)
}

TEST_CASE("resolveLightOutputs: forwards effect identity and phase for Converge/GradientFlow") {
    std::vector<LightTrack> tracks = {makeTrack("t1", {"fx1"})};
    std::vector<LightCue> cues = {makeCue("t1", 10.0, 20.0, "converge")};
    cues[0].effect.rateHz = 3.0f;
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
    baseCue.color.r = 10; baseCue.color.g = 20; baseCue.color.b = 30;
    LightCue accentCue = makeCue("accent", 0.0, 10.0);
    accentCue.color.r = 200; accentCue.color.g = 210; accentCue.color.b = 220;
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
    baseCue.color.r = 100; baseCue.color.g = 0; baseCue.color.b = 0;
    baseCue.intensity = 1.0;
    LightCue accentCue = makeCue("accent", 0.0, 10.0);
    accentCue.color.r = 0; accentCue.color.g = 0; accentCue.color.b = 80;
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
    baseCue.color.r = 200; baseCue.color.g = 200; baseCue.color.b = 200;
    LightCue accentCue = makeCue("accent", 0.0, 10.0);
    accentCue.color.r = 200; accentCue.color.g = 200; accentCue.color.b = 200;
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
    baseCue.color.r = 255; baseCue.color.g = 255; baseCue.color.b = 255;
    LightCue accentCue = makeCue("accent", 0.0, 10.0);
    accentCue.color.r = 0; accentCue.color.g = 128; accentCue.color.b = 255;
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
    baseCue.color.r = 111; baseCue.color.g = 22; baseCue.color.b = 33;
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

// ─── buildIdleLightOutputs (stopped-playback behavior) ─────────────────────

namespace {
std::vector<LightFixture> makeIdleFixtures() {
    LightFixture a;
    a.id = "f1";
    LightFixture b;
    b.id = "f2";
    return {a, b};
}
} // namespace

TEST_CASE("buildIdleLightOutputs: holdLast (or any unrecognised value) returns nothing -- caller keeps resolveLightOutputs") {
    auto fixtures = makeIdleFixtures();
    CHECK(buildIdleLightOutputs(fixtures, "holdLast", 10, 20, 30, 1.0).empty());
    CHECK(buildIdleLightOutputs(fixtures, "bogus", 10, 20, 30, 1.0).empty());
    CHECK(buildIdleLightOutputs({}, "blackout", 10, 20, 30, 1.0).empty()); // no fixtures at all
}

TEST_CASE("buildIdleLightOutputs: blackout forces every fixture to black, zero intensity") {
    auto out = buildIdleLightOutputs(makeIdleFixtures(), "blackout", 200, 100, 50, 0.9);
    REQUIRE(out.size() == 2);
    for (const auto& r : out) {
        CHECK(r.value.r == 0);
        CHECK(r.value.g == 0);
        CHECK(r.value.b == 0);
        CHECK(r.value.intensity == doctest::Approx(0.0));
    }
    CHECK(out[0].fixtureId == "f1");
    CHECK(out[1].fixtureId == "f2");
}

TEST_CASE("buildIdleLightOutputs: staticColor forces every fixture to the configured idle color/intensity") {
    auto out = buildIdleLightOutputs(makeIdleFixtures(), "staticColor", 200, 100, 50, 0.75);
    REQUIRE(out.size() == 2);
    for (const auto& r : out) {
        CHECK(r.value.r == 200);
        CHECK(r.value.g == 100);
        CHECK(r.value.b == 50);
        CHECK(r.value.intensity == doctest::Approx(0.75));
    }
}

TEST_CASE("buildIdleLightOutputs: staticColor clamps an out-of-range intensity") {
    auto out = buildIdleLightOutputs(makeIdleFixtures(), "staticColor", 1, 2, 3, 1.5);
    REQUIRE(out.size() == 2);
    CHECK(out[0].value.intensity == doctest::Approx(1.0));
}

// ─── buildIdleEffectOutputs / buildIdleTarget (idle "effect" mode) ─────────

TEST_CASE("buildIdleEffectOutputs: one row per fixture, forwards identity, rate and phase") {
    auto out = buildIdleEffectOutputs(makeIdleFixtures(), "strobe", 3.5, 200, 100, 50, 0.8, "solid", "", 1.25);
    REQUIRE(out.size() == 2);
    CHECK(out[0].fixtureId == "f1");
    CHECK(out[1].fixtureId == "f2");
    for (const auto& r : out) {
        CHECK(r.effectType == EffectParams::Type::Strobe);
        CHECK(r.effectRateHz == doctest::Approx(3.5f));
        CHECK(r.effectTSec == doctest::Approx(1.25));
        // The idle color seeds the effect's base color.
        CHECK(r.value.r == 200);
        CHECK(r.value.g == 100);
        CHECK(r.value.b == 50);
        // The effect is actually modulating (Strobe scales intensity from
        // the base level, so it won't stay exactly at 0.8).
        CHECK(r.value.intensity > 0.0);
        CHECK(r.value.intensity <= 1.0);
    }
}

TEST_CASE("buildIdleEffectOutputs: an unrecognised effect type yields Type::None rows (off, not animated)") {
    auto out = buildIdleEffectOutputs(makeIdleFixtures(), "bogus", 2.0, 10, 20, 30, 1.0, "solid", "", 0.0);
    REQUIRE(out.size() == 2);
    for (const auto& r : out)
        CHECK(r.effectType == EffectParams::Type::None);
}

TEST_CASE("buildIdleTarget: effect delegates to the effect builder; other modes fall through") {
    auto fixtures = makeIdleFixtures();
    auto eff = buildIdleTarget(fixtures, "effect", 200, 100, 50, 0.8, "chase", 4.0, "solid", "", 0.5);
    REQUIRE(eff.size() == 2);
    CHECK(eff[0].effectType == EffectParams::Type::Chase);
    CHECK(eff[0].effectRateHz == doctest::Approx(4.0f));

    auto sc = buildIdleTarget(fixtures, "staticColor", 200, 100, 50, 0.75, "chase", 4.0, "solid", "", 0.5);
    REQUIRE(sc.size() == 2);
    CHECK(sc[0].value.r == 200);
    CHECK(sc[0].value.g == 100);
    CHECK(sc[0].value.b == 50);
    CHECK(sc[0].effectType == EffectParams::Type::None); // static color never animates

    auto bo = buildIdleTarget(fixtures, "blackout", 200, 100, 50, 0.75, "chase", 4.0, "solid", "", 0.5);
    REQUIRE(bo.size() == 2);
    CHECK(bo[0].value.r == 0);
    CHECK(bo[0].value.intensity == doctest::Approx(0.0));

    // holdLast is not a buildIdleTarget mode -- it's the caller's "keep
    // resolving normally" fallback, so the target stays empty.
    CHECK(buildIdleTarget(fixtures, "holdLast", 200, 100, 50, 0.75, "chase", 4.0, "solid", "", 0.5).empty());
}

TEST_CASE("buildIdleTarget effect: per-LED colors keep animating across wall-clock phase") {
    // The idle "effect" mode must advance even while the transport is
    // stopped -- the preview and DMX both render via resolveLedWireColors,
    // which animates off effectTSec. Two different wall-clock phases must
    // produce different per-LED wire colors.
    LightFixture bar;
    bar.id = "bar1";
    bar.kind = LightFixture::Kind::ResoLightBar;
    bar.channelProfile = "rgb";
    bar.addressable = true;
    bar.ledCount = 8;
    std::vector<LightFixture> fixtures = {bar};

    const auto a = buildIdleTarget(fixtures, "effect", 255, 255, 255, 1.0, "chase", 2.0, "solid", "", 0.10);
    const auto b = buildIdleTarget(fixtures, "effect", 255, 255, 255, 1.0, "chase", 2.0, "solid", "", 0.35);
    REQUIRE(a.size() == 1);
    REQUIRE(b.size() == 1);
    CHECK(a[0].effectType == EffectParams::Type::Chase);

    const auto wa = resolveLedWireColors(a[0], bar);
    const auto wb = resolveLedWireColors(b[0], bar);
    REQUIRE(wa.size() == 8);
    REQUIRE(wb.size() == 8);
    bool differs = false;
    for (int i = 0; i < 8 && !differs; ++i)
        if (wa[i].r != wb[i].r || wa[i].g != wb[i].g || wa[i].b != wb[i].b)
            differs = true;
    CHECK(differs);
}

// ─── blendTowardIdle (idle-transition fade) ────────────────────────────────

namespace {
ResolvedFixtureOutput makeOutput(std::string id, uint8_t r, uint8_t g, uint8_t b, double intensity) {
    ResolvedFixtureOutput o;
    o.fixtureId = std::move(id);
    o.value = {r, g, b, intensity};
    return o;
}
} // namespace

TEST_CASE("blendTowardIdle: t=0 is exactly the source, t=1 is exactly the target") {
    std::vector<ResolvedFixtureOutput> from = {makeOutput("f1", 200, 0, 0, 1.0)};
    std::vector<ResolvedFixtureOutput> to = {makeOutput("f1", 0, 0, 50, 0.2)};

    auto atStart = blendTowardIdle(from, to, 0.0);
    REQUIRE(atStart.size() == 1);
    CHECK(atStart[0].value.r == 200);
    CHECK(atStart[0].value.b == 0);
    CHECK(atStart[0].value.intensity == doctest::Approx(1.0));

    auto atEnd = blendTowardIdle(from, to, 1.0);
    REQUIRE(atEnd.size() == 1);
    CHECK(atEnd[0].value.r == 0);
    CHECK(atEnd[0].value.b == 50);
    CHECK(atEnd[0].value.intensity == doctest::Approx(0.2));
}

TEST_CASE("blendTowardIdle: halfway is the midpoint of each channel") {
    std::vector<ResolvedFixtureOutput> from = {makeOutput("f1", 100, 100, 100, 1.0)};
    std::vector<ResolvedFixtureOutput> to = {makeOutput("f1", 0, 200, 0, 0.0)};
    auto mid = blendTowardIdle(from, to, 0.5);
    REQUIRE(mid.size() == 1);
    CHECK(mid[0].value.r == 50);
    CHECK(mid[0].value.g == 150);
    CHECK(mid[0].value.b == 50);
    CHECK(mid[0].value.intensity == doctest::Approx(0.5));
}

TEST_CASE("blendTowardIdle: a fixture missing from `from` fades in from black") {
    std::vector<ResolvedFixtureOutput> from = {}; // never had an active cue while playing
    std::vector<ResolvedFixtureOutput> to = {makeOutput("f1", 255, 255, 255, 1.0)};
    auto mid = blendTowardIdle(from, to, 0.5);
    REQUIRE(mid.size() == 1);
    CHECK(mid[0].value.r == 127); // (0 + 255) * 0.5 = 127.5, truncated
    CHECK(mid[0].value.intensity == doctest::Approx(0.5));
}

TEST_CASE("blendTowardIdle: t is clamped, and the fixture set is always driven by `to`") {
    std::vector<ResolvedFixtureOutput> from = {
        makeOutput("f1", 100, 0, 0, 1.0),
        makeOutput("stale", 9, 9, 9, 1.0), // no longer in the idle target -- must be dropped
    };
    std::vector<ResolvedFixtureOutput> to = {makeOutput("f1", 0, 0, 0, 0.0)};

    auto beyondOne = blendTowardIdle(from, to, 5.0);
    REQUIRE(beyondOne.size() == 1);
    CHECK(beyondOne[0].fixtureId == "f1");
    CHECK(beyondOne[0].value.r == 0);

    auto belowZero = blendTowardIdle(from, to, -3.0);
    REQUIRE(belowZero.size() == 1);
    CHECK(belowZero[0].value.r == 100);
}

// ─── resolveLedWireColors: ResoLightBar color type (Dimmer/RGB/RGBW) ──────

namespace {
LightFixture makeBar(std::string channelProfile, bool addressable = false, int ledCount = 1) {
    LightFixture f;
    f.id = "bar1";
    f.kind = LightFixture::Kind::ResoLightBar;
    f.channelProfile = std::move(channelProfile);
    f.addressable = addressable;
    f.ledCount = ledCount;
    return f;
}

ResolvedFixtureOutput makeSolidOutput(uint8_t r, uint8_t g, uint8_t b, double intensity = 1.0) {
    ResolvedFixtureOutput o;
    o.fixtureId = "bar1";
    o.value = {r, g, b, intensity};
    return o;
}
} // namespace

TEST_CASE("resolveLedWireColors: rgb profile is untouched passthrough (w always 0)") {
    auto out = resolveLedWireColors(makeSolidOutput(200, 100, 50), makeBar("rgb"));
    REQUIRE(out.size() == 1);
    CHECK(out[0].r == 200);
    CHECK(out[0].g == 100);
    CHECK(out[0].b == 50);
    CHECK(out[0].w == 0);
}

TEST_CASE("resolveLedWireColors: rgbw extracts the shared white component") {
    // min(200,150,50) = 50 -> w=50, r/g/b lose that shared component.
    auto out = resolveLedWireColors(makeSolidOutput(200, 150, 50), makeBar("rgbw"));
    REQUIRE(out.size() == 1);
    CHECK(out[0].r == 150);
    CHECK(out[0].g == 100);
    CHECK(out[0].b == 0);
    CHECK(out[0].w == 50);
}

TEST_CASE("resolveLedWireColors: rgbw of a pure white cue puts everything on w") {
    auto out = resolveLedWireColors(makeSolidOutput(255, 255, 255), makeBar("rgbw"));
    REQUIRE(out.size() == 1);
    CHECK(out[0].r == 0);
    CHECK(out[0].g == 0);
    CHECK(out[0].b == 0);
    CHECK(out[0].w == 255);
}

TEST_CASE("resolveLedWireColors: dimmer carries the loudest channel in .r, g/b unused") {
    auto out = resolveLedWireColors(makeSolidOutput(80, 200, 40), makeBar("dimmer"));
    REQUIRE(out.size() == 1);
    CHECK(out[0].r == 200);
    CHECK(out[0].g == 0);
    CHECK(out[0].b == 0);
}

TEST_CASE("resolveLedWireColors: intensity scaling still applies under every color type") {
    auto rgbw = resolveLedWireColors(makeSolidOutput(200, 200, 200, 0.5), makeBar("rgbw"));
    REQUIRE(rgbw.size() == 1);
    CHECK(rgbw[0].w == 100); // 200 * 0.5

    auto dimmer = resolveLedWireColors(makeSolidOutput(200, 0, 0, 0.5), makeBar("dimmer"));
    REQUIRE(dimmer.size() == 1);
    CHECK(dimmer[0].r == 100);
}

TEST_CASE("resolveLedWireColors: color type only applies to ResoLightBar, not DmxGeneric") {
    // A DmxGeneric fixture that somehow carries channelProfile="rgbw"
    // (purely informational for that kind, see LightFixture's doc comment)
    // must still get plain, untouched r/g/b -- writeDmxChannels only ever
    // writes 1-3 bytes for DmxGeneric regardless.
    LightFixture generic;
    generic.id = "bar1";
    generic.kind = LightFixture::Kind::DmxGeneric;
    generic.channelProfile = "rgbw";
    // Real DmxGeneric fixtures are always non-addressable/single-LED (see
    // lightingFixtureAdd) -- LightFixture's own defaults (ledCount=120,
    // addressable=true) are ResoLightBar-shaped, so this must override both.
    generic.addressable = false;
    generic.ledCount = 1;
    auto out = resolveLedWireColors(makeSolidOutput(200, 150, 50), generic);
    REQUIRE(out.size() == 1);
    CHECK(out[0].r == 200);
    CHECK(out[0].g == 150);
    CHECK(out[0].b == 50);
    CHECK(out[0].w == 0);
}

TEST_CASE("resolveLedWireColors: color type applies per-LED for an addressable bar too") {
    LightFixture bar = makeBar("rgbw", /*addressable*/ true, /*ledCount*/ 3);
    auto out = resolveLedWireColors(makeSolidOutput(255, 255, 255), bar);
    REQUIRE(out.size() == 3);
    for (const auto& c : out) {
        CHECK(c.r == 0);
        CHECK(c.g == 0);
        CHECK(c.b == 0);
        CHECK(c.w == 255);
    }
}

// ─── resolveLedWireColorsBlended (idle-transition per-pixel crossfade) ────

namespace {
ResolvedFixtureOutput makeEffectOutput(uint8_t r, uint8_t g, uint8_t b, EffectParams::Type type,
                                       float rateHz, double tSec) {
    ResolvedFixtureOutput o;
    o.fixtureId = "bar1";
    o.value = {r, g, b, 1.0};
    o.effectType = type;
    o.effectRateHz = rateHz;
    o.effectTSec = tSec;
    return o;
}
} // namespace

TEST_CASE("resolveLedWireColorsBlended: t=0/1 boundaries equal resolveLedWireColors of each side exactly") {
    LightFixture bar = makeBar("rgb", /*addressable*/ true, /*ledCount*/ 8);
    const auto from = makeEffectOutput(255, 0, 0, EffectParams::Type::Chase, 2.0f, 0.3);
    const auto to = makeEffectOutput(0, 0, 255, EffectParams::Type::Twinkle, 1.0f, 1.1);

    const auto atZero = resolveLedWireColorsBlended(from, to, bar, 0.0);
    const auto expectedFrom = resolveLedWireColors(from, bar);
    REQUIRE(atZero.size() == expectedFrom.size());
    for (size_t i = 0; i < atZero.size(); ++i) {
        CHECK(atZero[i].r == expectedFrom[i].r);
        CHECK(atZero[i].g == expectedFrom[i].g);
        CHECK(atZero[i].b == expectedFrom[i].b);
    }

    const auto atOne = resolveLedWireColorsBlended(from, to, bar, 1.0);
    const auto expectedTo = resolveLedWireColors(to, bar);
    REQUIRE(atOne.size() == expectedTo.size());
    for (size_t i = 0; i < atOne.size(); ++i) {
        CHECK(atOne[i].r == expectedTo[i].r);
        CHECK(atOne[i].g == expectedTo[i].g);
        CHECK(atOne[i].b == expectedTo[i].b);
    }
}

TEST_CASE("resolveLedWireColorsBlended: mid-fade is a genuine per-LED mix of the two effects' own shapes") {
    // Chase (from) and Twinkle (to) each render their own distinct per-LED
    // pattern -- a correct crossfade mixes those two *shapes* pixel by
    // pixel, not just the aggregate base color (which is what the older,
    // buggy blendTowardIdle-only path did: it copied the target's effect
    // shape verbatim and only ramped r/g/b/intensity).
    LightFixture bar = makeBar("rgb", /*addressable*/ true, /*ledCount*/ 8);
    const auto from = makeEffectOutput(255, 0, 0, EffectParams::Type::Chase, 2.0f, 0.3);
    const auto to = makeEffectOutput(0, 0, 255, EffectParams::Type::Twinkle, 1.0f, 1.1);

    const auto fromColors = resolveLedWireColors(from, bar);
    const auto toColors = resolveLedWireColors(to, bar);
    const auto mid = resolveLedWireColorsBlended(from, to, bar, 0.5);
    REQUIRE(mid.size() == 8);

    bool differsFromBothEndpoints = false;
    for (size_t i = 0; i < mid.size(); ++i) {
        // Every mid-fade LED must be exactly the arithmetic midpoint of what
        // each side's own resolveLedWireColors produced at that index.
        CHECK(mid[i].r == static_cast<uint8_t>((static_cast<int>(fromColors[i].r) + toColors[i].r) / 2));
        CHECK(mid[i].g == static_cast<uint8_t>((static_cast<int>(fromColors[i].g) + toColors[i].g) / 2));
        CHECK(mid[i].b == static_cast<uint8_t>((static_cast<int>(fromColors[i].b) + toColors[i].b) / 2));

        const bool matchesFrom =
            mid[i].r == fromColors[i].r && mid[i].g == fromColors[i].g && mid[i].b == fromColors[i].b;
        const bool matchesTo =
            mid[i].r == toColors[i].r && mid[i].g == toColors[i].g && mid[i].b == toColors[i].b;
        if (!matchesFrom && !matchesTo)
            differsFromBothEndpoints = true;
    }
    CHECK(differsFromBothEndpoints);
}

TEST_CASE("resolveLedWireColorsBlended: a fixture missing from `from` fades in from black, per-LED") {
    LightFixture bar = makeBar("rgb", /*addressable*/ true, /*ledCount*/ 4);
    const ResolvedFixtureOutput from{}; // default-constructed -- fixture never had an active cue
    const auto to = makeSolidOutput(255, 255, 255);

    const auto mid = resolveLedWireColorsBlended(from, to, bar, 0.5);
    REQUIRE(mid.size() == 4);
    for (const auto& c : mid) {
        CHECK(c.r == 127);
        CHECK(c.g == 127);
        CHECK(c.b == 127);
    }
}
