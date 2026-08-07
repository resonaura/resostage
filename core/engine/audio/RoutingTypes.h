#pragma once

#include "../project/ProjectSchema.h"

#include <cstdint>
#include <vector>

namespace resostage {

// One (track -> bus) edge. A track may appear in multiple TrackRoute entries
// (main bus + aux sends). Main routes use track gain/pan; aux sends multiply
// an extra sendGainLinear (and optionally ignore track fader when preFader).
struct TrackRoute {
    uint32_t trackIndex = 0;
    uint32_t busIndex = 0;
    float gainLinear = 1.0f;     // already includes track fader unless preFader send
    float sendGainLinear = 1.0f; // aux send level (1.0 for main routes)
    float pan = 0.0f;            // -1..+1, applied when the destination bus has 2 channels
    bool mute = false;
    bool isAuxSend = false;
    // Force mono sum of the track before pan (TrackDef.mono).
    bool forceMono = false;
    // Which source channel feeds a ONE-channel (mono lane) destination:
    //   -1 = sum L+R (mono collapse / single-lane target)
    //    0 = place the LEFT source channel only
    //    1 = place the RIGHT source channel only
    // Routes a stereo track into a pair of mono lanes ("direct:3,direct:4") as
    // true stereo (L -> first lane, R -> second) instead of collapsing both.
    // Ignored when the destination bus has 2 channels.
    int8_t sourceChannel = -1;
};

// A bus's assignment to a contiguous range of physical output channels.
struct BusOutput {
    uint32_t busIndex = 0;
    int startChannel = 0; // first physical output channel index (0-based)
    int channelCount = 2; // 1 = mono, 2 = stereo
    float gainLinear = 1.0f;
    float pan = 0.0f; // -1..+1 balance on physical L/R
    bool mute = false;
    // Global "Direct Output" lane buses write a mono signal to exactly ONE
    // physical channel (no stereo-pair doubling). Set only for the global
    // direct-out mono lanes fabricated from the active output channels --
    // project busses keep the existing "mono hits both speakers" behavior.
    bool singleChannel = false;
    OutputType outputType = OutputType::ExtOut;
};

// An immutable, fully-formed routing configuration. Built on the message/UI
// thread, then handed to RoutingEngine::publish() for atomic activation.
struct RoutingSnapshot {
    std::vector<TrackRoute> routes;
    std::vector<BusOutput> outputs;
    uint32_t busCount = 0; // distinct busses referenced, for scratch-buffer sizing
};

} // namespace resostage
