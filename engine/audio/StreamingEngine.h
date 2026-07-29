#pragma once

#include "../project/ProjectLoader.h"
#include "../project/ProjectSchema.h"
#include "StreamingTrackBuffer.h"

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace resoset {

// Background I/O + optional RAM residency for active/next song stems.
//
// Directory containers: open FILE* are independent → parallel refill (2 workers).
// Legacy ZIP: single shared mz_zip handle → serial refill under mutex.
//
// Smart preload: only each region's used source window is considered for RAM
// (not timeline emptiness, not unused file tails). Budget shared active-first,
// remainder for next-song precache. Oversized stems keep streaming rings.
class StreamingEngine {
public:
    // Soft cap for RAM-resident audio (active + next). ~512 MiB default.
    static constexpr size_t kDefaultResidentBudgetBytes = 512ull * 1024ull * 1024ull;

    struct StagedSong {
        size_t songIndex = static_cast<size_t>(-1);
        std::vector<std::unique_ptr<StreamingTrackBuffer>> buffers;
        std::unordered_map<std::string, StreamingTrackBuffer*> byId;
    };

    struct BufferHealth {
        double minBufferedSeconds = 0.0;
        double avgBufferedSeconds = 0.0;
        int trackCount = 0;
        int residentTracks = 0;
        int streamingTracks = 0;
        bool urgent = false; // any non-resident below ~1s
        size_t residentBytes = 0;
    };

    class ActiveSongHandle {
    public:
        ActiveSongHandle() = default;
        explicit operator bool() const { return staged != nullptr; }
        StreamingTrackBuffer* track(const std::string& trackId) const;
        StreamingTrackBuffer* region(const std::string& regionId) const;

    private:
        friend class StreamingEngine;
        std::shared_ptr<StagedSong> staged;
    };

    StreamingEngine();
    ~StreamingEngine();

    StreamingEngine(const StreamingEngine&) = delete;
    StreamingEngine& operator=(const StreamingEngine&) = delete;

    void start(const ProjectLoader* loader, std::function<void()> onIoThreadStart = nullptr,
               std::function<void()> onIoThreadStop = nullptr);
    void stop();

    void setResidentBudgetBytes(size_t bytes) {
        residentBudgetBytes.store(bytes, std::memory_order_relaxed);
    }
    size_t residentBudgetBytesValue() const {
        return residentBudgetBytes.load(std::memory_order_relaxed);
    }

    bool stageSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames, double deviceSampleRate,
                   std::string& error);

    void precacheSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames, double deviceSampleRate);

    bool seekActiveSongTo(int64_t deviceFrame, std::string& error);

    bool tryPromotePrecached(size_t songIndex);
    bool hasPrecacheFor(size_t songIndex) const;
    bool isPrecacheWarm(size_t songIndex, double minSeconds, double deviceSampleRate) const;

    bool primeActiveSong(double minSeconds, double deviceSampleRate, double maxWaitSeconds);
    double minActiveBufferedSeconds(double deviceSampleRate) const;
    BufferHealth activeBufferHealth(double deviceSampleRate) const;

    ActiveSongHandle acquireActiveSong();

    template <typename Fn>
    void withProjectLoaderLock(Fn&& fn) {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        std::forward<Fn>(fn)();
    }

private:
    void ioThreadLoop();
    void ioWorkerLoop(int workerIndex);
    void primeBuffersLocked(StagedSong& staged, double minSeconds, double deviceSampleRate,
                            double maxWaitSeconds);
    void applyRegionWindow(StreamingTrackBuffer& buf, const Region& region, double deviceSampleRate) const;
    void residentizeSong(StagedSong& staged, size_t budgetBytes, size_t& usedBytes);
    void refillActiveSlice(StagedSong& s, int workerIndex, int workerCount, bool& urgent, bool& hungry);

    const ProjectLoader* projectLoader = nullptr;
    std::thread ioThread;
    std::thread ioThread2; // second feeder (directory containers / parallel refill)
    std::atomic<bool> running{false};
    std::function<void()> ioThreadStartHook;
    std::function<void()> ioThreadStopHook;

    std::mutex projectLoaderMutex;

    std::shared_ptr<StagedSong> active;

    mutable std::mutex precacheMutex;
    std::unique_ptr<StagedSong> precached;

    std::atomic<size_t> residentBudgetBytes{kDefaultResidentBudgetBytes};
    std::atomic<size_t> residentBytesUsed{0};
};

} // namespace resoset
