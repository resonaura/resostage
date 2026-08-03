#pragma once

#include "../project/ProjectLoader.h"
#include "AudioRingBuffer.h"
#include "WavStreamDecoder.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace resostage {

// Streams one stem into an SPSC ring, or holds a *used source window* in RAM.
//
// Concurrency contract (hardened for hopscotch + background residency):
//  - Audio thread: read() only. Never blocks, never takes diskIoMutex on the
//    resident path; ring path is SPSC vs refill under diskIoMutex.
//  - IO / resident threads: open/refill/hardSeek/tryLoadResident under
//    diskIoMutex where they touch cursor/ring.
//  - tryLoadResident decodes via a *side* stream into temporary storage, then
//    publishes an immutable shared window atomically — it never calls
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
    bool isResident() const { return residentSnapshot() != nullptr; }
    size_t residentBytes() const {
        const auto window = residentSnapshot();
        return window != nullptr ? window->byteCount : 0;
    }
    void releaseResident();

    // Decode up to maxDeviceFrames into the ring (capped by free space).
    // Default matches historical chunk size; hop head-fill uses a small limit.
    bool refill(int64_t maxDeviceFrames = 0);
    bool hardSeekTo(int64_t deviceFrame, std::string& error);
    // Cheap rewind to frame 0 for hopscotch: re-open stream + re-parse header,
    // keep existing ring storage (reset indices). Prefer this over treating
    // every promote as a cold openUnlocked.
    bool softRewindToStart(std::string& error);
    int64_t read(float* const* outChannels, int64_t numFrames, int64_t expectedPosition);
    int64_t currentReadPosition() const { return readPosition.load(std::memory_order_relaxed); }

    bool isExhausted() const {
        if (const auto window = residentSnapshot()) {
            const int64_t pos = readPosition.load(std::memory_order_relaxed);
            return pos >= window->start + window->length;
        }
        return sourceExhausted.load(std::memory_order_acquire) && ring.framesAvailable() == 0;
    }

    int64_t framesAvailable() const {
        if (residentSnapshot() != nullptr)
            return ring.capacity() > 0 ? ring.capacity() : preferredLength;
        if (!ringReady.load(std::memory_order_acquire))
            return 0;
        return ring.framesAvailable();
    }
    int64_t framesFree() const {
        if (residentSnapshot() != nullptr)
            return 0;
        if (!ringReady.load(std::memory_order_acquire))
            return openRingCapacityFrames; // not allocated yet — fully free
        return ring.framesFree();
    }
    int64_t ringCapacity() const {
        const int64_t c = ring.capacity();
        return c > 0 ? c : openRingCapacityFrames;
    }
    bool sourceIsExhausted() const {
        if (residentSnapshot() != nullptr)
            return true;
        return sourceExhausted.load(std::memory_order_acquire);
    }
    bool hasPendingSkip() const {
        if (residentSnapshot() != nullptr)
            return false;
        return pendingSkipFrames.load(std::memory_order_acquire) > 0;
    }
    bool wantsRefill() const {
        if (residentSnapshot() != nullptr)
            return false;
        if (hasPendingSkip())
            return true;
        if (!sourceIsExhausted() && !ringReady.load(std::memory_order_acquire))
            return true; // need first-time ring alloc + fill (on IO thread)
        return !sourceIsExhausted() && ring.framesFree() > 0;
    }

private:
    struct ResidentWindow {
        int64_t start = 0;
        int64_t length = 0;
        size_t byteCount = 0;
        std::vector<std::vector<float>> data;
    };
    std::shared_ptr<const ResidentWindow> residentSnapshot() const {
        return std::atomic_load_explicit(&residentWindow, std::memory_order_acquire);
    }
    void closeDiskCursorUnlocked();
    // Allocates ring storage if still deferred (message-thread stageSong only
    // opens headers; IO/prime threads call this on first refill).
    void ensureRingReadyUnlocked();
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
    // Byte offset of WAV 'data' payload after first parseHeader (directory
    // FILE* only). Enables softRewind via fseek without re-opening/re-parsing.
    int64_t dataPayloadFileOffset = -1;

    std::atomic<int64_t> readPosition{0};
    std::atomic<int64_t> pendingSkipFrames{0};
    std::atomic<bool> sourceExhausted{false};
    std::atomic<bool> residentLoadInFlight{false};
    // false until ensureRingReadyUnlocked() — keeps stageSong off the huge
    // zeroed float alloc so song hops stay on the message-thread budget.
    std::atomic<bool> ringReady{false};

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

    // Atomically published immutable snapshot. A reader holds its own shared
    // pointer for the whole audio callback, so clearing/replacing a resident
    // window on another thread cannot free data still being read.
    std::shared_ptr<const ResidentWindow> residentWindow;
};

} // namespace resostage
