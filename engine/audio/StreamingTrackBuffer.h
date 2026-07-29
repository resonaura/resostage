#pragma once

#include "../project/ProjectLoader.h"
#include "AudioRingBuffer.h"
#include "WavStreamDecoder.h"

#include <atomic>
#include <string>
#include <vector>

namespace resoset {

// Streams one audio stem from a .rsnraset archive entry into a bounded SPSC
// ring buffer — or, when budget allows, holds the *used source window* in RAM
// so mid-song disk I/O is zero for that stem.
//
// Smart residency: only the region’s sourceOffset..sourceOffset+usedLength is
// loaded (not timeline silence before the clip, not unused tail of a long WAV).
// Looping clips load the loopable body once; AudioEngine maps wraps on read.
//
// Two roles:
//   - Background I/O: open(), refill(), tryLoadResident(), hardSeekTo()
//   - Audio thread: read() — never blocks/allocates
class StreamingTrackBuffer {
public:
    bool open(const ProjectLoader& loader, const std::string& archivePath, int64_t ringCapacityFrames,
              double deviceSampleRate, std::string& error);

    int numChannels() const { return decoder.numChannels(); }
    double sourceSampleRate() const { return decoder.sampleRate(); }
    double deviceSampleRate() const { return openDeviceSampleRate; }
    int64_t totalFrames() const {
        return resampleRatio > 0.0
                   ? static_cast<int64_t>(static_cast<double>(decoder.totalFrames()) / resampleRatio + 0.5)
                   : decoder.totalFrames();
    }

    // Preferred RAM window in device frames (set by StreamingEngine from Region).
    // Defaults to full file after open.
    void setPreferredResidentWindow(int64_t deviceStart, int64_t deviceLength);
    int64_t preferredResidentStart() const { return preferredStart; }
    int64_t preferredResidentLength() const { return preferredLength; }
    size_t estimatedResidentBytes() const;

    // Decode preferred (or explicit) window into RAM. Closes the disk cursor on
    // success so the file handle is free. Fails soft if over maxBytes.
    bool tryLoadResident(size_t maxBytes, size_t& outBytes, std::string& error);
    bool isResident() const { return residentActive; }
    size_t residentBytes() const { return residentByteCount; }
    void releaseResident();

    bool refill();

    bool hardSeekTo(int64_t deviceFrame, std::string& error);

    int64_t read(float* const* outChannels, int64_t numFrames, int64_t expectedPosition);

    bool isExhausted() const {
        if (residentActive) {
            const int64_t pos = readPosition.load(std::memory_order_relaxed);
            return pos >= residentStart + residentLength;
        }
        return sourceExhausted.load(std::memory_order_acquire) && ring.framesAvailable() == 0;
    }

    int64_t framesAvailable() const {
        if (residentActive) {
            // Report "full ring" so IO prioritization treats us as healthy.
            return ring.capacity() > 0 ? ring.capacity() : preferredLength;
        }
        return ring.framesAvailable();
    }
    int64_t framesFree() const {
        if (residentActive)
            return 0;
        return ring.framesFree();
    }
    int64_t ringCapacity() const { return ring.capacity(); }
    bool sourceIsExhausted() const {
        if (residentActive)
            return true; // no more disk work
        return sourceExhausted.load(std::memory_order_acquire);
    }
    bool hasPendingSkip() const {
        if (residentActive)
            return false;
        return pendingSkipFrames.load(std::memory_order_acquire) > 0;
    }
    bool wantsRefill() const {
        if (residentActive)
            return false;
        if (hasPendingSkip())
            return true;
        return !sourceIsExhausted() && ring.framesFree() > 0;
    }

private:
    void closeDiskCursor();
    bool decodeIntoResident(int64_t deviceStart, int64_t deviceFrames, std::string& error);

    ProjectLoader::StreamCursor cursor;
    WavStreamDecoder decoder;
    AudioRingBuffer ring;

    const ProjectLoader* openLoader = nullptr;
    std::string openArchivePath;
    int64_t openRingCapacityFrames = 0;
    double openDeviceSampleRate = 0.0;

    std::atomic<int64_t> readPosition{0};
    std::atomic<int64_t> pendingSkipFrames{0};
    std::atomic<bool> sourceExhausted{false};

    std::vector<std::vector<float>> refillScratch;
    std::vector<float*> refillWritePtrs;
    std::vector<const float*> refillReadPtrs;
    static constexpr int64_t kRefillChunkFrames = 16384;

    double resampleRatio = 1.0;
    std::vector<std::vector<float>> nativeChunk;
    int64_t nativeChunkFrames = 0;
    int64_t nativeChunkReadIdx = 0;
    std::vector<float> lastNativeSample;
    bool haveLastNativeSample = false;
    double nativePhase = 0.0;

    // Preferred window (device domain) for smart preload.
    int64_t preferredStart = 0;
    int64_t preferredLength = 0; // 0 = unknown / full file after open

    // RAM residency (planar device-rate samples for [residentStart, +length)).
    bool residentActive = false;
    int64_t residentStart = 0;
    int64_t residentLength = 0;
    size_t residentByteCount = 0;
    std::vector<std::vector<float>> residentData; // [ch][frame]
};

} // namespace resoset
