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
    double deviceSampleRate() const { return openDeviceSampleRate; }
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

    // Message/IO-thread-only (never the audio callback). Re-opens the stem at
    // byte 0 and fast-forwards the source so the next read() at `deviceFrame`
    // returns the correct audio with no async catch-up gap. Without this,
    // seek leaves the click (pure math on the new playhead) immediately in
    // the right place while stems still skip on the background thread -- the
    // metronome "runs away" from the WAVs until the skip finishes.
    // Call only while the audio thread is not consuming this buffer (transport
    // stopped / under StreamingEngine's projectLoaderMutex with playback off).
    bool hardSeekTo(int64_t deviceFrame, std::string& error);

    // Audio-thread-only. Reads up to numFrames frames, resynchronizing first
    // if `expectedPosition` (absolute frames since song start, per
    // MasterClock) has moved ahead of this track's tracked position. Returns
    // frames actually written into outChannels (numChannels() planar arrays,
    // each with room for numFrames); any shortfall is the caller's silence to fill.
    int64_t read(float* const* outChannels, int64_t numFrames, int64_t expectedPosition);

    bool isExhausted() const {
        return sourceExhausted.load(std::memory_order_acquire) && ring.framesAvailable() == 0;
    }

    // Diagnostics / I/O prioritization (safe from I/O or message thread).
    int64_t framesAvailable() const { return ring.framesAvailable(); }
    int64_t framesFree() const { return ring.framesFree(); }
    int64_t ringCapacity() const { return ring.capacity(); }
    bool sourceIsExhausted() const {
        return sourceExhausted.load(std::memory_order_acquire);
    }
    // Catch-up skip still outstanding — I/O must service this before decode
    // of other healthy tracks, or the stem stays silent while click runs.
    bool hasPendingSkip() const {
        return pendingSkipFrames.load(std::memory_order_acquire) > 0;
    }
    // True when the ring still has room and the source can produce more,
    // OR a skip still needs the zip cursor (even if the ring is full of
    // nothing useful — skip is serviced before push).
    bool wantsRefill() const {
        if (hasPendingSkip())
            return true;
        return !sourceIsExhausted() && ring.framesFree() > 0;
    }

private:
    ProjectLoader::StreamCursor cursor;
    WavStreamDecoder decoder;
    AudioRingBuffer ring;

    // Retained so hardSeekTo can re-open without the caller re-passing them.
    const ProjectLoader* openLoader = nullptr;
    std::string openArchivePath;
    int64_t openRingCapacityFrames = 0;
    double openDeviceSampleRate = 0.0;

    std::atomic<int64_t> readPosition{0};      // audio-thread-owned; bg thread may read for diagnostics
    std::atomic<int64_t> pendingSkipFrames{0}; // frames the bg thread still needs to discard-at-source
    std::atomic<bool> sourceExhausted{false};

    // Background-thread-only scratch (reused across refill() — no per-call heap).
    std::vector<std::vector<float>> refillScratch;
    std::vector<float*> refillWritePtrs;
    std::vector<const float*> refillReadPtrs;
    // Larger chunks = fewer syscalls / better sequential SSD throughput under
    // load. ~341 ms at 48 kHz; still small vs multi-second ring capacity.
    static constexpr int64_t kRefillChunkFrames = 16384;

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
