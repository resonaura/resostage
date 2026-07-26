#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

namespace resoset {

// Lock-free single-producer/single-consumer ring buffer of planar float audio
// frames. The producer (background I/O thread) writes decoded frames; the
// consumer (real-time audio thread) reads them. Capacity is fixed at
// prepare() time (allocates); push()/pop()/discard() never allocate.
class AudioRingBuffer {
public:
    // Allocates storage for `capacityFrames` frames across `channels` planar
    // channels. Must be called before use, from a non-real-time thread.
    void prepare(int channels, int64_t capacityFrames);

    int numChannels() const { return channelCount; }
    int64_t capacity() const { return capacityFramesValue; }

    // Producer-only. Writes up to numFrames frames from planar `inChannels`.
    // Returns frames actually written (less than numFrames if the buffer fills up).
    int64_t push(const float* const* inChannels, int64_t numFrames);

    // Consumer-only. Reads up to numFrames frames into planar `outChannels`.
    // Returns frames actually read (less than numFrames on underrun -- caller
    // should treat the shortfall as silence; this never blocks).
    int64_t pop(float* const* outChannels, int64_t numFrames);

    // Consumer-only. Discards (drops without copying out) up to numFrames
    // buffered frames -- used for catch-up after a stall. Returns frames
    // actually discarded.
    int64_t discard(int64_t numFrames);

    // Safe from either thread (diagnostics / refill-threshold checks).
    int64_t framesAvailable() const;
    int64_t framesFree() const { return capacityFramesValue - framesAvailable(); }

    // Consumer-only: resets to empty (used when reinitializing a track's stream).
    void reset();

private:
    int channelCount = 0;
    int64_t capacityFramesValue = 0;
    std::vector<std::vector<float>> storage; // [channel][capacityFrames]

    alignas(64) std::atomic<int64_t> writeIndex{0}; // producer-owned, monotonic
    alignas(64) std::atomic<int64_t> readIndex{0};  // consumer-owned, monotonic
};

} // namespace resoset
