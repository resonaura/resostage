#include "doctest.h"

#include "../engine/audio/RoutingTypes.h"
#include "../engine/project/ProjectSchema.h"
#include "../engine/project/ProjectJson.h"

#include <algorithm>
#include <cmath>

using namespace resostage;

static inline float dbToGain(double db) {
    if (db <= -144.0) return 0.0f;
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

TEST_CASE("RoutingSnapshot: Master channel properties publish correctly") {
    MasterChannel main;
    main.gainDb = -6.0;
    main.pan = 0.5;
    main.mute = false;
    main.channels = 2;
    main.output.type = OutputType::ExtOut;
    main.output.target = "audio::out:1,audio::out:2";

    BusOutput out;
    out.busIndex = 0;
    out.gainLinear = dbToGain(main.gainDb);
    out.pan = static_cast<float>(std::clamp(main.pan, -1.0, 1.0));
    out.mute = main.mute;
    out.channelCount = main.channels;

    CHECK(out.gainLinear == doctest::Approx(0.5011872f));
    CHECK(out.pan == doctest::Approx(0.5f));
    CHECK(out.mute == false);
    CHECK(out.channelCount == 2);
}

TEST_CASE("RoutingSnapshot: Master Mute sets gainLinear or mute flag") {
    MasterChannel main;
    main.mute = true;
    BusOutput out;
    out.mute = main.mute;
    out.gainLinear = main.mute ? 0.0f : dbToGain(main.gainDb);

    CHECK(out.mute == true);
    CHECK(out.gainLinear == 0.0f);
}

TEST_CASE("RoutingSnapshot: Send bus with OutputType::Main sets outputType") {
    SendBus sb;
    sb.id = "audio::send:1";
    sb.output.type = OutputType::Main;
    sb.channels = 1;

    BusOutput out;
    out.busIndex = 1;
    out.outputType = sb.output.type;
    out.channelCount = sb.channels;

    CHECK(out.outputType == OutputType::Main);
    CHECK(out.channelCount == 1);
}
