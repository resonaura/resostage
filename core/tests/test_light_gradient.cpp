#include "doctest.h"

#include "lighting/LightGradient.h"

using namespace resostage;

TEST_CASE("parseGradientStops: parses two or more well-formed hex stops") {
    auto stops = parseGradientStops("#ff0040,#7c3aed,#00e5ff", {});
    REQUIRE(stops.size() == 3);
    CHECK(stops[0].r == 0xff); CHECK(stops[0].g == 0x00); CHECK(stops[0].b == 0x40);
    CHECK(stops[1].r == 0x7c); CHECK(stops[1].g == 0x3a); CHECK(stops[1].b == 0xed);
    CHECK(stops[2].r == 0x00); CHECK(stops[2].g == 0xe5); CHECK(stops[2].b == 0xff);
}

TEST_CASE("parseGradientStops: trims whitespace around stops") {
    auto stops = parseGradientStops(" #ff0000 , #00ff00 ", {});
    REQUIRE(stops.size() == 2);
    CHECK(stops[0].r == 255);
    CHECK(stops[1].g == 255);
}

TEST_CASE("parseGradientStops: a malformed token is skipped, not fatal to the whole parse") {
    auto stops = parseGradientStops("#ff0000,not-a-color,#00ff00", {});
    REQUIRE(stops.size() == 2);
    CHECK(stops[0].r == 255);
    CHECK(stops[1].g == 255);
}

TEST_CASE("parseGradientStops: fewer than two valid stops falls back") {
    const std::vector<GradientStop> fallback = {{1, 2, 3}, {4, 5, 6}};
    CHECK(parseGradientStops("", fallback)[0].r == 1);
    CHECK(parseGradientStops("#ff0000", fallback)[0].r == 1); // one stop isn't a gradient
    CHECK(parseGradientStops("garbage", fallback)[0].r == 1);
}

TEST_CASE("sampleGradient: t=0 and t=1 land exactly on the first/last stop") {
    const std::vector<GradientStop> stops = {{10, 20, 30}, {200, 210, 220}};
    uint8_t r, g, b;
    sampleGradient(stops, 0.0, r, g, b);
    CHECK(r == 10); CHECK(g == 20); CHECK(b == 30);
    sampleGradient(stops, 1.0, r, g, b);
    CHECK(r == 200); CHECK(g == 210); CHECK(b == 220);
}

TEST_CASE("sampleGradient: t=0.5 across two stops is their midpoint") {
    const std::vector<GradientStop> stops = {{0, 0, 0}, {100, 200, 255}};
    uint8_t r, g, b;
    sampleGradient(stops, 0.5, r, g, b);
    CHECK(r == 50);
    CHECK(g == 100);
    // 255/2 = 127.5 -> rounds to 128 (std::lround rounds half away from zero).
    CHECK(b == 128);
}

TEST_CASE("sampleGradient: clamps t outside 0..1") {
    const std::vector<GradientStop> stops = {{10, 10, 10}, {200, 200, 200}};
    uint8_t r, g, b;
    sampleGradient(stops, -5.0, r, g, b);
    CHECK(r == 10);
    sampleGradient(stops, 5.0, r, g, b);
    CHECK(r == 200);
}

TEST_CASE("sampleGradient: a multi-stop palette interpolates within the correct segment") {
    const std::vector<GradientStop> stops = {{0, 0, 0}, {255, 0, 0}, {255, 255, 0}};
    uint8_t r, g, b;
    // t=0.25 is halfway through the first segment (black -> red).
    sampleGradient(stops, 0.25, r, g, b);
    CHECK(r == 128);
    CHECK(g == 0);
    // t=0.75 is halfway through the second segment (red -> yellow).
    sampleGradient(stops, 0.75, r, g, b);
    CHECK(r == 255);
    CHECK(g == 128);
}

TEST_CASE("sampleGradient: an empty palette is black, a one-stop palette is a solid fill") {
    uint8_t r, g, b;
    sampleGradient({}, 0.5, r, g, b);
    CHECK(r == 0); CHECK(g == 0); CHECK(b == 0);
    sampleGradient({{9, 8, 7}}, 0.5, r, g, b);
    CHECK(r == 9); CHECK(g == 8); CHECK(b == 7);
}

TEST_CASE("builtinPalette: every named palette peaks at full brightness on both leading channels") {
    // Not asserting the blue channel too -- Vulcan's peak is a warm white
    // (255,255,220), not a pure one, by design.
    for (const std::string& name : {"vulcanFire", "toxicFire", "cryoFire", "cyberpunkFire"}) {
        const auto& p = builtinPalette(name);
        REQUIRE(p.size() >= 2);
        CHECK(p.back().r == 255);
        CHECK(p.back().g == 255);
    }
}

TEST_CASE("builtinPalette: an unknown name falls back to Vulcan") {
    CHECK(&builtinPalette("bogus") == &builtinPalette("vulcanFire"));
}
