#pragma once

#include "../project/ProjectLoader.h"
#include "AudioRingBuffer.h"
#include "WavStreamDecoder.h"

#include <atomic>
#include <string>
#include <vector>

namespace resoset {

// Streams one audio stem from a .rsnraset archive entry into a bounded SPSC
// ring buffer. Two roles interact with an instance:
//
//   - The background I/O thread (owned by StreamingEngine) calls open() once,
//     then refill() repeatedly to keep the ring buffer topped up, and
//     services skip requests queued by the audio thread.
//   - The real-time audio thread calls read() every render block. read()
//     never blocks and never allocates; on underrun it returns fewer frames
//     than requested (caller treats the shortfall as silence).
//
// Catch-up semantics: if the audio thread's expected read position (driven by
// MasterClock) jumps ahead of this track's position -- e.g. after a stalled
// audio callback -- read() first discards buffered frames it can, and if that
// isn't enough, queues a skip so the background thread fast-forwards the
// source past the remainder. Silence is produced in the meantime; no stale
// (pre-skip) audio is ever played, because refill() only ever does ONE of
// {service the pending skip, decode+push fresh audio} per call, in that
// order -- so nothing new is pushed while a skip is outstanding.
class StreamingTrackBuffer {
public:
    // Opens the stream and parses its WAV header synchronously. Call from the
    // background thread or the message thread before playback starts --
    // NEVER from the audio thread. `deviceSampleRate` is the audio device's
    // operating rate: the ring buffer, read()/expectedPosition, and
    // totalFrames() all speak in that domain (frames-per-second-of-real-
    // time), while the source WAV may have been authored at a different
    // native rate -- refill() resamples (linear interpolation) between the
    // two so a 44.1kHz stem plays at the correct pitch/duration on a 48kHz
    // device instead of running fast and ending early (or the reverse).
    bool open(const ProjectLoader& loader, const std::string& archivePath, int64_t ringCapacityFrames,
              double deviceSampleRate, std::string& error);

    int numChannels() const { return decoder.numChannels(); }
    double sourceSampleRate() const { return decoder.sampleRate(); }
    // Frame count in the OUTPUT (device) domain -- see open()'s doc comment.
    int64_t totalFrames() const {
        return resampleRatio > 0.0
                   ? static_cast<int64_t>(static_cast<double>(decoder.totalFrames()) / resampleRatio + 0.5)
                   : decoder.totalFrames();
    }

    // Background-thread-only. Services a pending skip request or pulls more
    // decoded audio into the ring buffer (never both in one call). Returns
    // false once the source is exhausted AND the ring buffer is empty --
    // i.e. this track will never produce anything more.
    bool refill();

    // Audio-thread-only. Reads up to numFrames frames, resynchronizing first
    // if `expectedPosition` (absolute frames since song start, per
    // MasterClock) has moved ahead of this track's tracked position. Returns
    // frames actually written into outChannels (numChannels() planar arrays,
    // each with room for numFrames); any shortfall is the caller's silence to fill.
    int64_t read(float* const* outChannels, int64_t numFrames, int64_t expectedPosition);

    bool isExhausted() const {
        return sourceExhausted.load(std::memory_order_acquire) && ring.framesAvailable() == 0;
    }

private:
    ProjectLoader::StreamCursor cursor;
    WavStreamDecoder decoder;
    AudioRingBuffer ring;

    std::atomic<int64_t> readPosition{0};      // audio-thread-owned; bg thread may read for diagnostics
    std::atomic<int64_t> pendingSkipFrames{0}; // frames the bg thread still needs to discard-at-source
    std::atomic<bool> sourceExhausted{false};

    // Background-thread-only scratch decode target (reused across refill() calls).
    std::vector<std::vector<float>> refillScratch;
    static constexpr int64_t kRefillChunkFrames = 4096;

    // Background-thread-only linear-interpolation resampler state, native
    // (decoder) domain -> device domain. resampleRatio = nativeRate /
    // deviceRate ("native frames advanced per device output frame"); 1.0
    // means no resampling needed (the common case: source already matches
    // the device rate) and refill() takes the old direct-copy fast path.
    double resampleRatio = 1.0;
    std::vector<std::vector<float>> nativeChunk; // planar, decoded-but-not-fully-consumed native frames
    int64_t nativeChunkFrames = 0;               // valid frames currently in nativeChunk
    int64_t nativeChunkReadIdx = 0;               // next unconsumed index into nativeChunk
    std::vector<float> lastNativeSample;          // most recently consumed native frame (interpolation anchor)
    bool haveLastNativeSample = false;
    double nativePhase = 0.0; // fractional distance from lastNativeSample to nativeChunk[nativeChunkReadIdx]
};

} // namespace resoset
