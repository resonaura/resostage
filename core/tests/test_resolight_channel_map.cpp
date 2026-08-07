#include "doctest.h"

#include "lighting/ResoLightChannelMap.h"

using namespace resostage;

namespace {

LightFixture makeBar(std::string id, int ledCount, bool addressable, std::string channelProfile = "rgb") {
    LightFixture f;
    f.id = std::move(id);
    f.kind = LightFixture::Kind::ResoLightBar;
    f.ledCount = ledCount;
    f.addressable = addressable;
    f.channelProfile = std::move(channelProfile);
    return f;
}

LightFixture makeGeneric(std::string id, int universe = 0, int startChannel = 1, int channelCount = 3) {
    LightFixture f;
    f.id = std::move(id);
    f.kind = LightFixture::Kind::DmxGeneric;
    f.dmx.universe = universe;
    f.dmx.startChannel = startChannel;
    f.dmx.channelCount = channelCount;
    return f;
}

} // namespace

TEST_CASE("resoLightBarChannelCount: addressable is 3 channels per LED") {
    CHECK(resoLightBarChannelCount(30, true) == 90);
    CHECK(resoLightBarChannelCount(1, true) == 3);
}

TEST_CASE("resoLightBarChannelCount: non-addressable is always 3 channels") {
    CHECK(resoLightBarChannelCount(30, false) == 3);
    CHECK(resoLightBarChannelCount(1, false) == 3);
    CHECK(resoLightBarChannelCount(500, false) == 3);
}

TEST_CASE("resoLightBarChannelCount: non-positive ledCount defaults to 1 LED") {
    CHECK(resoLightBarChannelCount(0, true) == 3);
    CHECK(resoLightBarChannelCount(-5, true) == 3);
}

TEST_CASE("colorProfileByteCount: dimmer=1, rgb=3, rgbw=4, unrecognised defaults to 3") {
    CHECK(colorProfileByteCount("dimmer") == 1);
    CHECK(colorProfileByteCount("rgb") == 3);
    CHECK(colorProfileByteCount("rgbw") == 4);
    CHECK(colorProfileByteCount("bogus") == 3);
    CHECK(colorProfileByteCount("") == 3);
}

TEST_CASE("resoLightBarChannelCount: channelProfile changes bytes-per-pixel") {
    CHECK(resoLightBarChannelCount(10, true, "dimmer") == 10);
    CHECK(resoLightBarChannelCount(10, true, "rgb") == 30);
    CHECK(resoLightBarChannelCount(10, true, "rgbw") == 40);
    CHECK(resoLightBarChannelCount(10, false, "rgbw") == 4);
    // Omitting the argument keeps today's always-RGB behavior -- existing
    // call sites (this file's own earlier tests included) must not need to
    // change just because this parameter was added.
    CHECK(resoLightBarChannelCount(10, true) == 30);
}

TEST_CASE("assignResoLightChannels: single non-addressable bar gets universe 0 channel 1") {
    std::vector<LightFixture> fixtures = {makeBar("bar1", 30, false)};
    auto out = assignResoLightChannels(fixtures);
    REQUIRE(out.size() == 1);
    CHECK(out[0].fixtureId == "bar1");
    CHECK(out[0].universe == 0);
    CHECK(out[0].startChannel == 1);
    CHECK(out[0].channelCount == 3);
}

TEST_CASE("assignResoLightChannels: multiple bars pack sequentially into one universe") {
    std::vector<LightFixture> fixtures = {
        makeBar("bar1", 10, true),  // 30 channels: 1..30
        makeBar("bar2", 10, false), // 3 channels: 31..33
    };
    auto out = assignResoLightChannels(fixtures);
    REQUIRE(out.size() == 2);
    CHECK(out[0].universe == 0);
    CHECK(out[0].startChannel == 1);
    CHECK(out[0].channelCount == 30);
    CHECK(out[1].universe == 0);
    CHECK(out[1].startChannel == 31);
    CHECK(out[1].channelCount == 3);
}

TEST_CASE("assignResoLightChannels: a fixture that wouldn't fit starts the next universe") {
    // 170 addressable LEDs = 510 channels (fits: 1..510), leaves only 2
    // channels free -- the next bar (even a tiny one) can't fit and must
    // roll over to universe 1 rather than spilling past channel 512.
    std::vector<LightFixture> fixtures = {
        makeBar("big", 170, true),
        makeBar("small", 1, false),
    };
    auto out = assignResoLightChannels(fixtures);
    REQUIRE(out.size() == 2);
    CHECK(out[0].universe == 0);
    CHECK(out[0].startChannel == 1);
    CHECK(out[0].channelCount == 510);
    CHECK(out[1].universe == 1);
    CHECK(out[1].startChannel == 1);
    CHECK(out[1].channelCount == 3);
}

TEST_CASE("assignResoLightChannels: DmxGeneric fixtures are NOT folded into the ResoLightBar auto-pack") {
    // A generic fixture placed between two bars in list order must not
    // shift the bars' auto-packed channel numbering -- ResoLightBar
    // channels are computed from ResoLightBar fixtures alone, then
    // DmxGeneric entries are appended afterward using their own fields.
    std::vector<LightFixture> fixtures = {
        makeGeneric("moving_head_1", 0, 50, 4),
        makeBar("bar1", 5, false),
        makeGeneric("moving_head_2", 1, 1, 8),
    };
    auto out = assignResoLightChannels(fixtures);
    REQUIRE(out.size() == 3);
    CHECK(out[0].fixtureId == "bar1");
    CHECK(out[0].universe == 0);
    CHECK(out[0].startChannel == 1);
    CHECK(out[0].channelCount == 3);
}

TEST_CASE("assignResoLightChannels: DmxGeneric fixtures use their own explicit universe/channel/count") {
    std::vector<LightFixture> fixtures = {
        makeGeneric("moving_head_1", 0, 50, 4),
        makeGeneric("moving_head_2", 1, 1, 8),
    };
    auto out = assignResoLightChannels(fixtures);
    REQUIRE(out.size() == 2);
    CHECK(out[0].fixtureId == "moving_head_1");
    CHECK(out[0].universe == 0);
    CHECK(out[0].startChannel == 50);
    CHECK(out[0].channelCount == 4);
    CHECK(out[1].fixtureId == "moving_head_2");
    CHECK(out[1].universe == 1);
    CHECK(out[1].startChannel == 1);
    CHECK(out[1].channelCount == 8);
}

TEST_CASE("assignResoLightChannels: DmxGeneric channel count is floored at 1") {
    std::vector<LightFixture> fixtures = {makeGeneric("mover", 0, 1, 0)};
    auto out = assignResoLightChannels(fixtures);
    REQUIRE(out.size() == 1);
    CHECK(out[0].channelCount == 1);
}

TEST_CASE("assignResoLightChannels: a bar's channelProfile changes its real packed channel count") {
    std::vector<LightFixture> fixtures = {
        makeBar("dimmerBar", 10, true, "dimmer"), // 10 channels: 1..10
        makeBar("rgbwBar", 5, true, "rgbw"),       // 20 channels: 11..30
    };
    auto out = assignResoLightChannels(fixtures);
    REQUIRE(out.size() == 2);
    CHECK(out[0].startChannel == 1);
    CHECK(out[0].channelCount == 10);
    CHECK(out[1].startChannel == 11);
    CHECK(out[1].channelCount == 20);
}

TEST_CASE("assignResoLightChannels: empty fixture list yields no assignments") {
    std::vector<LightFixture> fixtures;
    CHECK(assignResoLightChannels(fixtures).empty());
}
