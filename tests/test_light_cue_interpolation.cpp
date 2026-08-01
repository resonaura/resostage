#include "doctest.h"

#include "lighting/LightCueInterpolation.h"

using namespace resostage;

namespace {

LightCue makeCue(double start, double dur, uint8_t r, uint8_t g, uint8_t b,
                  double intensity = 1.0, double fadeIn = 0.0, double fadeOut = 0.0,
                  std::string trackId = "t1") {
    LightCue c;
    c.trackId = std::move(trackId);
    c.startSeconds = start;
    c.durationSeconds = dur;
    c.colorR = r;
    c.colorG = g;
    c.colorB = b;
    c.intensity = intensity;
    c.fadeInSeconds = fadeIn;
    c.fadeOutSeconds = fadeOut;
    return c;
}

} // namespace

TEST_CASE("resolveLightCueValue: no cues at all is black") {
    std::vector<LightCue> cues;
    auto v = resolveLightCueValue(cues, 5.0);
    CHECK(v.r == 0);
    CHECK(v.g == 0);
    CHECK(v.b == 0);
    CHECK(v.intensity == 0.0);
}

TEST_CASE("resolveLightCueValue: before/after every cue is black") {
    std::vector<LightCue> cues = {makeCue(10.0, 5.0, 255, 0, 0)};
    CHECK(resolveLightCueValue(cues, 9.999).intensity == 0.0);
    CHECK(resolveLightCueValue(cues, 15.0).intensity == 0.0); // end is exclusive
    CHECK(resolveLightCueValue(cues, 20.0).intensity == 0.0);
}

TEST_CASE("resolveLightCueValue: inside a cue's held region with no fades returns full value") {
    std::vector<LightCue> cues = {makeCue(10.0, 5.0, 10, 20, 30, 0.8)};
    auto v = resolveLightCueValue(cues, 12.0);
    CHECK(v.r == 10);
    CHECK(v.g == 20);
    CHECK(v.b == 30);
    CHECK(v.intensity == doctest::Approx(0.8));
}

TEST_CASE("resolveLightCueValue: fade-in ramps intensity linearly, color is instant") {
    std::vector<LightCue> cues = {makeCue(0.0, 4.0, 255, 0, 0, 1.0, /*fadeIn=*/2.0)};
    CHECK(resolveLightCueValue(cues, 0.0).intensity == doctest::Approx(0.0));
    CHECK(resolveLightCueValue(cues, 1.0).intensity == doctest::Approx(0.5));
    auto mid = resolveLightCueValue(cues, 1.0);
    CHECK(mid.r == 255); // color already at full value during the fade
    CHECK(resolveLightCueValue(cues, 2.0).intensity == doctest::Approx(1.0));
}

TEST_CASE("resolveLightCueValue: fade-out ramps intensity down to zero by the cue's end") {
    std::vector<LightCue> cues = {makeCue(0.0, 4.0, 0, 255, 0, 1.0, 0.0, /*fadeOut=*/2.0)};
    CHECK(resolveLightCueValue(cues, 1.9).intensity == doctest::Approx(1.0));
    CHECK(resolveLightCueValue(cues, 2.0).intensity == doctest::Approx(1.0));
    CHECK(resolveLightCueValue(cues, 3.0).intensity == doctest::Approx(0.5));
    const double nearEnd = resolveLightCueValue(cues, 3.999).intensity;
    CHECK(nearEnd > 0.0);
    CHECK(nearEnd < 0.001);
}

TEST_CASE("resolveLightCueValue: fadeIn + fadeOut longer than duration clamps without overlap") {
    // duration=2, fadeIn=5 (clamped to 2), fadeOut=5 (clamped to 0 -- nothing left).
    std::vector<LightCue> cues = {makeCue(0.0, 2.0, 0, 0, 255, 1.0, 5.0, 5.0)};
    CHECK(resolveLightCueValue(cues, 0.0).intensity == doctest::Approx(0.0));
    CHECK(resolveLightCueValue(cues, 1.0).intensity == doctest::Approx(0.5));
    // Never reaches full intensity since fadeIn consumes the whole span, but
    // must never go negative or exceed 1 either.
    CHECK(resolveLightCueValue(cues, 1.999).intensity <= 1.0);
    CHECK(resolveLightCueValue(cues, 1.999).intensity >= 0.0);
}

TEST_CASE("resolveLightCueValue: overlapping cues -- the later-starting one wins outright") {
    std::vector<LightCue> cues = {
        makeCue(0.0, 10.0, 255, 0, 0, 1.0), // red, 0..10
        makeCue(5.0, 10.0, 0, 0, 255, 1.0), // blue, 5..15, starts mid-red
    };
    auto beforeOverlap = resolveLightCueValue(cues, 2.0);
    CHECK(beforeOverlap.r == 255);
    CHECK(beforeOverlap.b == 0);

    auto duringOverlap = resolveLightCueValue(cues, 7.0);
    CHECK(duringOverlap.r == 0);
    CHECK(duringOverlap.b == 255); // later cue overrides the still-running earlier one

    auto afterFirstEnds = resolveLightCueValue(cues, 12.0);
    CHECK(afterFirstEnds.b == 255);
}

TEST_CASE("resolveLightCueValue: cue order in the input vector doesn't matter") {
    std::vector<LightCue> cues = {
        makeCue(5.0, 10.0, 0, 0, 255, 1.0), // blue, later-starting, listed FIRST
        makeCue(0.0, 10.0, 255, 0, 0, 1.0), // red, earlier-starting, listed SECOND
    };
    auto v = resolveLightCueValue(cues, 7.0);
    CHECK(v.b == 255);
    CHECK(v.r == 0);
}

TEST_CASE("resolveLightCueValue: cues on other tracks don't affect the query (track filtering is the caller's job)") {
    // resolveLightCueValue itself is track-agnostic -- it just resolves
    // whatever list it's given. Filtering by LightTrack is the caller's
    // responsibility (pass only that track's cues in).
    std::vector<LightCue> cues = {makeCue(0.0, 10.0, 1, 2, 3, 1.0, 0.0, 0.0, "trackA")};
    auto v = resolveLightCueValue(cues, 5.0);
    CHECK(v.r == 1);
}

// ─── hsvToRgb ───────────────────────────────────────────────────────────────

TEST_CASE("hsvToRgb: primary hues land on pure channel colors") {
    uint8_t r, g, b;
    hsvToRgb(0.0, 1.0, 1.0, r, g, b); // red
    CHECK(r == 255); CHECK(g == 0); CHECK(b == 0);
    hsvToRgb(1.0 / 3.0, 1.0, 1.0, r, g, b); // green
    CHECK(r == 0); CHECK(g == 255); CHECK(b == 0);
    hsvToRgb(2.0 / 3.0, 1.0, 1.0, r, g, b); // blue
    CHECK(r == 0); CHECK(g == 0); CHECK(b == 255);
}

TEST_CASE("hsvToRgb: hue wraps outside 0..1") {
    uint8_t r1, g1, b1, r2, g2, b2;
    hsvToRgb(0.2, 1.0, 1.0, r1, g1, b1);
    hsvToRgb(1.2, 1.0, 1.0, r2, g2, b2); // one full turn further
    // Not bit-exact -- 1.2 - floor(1.2) accumulates a little floating-point
    // slop relative to 0.2 directly -- but must land on (near enough) the
    // same color.
    CHECK(std::abs(r1 - r2) <= 1);
    CHECK(std::abs(g1 - g2) <= 1);
    CHECK(std::abs(b1 - b2) <= 1);
}

TEST_CASE("hsvToRgb: zero saturation is a grey scaled by value") {
    uint8_t r, g, b;
    hsvToRgb(0.5, 0.0, 0.6, r, g, b);
    CHECK(r == g);
    CHECK(g == b);
    CHECK(r == static_cast<uint8_t>(153)); // 0.6 * 255, rounded down
}

// ─── parseEffectType / effectTypeToString ─────────────────────────────────

TEST_CASE("parseEffectType recognises converge and gradientflow") {
    CHECK(parseEffectType("converge") == EffectParams::Type::Converge);
    CHECK(parseEffectType("gradientflow") == EffectParams::Type::GradientFlow);
    CHECK(parseEffectType("bogus") == EffectParams::Type::None);
}

TEST_CASE("effectTypeToString round-trips every known type through parseEffectType") {
    for (auto type : {EffectParams::Type::None, EffectParams::Type::Meter, EffectParams::Type::Strobe,
                       EffectParams::Type::Pulse, EffectParams::Type::Ripple, EffectParams::Type::Converge,
                       EffectParams::Type::GradientFlow}) {
        CHECK(parseEffectType(effectTypeToString(type)) == type);
    }
}

// ─── applyEffect: Converge / GradientFlow whole-bar fallback ──────────────

TEST_CASE("applyEffect Converge: intensity grows from edge (t=0) toward the meeting point") {
    EffectParams p;
    p.type = EffectParams::Type::Converge;
    p.intensity = 1.0f;
    p.rateHz = 1.0f;

    p.tSec = 0.0; // lines at the edges
    CHECK(applyEffect({255, 255, 255, 1.0}, p).intensity == doctest::Approx(0.0));

    p.tSec = 0.999; // just before the lines meet at centre and the cycle restarts
    CHECK(applyEffect({255, 255, 255, 1.0}, p).intensity == doctest::Approx(0.999).epsilon(0.01));
}

TEST_CASE("applyEffect Converge does not touch color") {
    EffectParams p;
    p.type = EffectParams::Type::Converge;
    p.intensity = 1.0f;
    p.rateHz = 1.0f;
    p.tSec = 0.25;
    auto v = applyEffect({10, 20, 30, 1.0}, p);
    CHECK(v.r == 10);
    CHECK(v.g == 20);
    CHECK(v.b == 30);
}

TEST_CASE("applyEffect GradientFlow overrides color with a swept hue and uses depth as intensity") {
    EffectParams p;
    p.type = EffectParams::Type::GradientFlow;
    p.intensity = 0.5f;
    p.rateHz = 1.0f;
    p.tSec = 0.0;
    auto v = applyEffect({10, 20, 30, 1.0}, p);
    CHECK(v.r == 255); // hue=0 at tSec=0 -> pure red
    CHECK(v.g == 0);
    CHECK(v.b == 0);
    CHECK(v.intensity == doctest::Approx(0.5));
}

// ─── addressableEffectLedColor ─────────────────────────────────────────────

TEST_CASE("addressableEffectLedColor Converge: centre LED peaks first, edges last") {
    // 11 LEDs (indices 0..10), centre at index 5. At tSec=0 the band sits at
    // the edges, so the centre LED should be dim and an edge LED closer to
    // the band's start should be brighter.
    uint8_t r, g, b;
    double centreLevel, edgeLevel;
    addressableEffectLedColor(5, 11, EffectParams::Type::Converge, 0.0, 1.0f, 10, 20, 30, r, g, b, centreLevel);
    addressableEffectLedColor(0, 11, EffectParams::Type::Converge, 0.0, 1.0f, 10, 20, 30, r, g, b, edgeLevel);
    CHECK(edgeLevel > centreLevel);
    // Color is left untouched -- only `level` carries the shape.
    CHECK(r == 10);
    CHECK(g == 20);
    CHECK(b == 30);
}

TEST_CASE("addressableEffectLedColor Converge: just before the lines meet, the centre LED is the brightest") {
    uint8_t r, g, b;
    double centreLevel, edgeLevel;
    // rateHz=1, tSec=0.999 -> band position 0.4995, i.e. almost at centre.
    addressableEffectLedColor(5, 11, EffectParams::Type::Converge, 0.999, 1.0f, 10, 20, 30, r, g, b, centreLevel);
    addressableEffectLedColor(0, 11, EffectParams::Type::Converge, 0.999, 1.0f, 10, 20, 30, r, g, b, edgeLevel);
    CHECK(centreLevel > edgeLevel);
    CHECK(centreLevel == doctest::Approx(1.0).epsilon(0.01));
}

TEST_CASE("addressableEffectLedColor GradientFlow: different LED positions get different hues at the same instant") {
    // i=10 of 11 would land the LED's hue exactly back at 1.0 -> wraps to
    // the same color as i=0's hue=0.0, so pick a midpoint index instead.
    uint8_t r0, g0, b0, r1, g1, b1;
    double level0, level1;
    addressableEffectLedColor(0, 11, EffectParams::Type::GradientFlow, 0.0, 1.0f, 0, 0, 0, r0, g0, b0, level0);
    addressableEffectLedColor(5, 11, EffectParams::Type::GradientFlow, 0.0, 1.0f, 0, 0, 0, r1, g1, b1, level1);
    CHECK((r0 != r1 || g0 != g1 || b0 != b1));
    CHECK(level0 == doctest::Approx(1.0));
    CHECK(level1 == doctest::Approx(1.0));
}

TEST_CASE("addressableEffectLedColor: unrelated effect types leave color/level untouched") {
    uint8_t r, g, b;
    double level;
    addressableEffectLedColor(3, 10, EffectParams::Type::Strobe, 1.23, 4.0f, 5, 6, 7, r, g, b, level);
    CHECK(r == 5);
    CHECK(g == 6);
    CHECK(b == 7);
    CHECK(level == doctest::Approx(1.0));
}
