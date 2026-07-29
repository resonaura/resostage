#pragma once

#include "../project/ProjectLoader.h"
#include "AudioRingBuffer.h"
#include "WavStreamDecoder.h"

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

namespace resoset {

// Streams one stem into an SPSC ring, or holds a *used source window* in RAM.
//
// Concurrency contract (hardened for hopscotch + background residency):
//  - Audio thread: read() only. Never blocks, never takes diskIoMutex on the
//    resident path; ring path is SPSC vs refill under diskIoMutex.
//  - IO / resident threads: open/refill/hardSeek/tryLoadResident under
//    diskIoMutex where they touch cursor/ring.
//  - tryLoadResident decodes via a *side* stream into temporary storage, then
//    publishes with a single atomic store of residentActive — it never calls
//    open() on the live object mid-playback (that used to race read/refill).
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

    void setPreferredResidentWindow(int64_t deviceStart, int64_t deviceLength);
    int64_t preferredResidentStart() const { return preferredStart; }
    int64_t preferredResidentLength() const { return preferredLength; }
    size_t estimatedResidentBytes() const;

    // Side-channel load → atomic publish. Safe while audio reads this buffer.
    bool tryLoadResident(size_t maxBytes, size_t& outBytes, std::string& error);
    bool isResident() const { return residentActive.load(std::memory_order_acquire); }
    size_t residentBytes() const { return residentByteCount; }
    void releaseResident();

    bool refill();
    bool hardSeekTo(int64_t deviceFrame, std::string& error);
    int64_t read(float* const* outChannels, int64_t numFrames, int64_t expectedPosition);

    bool isExhausted() const {
        if (residentActive.load(std::memory_order_acquire)) {
            const int64_t pos = readPosition.load(std::memory_order_relaxed);
            return pos >= residentStart + residentLength;
        }
        return sourceExhausted.load(std::memory_order_acquire) && ring.framesAvailable() == 0;
    }

    int64_t framesAvailable() const {
        if (residentActive.load(std::memory_order_acquire))
            return ring.capacity() > 0 ? ring.capacity() : preferredLength;
        return ring.framesAvailable();
    }
    int64_t framesFree() const {
        if (residentActive.load(std::memory_order_acquire))
            return 0;
        return ring.framesFree();
    }
    int64_t ringCapacity() const { return ring.capacity(); }
    bool sourceIsExhausted() const {
        if (residentActive.load(std::memory_order_acquire))
            return true;
        return sourceExhausted.load(std::memory_order_acquire);
    }
    bool hasPendingSkip() const {
        if (residentActive.load(std::memory_order_acquire))
            return false;
        return pendingSkipFrames.load(std::memory_order_acquire) > 0;
    }
    bool wantsRefill() const {
        if (residentActive.load(std::memory_order_acquire))
            return false;
        if (hasPendingSkip())
            return true;
        return !sourceIsExhausted() && ring.framesFree() > 0;
    }

private:
    void closeDiskCursorUnlocked();
    bool openUnlocked(const ProjectLoader& loader, const std::string& archivePath,
                      int64_t ringCapacityFrames, double deviceSampleRate, std::string& error);
    // Decode [deviceStart, +deviceFrames) via a private stream (does not touch
    // this->cursor / this->ring / this->decoder).
    bool decodeWindowSideChannel(int64_t deviceStart, int64_t deviceFrames,
                                 std::vector<std::vector<float>>& outPlanar, int64_t& outFrames,
                                 std::string& error) const;

    ProjectLoader::StreamCursor cursor;
    WavStreamDecoder decoder;
    AudioRingBuffer ring;

    // Serializes open/refill/hardSeek/commit-resident against each other.
    // Never held on the audio-thread read() hot path when resident.
    mutable std::mutex diskIoMutex;

    const ProjectLoader* openLoader = nullptr;
    std::string openArchivePath;
    int64_t openRingCapacityFrames = 0;
    double openDeviceSampleRate = 0.0;

    std::atomic<int64_t> readPosition{0};
    std::atomic<int64_t> pendingSkipFrames{0};
    std::atomic<bool> sourceExhausted{false};
    std::atomic<bool> residentLoadInFlight{false};

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

    int64_t preferredStart = 0;
    int64_t preferredLength = 0;

    // Published once; immutable after residentActive becomes true.
    std::atomic<bool> residentActive{false};
    int64_t residentStart = 0;
    int64_t residentLength = 0;
    size_t residentByteCount = 0;
    std::vector<std::vector<float>> residentData;
};

} // namespace resoset
