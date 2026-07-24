#pragma once

#include <cstdint>
#include <vector>

namespace resoset {

// One (track -> bus) send edge. A track may appear in multiple TrackRoute
// entries to feed several busses at once (e.g. "Synths 1" feeding both the
// main FOH bus and the drummer's monitor bus).
struct TrackRoute {
    uint32_t trackIndex = 0;
    uint32_t busIndex = 0;
    float gainLinear = 1.0f;
    float pan = 0.0f; // -1..+1, applied when the destination bus has 2 channels
    bool mute = false;
};

// A bus's assignment to a contiguous range of physical output channels.
struct BusOutput {
    uint32_t busIndex = 0;
    int startChannel = 0; // first physical output channel index (0-based)
    int channelCount = 2; // 1 = mono, 2 = stereo
    float gainLinear = 1.0f;
    bool mute = false;
};

// An immutable, fully-formed routing configuration. Built on the message/UI
// thread, then handed to RoutingEngine::publish() for atomic activation.
struct RoutingSnapshot {
    std::vector<TrackRoute> routes;
    std::vector<BusOutput> outputs;
    uint32_t busCount = 0; // distinct busses referenced, for scratch-buffer sizing
};

} // namespace resoset
