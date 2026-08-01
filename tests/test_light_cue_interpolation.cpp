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
