#pragma once

#include "project/ProjectSchema.h"

#include <algorithm>
#include <string>
#include <vector>

namespace resostage {

// Channels needed to drive one ResoLight bar: 3 per LED (RGB) if
// addressable, else a single RGB triplet drives the whole bar uniformly.
inline int resoLightBarChannelCount(int ledCount, bool addressable) {
    if (ledCount <= 0)
        ledCount = 1;
    return addressable ? ledCount * 3 : 3;
}

struct ResoLightChannelAssignment {
    std::string fixtureId;
    int universe = 0;
    int startChannel = 1; // 1-based, within `universe`
    int channelCount = 0;
};

// Packs every ResoLightBar fixture sequentially into 512-channel DMX
// universes, in fixture list order. Never splits one fixture's channels
// across two universes -- a bar's LEDs must stay a contiguous addressable
// run -- so a fixture that wouldn't fit in the current universe starts the
// next one early rather than spilling over. DmxGeneric fixtures are NOT
// auto-packed here -- they carry their own explicit universe/start
// channel/count (set directly in the rig editor, same fields
// LightFixtureUpdate writes), appended verbatim afterward. This is the
// single source of truth for "which DMX channels does each fixture
// actually own" -- LightEngine's real-time write path and any future
// channel-conflict UI both need to agree with this, not re-derive it.
inline std::vector<ResoLightChannelAssignment> assignResoLightChannels(
    const std::vector<LightFixture>& fixtures) {
    constexpr int kChannelsPerUniverse = 512;
    std::vector<ResoLightChannelAssignment> out;
    out.reserve(fixtures.size());

    int universe = 0;
    int nextChannel = 1; // 1-based

    for (const auto& f : fixtures) {
        if (f.kind != LightFixture::Kind::ResoLightBar)
            continue;
        const int count = resoLightBarChannelCount(f.ledCount, f.addressable);
        if (nextChannel != 1 && nextChannel + count - 1 > kChannelsPerUniverse) {
            ++universe;
            nextChannel = 1;
        }
        out.push_back({f.id, universe, nextChannel, count});
        nextChannel += count;
    }

    for (const auto& f : fixtures) {
        if (f.kind != LightFixture::Kind::DmxGeneric)
            continue;
        out.push_back({f.id, f.dmxUniverse, f.dmxStartChannel, std::max(1, f.dmxChannelCount)});
    }
    return out;
}

} // namespace resostage
