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
    c.color.r = r;
    c.color.g = g;
    c.color.b = b;
    c.intensity = intensity;
    c.fade.inSeconds = fadeIn;
    c.fade.outSeconds = fadeOut;
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

TEST_CASE("parseEffectType recognises the addressable effect library") {
    CHECK(parseEffectType("converge") == EffectParams::Type::Converge);
    CHECK(parseEffectType("gradientflow") == EffectParams::Type::GradientFlow);
    CHECK(parseEffectType("chase") == EffectParams::Type::Chase);
    CHECK(parseEffectType("helix") == EffectParams::Type::Helix);
    CHECK(parseEffectType("plasma") == EffectParams::Type::Plasma);
    CHECK(parseEffectType("twinkle") == EffectParams::Type::Twinkle);
    CHECK(parseEffectType("sonicboom") == EffectParams::Type::SonicBoom);
    CHECK(parseEffectType("bogus") == EffectParams::Type::None);
}

TEST_CASE("effectTypeToString round-trips every known type through parseEffectType") {
    for (auto type : {EffectParams::Type::None, EffectParams::Type::Meter, EffectParams::Type::Strobe,
                       EffectParams::Type::Pulse, EffectParams::Type::Ripple, EffectParams::Type::Converge,
                       EffectParams::Type::GradientFlow, EffectParams::Type::Chase,
                       EffectParams::Type::Helix, EffectParams::Type::Plasma,
                       EffectParams::Type::Twinkle, EffectParams::Type::SonicBoom,
                       EffectParams::Type::Fire, EffectParams::Type::Bouncing,
                       EffectParams::Type::Drip, EffectParams::Type::Fireworks,
                       EffectParams::Type::Colorwaves, EffectParams::Type::StrobeSwipe,
                       EffectParams::Type::VuPeak, EffectParams::Type::Geq, EffectParams::Type::Blurz,
                       EffectParams::Type::Scanner, EffectParams::Type::Lightning,
                       EffectParams::Type::Barberpole}) {
        CHECK(parseEffectType(effectTypeToString(type)) == type);
    }
}

TEST_CASE("addressable tempo effects begin on a deterministic beat phase") {
    uint8_t r, g, b;
    double first, repeated;
    addressableEffectLedColor(4, 12, EffectParams::Type::Chase, 0.0, 2.0f,
                              10, 20, 30, r, g, b, first);
    // At exactly one whole cycle later the spatial output is bit-for-bit the
    // same: this is the invariant that binds all tempo-synced cues to clock
    // ticks instead of to an accumulated animation timer.
    addressableEffectLedColor(4, 12, EffectParams::Type::Chase, 0.5, 2.0f,
                              10, 20, 30, r, g, b, repeated);
    CHECK(repeated == doctest::Approx(first));
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

// ─── Fire ───────────────────────────────────────────────────────────────────

TEST_CASE("Fire: deterministic -- identical inputs give bit-identical output") {
    uint8_t r1, g1, b1, r2, g2, b2;
    double l1, l2;
    addressableEffectLedColor(7, 40, EffectParams::Type::Fire, 3.14, 1.5f, 0, 0, 0, r1, g1, b1, l1);
    addressableEffectLedColor(7, 40, EffectParams::Type::Fire, 3.14, 1.5f, 0, 0, 0, r2, g2, b2, l2);
    CHECK(r1 == r2);
    CHECK(g1 == g2);
    CHECK(b1 == b2);
    CHECK(l1 == doctest::Approx(l2));
}

TEST_CASE("Fire: level is always fully open -- brightness is baked into the sampled color") {
    uint8_t r, g, b;
    double level;
    addressableEffectLedColor(10, 40, EffectParams::Type::Fire, 5.0, 2.0f, 0, 0, 0, r, g, b, level);
    CHECK(level == doctest::Approx(1.0));
}

TEST_CASE("Fire: a grayscale custom palette keeps every LED perfectly gray") {
    // Any two-stop palette interpolates linearly per channel -- a black/white
    // palette must therefore always land on r==g==b, regardless of the noise
    // field's value. A real (non-grayscale) palette can't be asserted this
    // precisely without duplicating the noise formula, so this is the
    // sturdiest palette-is-actually-used regression check available.
    const std::vector<GradientStop> grayscale = {{0, 0, 0}, {255, 255, 255}};
    for (int i = 0; i < 40; i += 7) {
        uint8_t r, g, b;
        double level;
        addressableEffectLedColor(i, 40, EffectParams::Type::Fire, 2.0, 1.0f, 0, 0, 0, r, g, b, level, &grayscale);
        CHECK(r == g);
        CHECK(g == b);
    }
}

TEST_CASE("Fire: with no palette given, falls back to the built-in Vulcan (warm) palette") {
    // Vulcan's stops are all r >= g >= b (black -> red -> orange -> yellow ->
    // white) -- true at every one of its stops and every linear interpolation
    // between them, so it must hold for any sampled heat value too.
    for (int i = 0; i < 40; i += 5) {
        uint8_t r, g, b;
        double level;
        addressableEffectLedColor(i, 40, EffectParams::Type::Fire, 4.0, 1.0f, 0, 0, 0, r, g, b, level);
        CHECK(r >= g);
        CHECK(g >= b);
    }
}

// ─── Colorwaves ─────────────────────────────────────────────────────────────

TEST_CASE("Colorwaves: different LED positions get different colors at the same instant") {
    uint8_t r0, g0, b0, r1, g1, b1;
    double l0, l1;
    addressableEffectLedColor(0, 40, EffectParams::Type::Colorwaves, 0.0, 1.0f, 0, 0, 0, r0, g0, b0, l0);
    addressableEffectLedColor(20, 40, EffectParams::Type::Colorwaves, 0.0, 1.0f, 0, 0, 0, r1, g1, b1, l1);
    CHECK((r0 != r1 || g0 != g1 || b0 != b1));
    CHECK(l0 == doctest::Approx(1.0));
    CHECK(l1 == doctest::Approx(1.0));
}

TEST_CASE("Colorwaves: a grayscale custom palette keeps every LED perfectly gray") {
    const std::vector<GradientStop> grayscale = {{0, 0, 0}, {255, 255, 255}};
    for (int i = 0; i < 40; i += 7) {
        uint8_t r, g, b;
        double level;
        addressableEffectLedColor(i, 40, EffectParams::Type::Colorwaves, 1.5, 1.0f, 0, 0, 0, r, g, b, level, &grayscale);
        CHECK(r == g);
        CHECK(g == b);
    }
}

// ─── Bouncing / Drip / Fireworks (closed-form kinematics) ──────────────────

TEST_CASE("Bouncing: the first ball starts each cycle at the bottom LED, fully bright") {
    uint8_t r, g, b;
    double level;
    // tSec=0 is cyclePos=0 for ball 0 (its k*phase offset is also 0) -- the
    // envelope and bounce phase are both exactly at their cycle-start value,
    // landing the ball exactly on LED 0 (t=0) with no falloff.
    addressableEffectLedColor(0, 21, EffectParams::Type::Bouncing, 0.0, 1.0f, 0, 0, 0, r, g, b, level);
    CHECK(level == doctest::Approx(1.0));
}

TEST_CASE("Bouncing: level always stays within 0..1") {
    for (double t = 0.0; t < 3.0; t += 0.37) {
        for (int i = 0; i < 21; i += 3) {
            uint8_t r, g, b;
            double level;
            addressableEffectLedColor(i, 21, EffectParams::Type::Bouncing, t, 1.3f, 0, 0, 0, r, g, b, level);
            CHECK(level >= 0.0);
            CHECK(level <= 1.0);
        }
    }
}

TEST_CASE("Drip: a droplet starts each cycle at the top LED") {
    uint8_t r, g, b;
    double level;
    // j=0's cyclePos is 0 at tSec=0 -> y = 1 - 0^2 = 1 (the tip).
    addressableEffectLedColor(20, 21, EffectParams::Type::Drip, 0.0, 1.0f, 10, 20, 30, r, g, b, level);
    CHECK(level == doctest::Approx(1.0));
}

TEST_CASE("Drip: level always stays within 0..1") {
    for (double t = 0.0; t < 3.0; t += 0.41) {
        for (int i = 0; i < 21; i += 3) {
            uint8_t r, g, b;
            double level;
            addressableEffectLedColor(i, 21, EffectParams::Type::Drip, t, 0.8f, 0, 0, 0, r, g, b, level);
            CHECK(level >= 0.0);
            CHECK(level <= 1.0);
        }
    }
}

TEST_CASE("Fireworks: during the launch phase the rocket keeps the cue's own color") {
    uint8_t r, g, b;
    double level;
    // cyclePos=0 at tSec=0 is well within the 0..0.3 launch window.
    addressableEffectLedColor(0, 21, EffectParams::Type::Fireworks, 0.0, 1.0f, 111, 22, 33, r, g, b, level);
    CHECK(r == 111);
    CHECK(g == 22);
    CHECK(b == 33);
    CHECK(level > 0.0);
}

TEST_CASE("Fireworks: level always stays within 0..1") {
    for (double t = 0.0; t < 3.0; t += 0.29) {
        for (int i = 0; i < 21; i += 3) {
            uint8_t r, g, b;
            double level;
            addressableEffectLedColor(i, 21, EffectParams::Type::Fireworks, t, 1.1f, 5, 5, 5, r, g, b, level);
            CHECK(level >= 0.0);
            CHECK(level <= 1.0);
        }
    }
}

// ─── StrobeSwipe ────────────────────────────────────────────────────────────

TEST_CASE("StrobeSwipe: right at a beat, only the base LED is lit -- the swipe hasn't reached the rest yet") {
    uint8_t r, g, b;
    double level;
    addressableEffectLedColor(0, 21, EffectParams::Type::StrobeSwipe, 0.0, 1.0f, 9, 8, 7, r, g, b, level);
    CHECK(level == doctest::Approx(1.0));
    CHECK(r == 9); CHECK(g == 8); CHECK(b == 7);

    addressableEffectLedColor(20, 21, EffectParams::Type::StrobeSwipe, 0.0, 1.0f, 9, 8, 7, r, g, b, level);
    CHECK(level == doctest::Approx(0.0));
}

TEST_CASE("StrobeSwipe: brightness decays monotonically as the beat ages, well after the swipe") {
    uint8_t r, g, b;
    double levelEarly, levelLate;
    // rateHz=1 -> phase == tSec here, both past the ~0.08 swipe window.
    addressableEffectLedColor(0, 21, EffectParams::Type::StrobeSwipe, 0.5, 1.0f, 9, 8, 7, r, g, b, levelEarly);
    addressableEffectLedColor(0, 21, EffectParams::Type::StrobeSwipe, 0.9, 1.0f, 9, 8, 7, r, g, b, levelLate);
    CHECK(levelLate < levelEarly);
}

// ─── VuPeak ─────────────────────────────────────────────────────────────────

TEST_CASE("VuPeak: fills continuously up to the audio level, with a highlighted cap") {
    uint8_t r, g, b;
    double belowLevel, atCapLevel, aboveLevel;
    // 0.5 of 21 LEDs (0-indexed, t = i/20) -> the fill boundary sits at i=10.
    addressableEffectLedColor(5, 21, EffectParams::Type::VuPeak, 0.0, 1.0f, 1, 2, 3, r, g, b, belowLevel, nullptr, 0.5f);
    addressableEffectLedColor(10, 21, EffectParams::Type::VuPeak, 0.0, 1.0f, 1, 2, 3, r, g, b, atCapLevel, nullptr, 0.5f);
    addressableEffectLedColor(15, 21, EffectParams::Type::VuPeak, 0.0, 1.0f, 1, 2, 3, r, g, b, aboveLevel, nullptr, 0.5f);
    CHECK(belowLevel > 0.0);
    CHECK(atCapLevel == doctest::Approx(1.0)); // the cap itself is the brightest point
    CHECK(aboveLevel == doctest::Approx(0.0)); // above the fill -- off
    CHECK(r == 1); CHECK(g == 2); CHECK(b == 3); // color is the cue's own, unlike GradientFlow/Fire/Colorwaves
}

// ─── Geq / Blurz ──────────────────────────────────────────────────────────────

TEST_CASE("Geq: LED brightness follows the interpolated band spectrum at its position") {
    const float bands[kLightBandCount] = {0.0f, 0.9f, 0.0f, 0.0f, 0.0f, 0.0f};
    uint8_t r, g, b;
    double lvl;

    // 21 LEDs: t = i/20. Band 1 sits at t = 1/5 = 0.2 -> LED 4 sits exactly
    // on it. LED 0 maps to band 0 (energy 0), LED 20 to band 5 (energy 0).
    addressableEffectLedColor(4, 21, EffectParams::Type::Geq, 3.14, 2.0f, 7, 8, 9, r, g, b, lvl, nullptr, 0.0f, bands);
    CHECK(lvl == doctest::Approx(0.9));
    CHECK(r == 7); CHECK(g == 8); CHECK(b == 9); // GEQ keeps the cue's own color

    addressableEffectLedColor(2, 21, EffectParams::Type::Geq, 3.14, 2.0f, 7, 8, 9, r, g, b, lvl, nullptr, 0.0f, bands);
    CHECK(lvl == doctest::Approx(0.45)); // t=0.1 -> halfway between band 0 and band 1

    addressableEffectLedColor(0, 21, EffectParams::Type::Geq, 3.14, 2.0f, 7, 8, 9, r, g, b, lvl, nullptr, 0.0f, bands);
    CHECK(lvl == doctest::Approx(0.0));

    addressableEffectLedColor(20, 21, EffectParams::Type::Geq, 3.14, 2.0f, 7, 8, 9, r, g, b, lvl, nullptr, 0.0f, bands);
    CHECK(lvl == doctest::Approx(0.0));
}

TEST_CASE("Geq: null or all-zero band data reads as dark") {
    uint8_t r, g, b;
    double lvl;
    const float zeros[kLightBandCount] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};

    addressableEffectLedColor(10, 21, EffectParams::Type::Geq, 0.0, 1.0f, 5, 6, 7, r, g, b, lvl, nullptr, 0.0f, zeros);
    CHECK(lvl == doctest::Approx(0.0));
    addressableEffectLedColor(10, 21, EffectParams::Type::Geq, 0.0, 1.0f, 5, 6, 7, r, g, b, lvl);
    CHECK(lvl == doctest::Approx(0.0)); // no bandLevels pointer at all
}

TEST_CASE("Blurz: a lone loud band paints that band's hue where it sits and goes dark far away") {
    const float bands[kLightBandCount] = {1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
    uint8_t r, g, b;
    double lvl;

    // Band 0's hue is red (hue 0). Its gaussian footprint keeps the wash
    // localised: right on the band full-brightness red, several LED widths
    // away effectively nothing.
    addressableEffectLedColor(0, 21, EffectParams::Type::Blurz, 1.23, 4.0f, 9, 9, 9, r, g, b, lvl, nullptr, 0.0f, bands);
    CHECK(lvl == doctest::Approx(1.0));
    CHECK(r > 200);
    CHECK(g < 60);
    CHECK(b < 60);

    addressableEffectLedColor(10, 21, EffectParams::Type::Blurz, 1.23, 4.0f, 9, 9, 9, r, g, b, lvl, nullptr, 0.0f, bands);
    CHECK(lvl == doctest::Approx(0.0)); // far from the band's position -> dark
}

TEST_CASE("Blurz: an upper band paints its hue at the right place") {
    const float bands[kLightBandCount] = {0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f};
    uint8_t r, g, b;
    double lvl;

    // Band 3's hue = 3/6 = 0.5 -> cyan (0,255,255). Band 3 sits at t=0.6,
    // which is exactly LED 12 of a 21-LED bar.
    addressableEffectLedColor(12, 21, EffectParams::Type::Blurz, 0.0, 1.0f, 1, 1, 1, r, g, b, lvl, nullptr, 0.0f, bands);
    CHECK(lvl == doctest::Approx(1.0));
    CHECK(r < 60);
    CHECK(g > 200);
    CHECK(b > 200);
}

// ─── Scanner / Lightning / Barberpole (second concert-pack batch) ─────────

TEST_CASE("Scanner: at tSec=0 the bright point sits at the bottom LED, in the cue's own color") {
    uint8_t r, g, b;
    double level;
    addressableEffectLedColor(0, 21, EffectParams::Type::Scanner, 0.0, 1.0f, 10, 20, 30, r, g, b, level);
    CHECK(level == doctest::Approx(1.0));
    CHECK(r == 10); CHECK(g == 20); CHECK(b == 30);
}

TEST_CASE("Scanner: the point reaches the top LED at the half-cycle point, then returns to the bottom") {
    uint8_t r, g, b;
    double levelAtTop, levelBackAtBottom;
    // rateHz=1 -> phase == tSec (mod 1): phase=0.5 is the triangle wave's peak (pos=1).
    addressableEffectLedColor(20, 21, EffectParams::Type::Scanner, 0.5, 1.0f, 0, 0, 0, r, g, b, levelAtTop);
    CHECK(levelAtTop == doctest::Approx(1.0));
    // A full cycle later (phase wraps back to 0) the point is back at the bottom.
    addressableEffectLedColor(0, 21, EffectParams::Type::Scanner, 1.0, 1.0f, 0, 0, 0, r, g, b, levelBackAtBottom);
    CHECK(levelBackAtBottom == doctest::Approx(1.0));
}

TEST_CASE("Scanner: level always stays within 0..1") {
    for (double t = 0.0; t < 3.0; t += 0.31) {
        for (int i = 0; i < 21; i += 3) {
            uint8_t r, g, b;
            double level;
            addressableEffectLedColor(i, 21, EffectParams::Type::Scanner, t, 1.7f, 0, 0, 0, r, g, b, level);
            CHECK(level >= 0.0);
            CHECK(level <= 1.0);
        }
    }
}

TEST_CASE("Lightning: level always stays within 0..1, and color is either the cue's own or a white-hot flash") {
    bool sawBaseColor = false;
    bool sawWhiteHot = false;
    // 40 distinct one-second "shot" cycles at rateHz=1 -- comfortably enough
    // draws that both the ~35% strike branch and the ~65% dark branch are
    // certain to appear (P(missing either) is astronomically small).
    for (double t = 0.0; t < 40.0; t += 0.05) {
        uint8_t r, g, b;
        double level;
        addressableEffectLedColor(5, 21, EffectParams::Type::Lightning, t, 1.0f, 10, 20, 30, r, g, b, level);
        CHECK(level >= 0.0);
        CHECK(level <= 1.0);
        const bool isBase = r == 10 && g == 20 && b == 30;
        const bool isWhiteHot = r == 235 && g == 240 && b == 255;
        CHECK((isBase || isWhiteHot));
        sawBaseColor = sawBaseColor || isBase;
        sawWhiteHot = sawWhiteHot || isWhiteHot;
    }
    CHECK(sawBaseColor);
    CHECK(sawWhiteHot);
}

TEST_CASE("Barberpole: hard-edged stripes alternate between full brightness and a dim shadow band") {
    uint8_t r, g, b;
    double levelOnStripe, levelOffStripe;
    // 13 LEDs -> t = i/12. i=0 -> t=0 (stripePos=0, on-stripe). i=1 -> t=1/12,
    // scaled by kStripeCount=6 lands exactly on the stripe's 0.5 boundary.
    addressableEffectLedColor(0, 13, EffectParams::Type::Barberpole, 0.0, 1.0f, 9, 8, 7, r, g, b, levelOnStripe);
    CHECK(levelOnStripe == doctest::Approx(1.0));
    CHECK(r == 9); CHECK(g == 8); CHECK(b == 7); // no palette given -> falls back to the cue's own color

    addressableEffectLedColor(1, 13, EffectParams::Type::Barberpole, 0.0, 1.0f, 9, 8, 7, r, g, b, levelOffStripe);
    CHECK(levelOffStripe == doctest::Approx(0.12));
}

TEST_CASE("Barberpole: the pattern scrolls over time -- the same LED cycles bright/dim") {
    uint8_t r, g, b;
    double levelAtStart, levelQuarterIn, levelNearlyFull;
    addressableEffectLedColor(0, 21, EffectParams::Type::Barberpole, 0.0, 1.0f, 0, 0, 0, r, g, b, levelAtStart);
    addressableEffectLedColor(0, 21, EffectParams::Type::Barberpole, 0.25, 1.0f, 0, 0, 0, r, g, b, levelQuarterIn);
    addressableEffectLedColor(0, 21, EffectParams::Type::Barberpole, 0.9, 1.0f, 0, 0, 0, r, g, b, levelNearlyFull);
    CHECK(levelAtStart == doctest::Approx(1.0));
    CHECK(levelQuarterIn == doctest::Approx(0.12));
    CHECK(levelNearlyFull == doctest::Approx(1.0));
}
