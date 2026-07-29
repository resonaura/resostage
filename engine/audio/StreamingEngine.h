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
//
// CRITICAL: stageSong / precacheSong never decode full windows on the message
// thread — that caused 1–2s freezes on song switch. Residency is filled by a
// dedicated background thread after rings are already live.
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

    // Bumps stageEpoch so in-flight deferred precache jobs abandon themselves
    // when the user jumps songs rapidly (10-song hopscotch).
    uint64_t stageEpoch() const { return stageEpoch_.load(std::memory_order_acquire); }

    // `primeSeconds` / `primeMaxWait`: ring warm-up on stage. Pass 0 / 0 to
    // skip (instant select when not playing — IO workers fill before Play).
    bool stageSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames, double deviceSampleRate,
                   std::string& error, double primeSeconds = 0.35, double primeMaxWait = 0.12);

    // Open+prime next song. `epoch` must match stageEpoch() at commit time or
    // the result is discarded (stale after a later selectSong).
    void precacheSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                      double deviceSampleRate, uint64_t epoch);

    // Snap active stems to deviceFrame. `primeMaxWait` caps any ring warm-up
    // (0 = open/seek only — use when stopped; IO workers fill before Play).
    bool seekActiveSongTo(int64_t deviceFrame, std::string& error, double primeMaxWait = 0.05);

    bool tryPromotePrecached(size_t songIndex);
    bool hasPrecacheFor(size_t songIndex) const;
    bool isPrecacheWarm(size_t songIndex, double minSeconds, double deviceSampleRate) const;
    // Drop precache if it is not for `expectedNext` (wrong neighbour after a jump).
    void dropPrecacheUnless(size_t expectedNext);

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
    void ioWorkerLoop(int workerIndex);
    void residentThreadLoop();
    void primeBuffersLocked(StagedSong& staged, double minSeconds, double deviceSampleRate,
                            double maxWaitSeconds);
    void applyRegionWindow(StreamingTrackBuffer& buf, const Region& region, double deviceSampleRate) const;
    // Convert at most one non-resident stem on `staged` into RAM (budget-aware).
    // Returns true if a stem was converted (or already full). Used by the
    // background resident thread only — never from stageSong().
    bool residentizeOneBuffer(StagedSong& staged, size_t& budgetRemaining);
    void recountResidentBytes();
    void refillActiveSlice(StagedSong& s, int workerIndex, int workerCount, bool& urgent, bool& hungry);

    const ProjectLoader* projectLoader = nullptr;
    std::thread ioThread;
    std::thread ioThread2; // second feeder (directory containers / parallel refill)
    std::thread residentThread; // slow RAM promotion; never blocks song switch
    std::atomic<bool> running{false};
    std::function<void()> ioThreadStartHook;
    std::function<void()> ioThreadStopHook;

    std::mutex projectLoaderMutex;

    std::shared_ptr<StagedSong> active;

    // shared_ptr so resident thread can decode without holding precacheMutex
    // for the whole duration (mutex only for pointer swap).
    mutable std::mutex precacheMutex;
    std::shared_ptr<StagedSong> precached;

    std::atomic<size_t> residentBudgetBytes{kDefaultResidentBudgetBytes};
    std::atomic<size_t> residentBytesUsed{0};
    // Incremented on every stageSong; deferred precache must match.
    std::atomic<uint64_t> stageEpoch_{0};
};

} // namespace resoset
