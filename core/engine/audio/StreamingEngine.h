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

namespace resostage {

// Background I/O + optional RAM residency for active/warm song stems.
//
// Directory containers: open FILE* are independent → parallel refill (2 workers).
// Legacy ZIP: single shared mz_zip handle → serial refill under mutex.
//
// Smart preload: only each region's used source window is considered for RAM
// (not timeline emptiness, not unused file tails). Budget shared active-first,
// remainder for warm-cache songs. Oversized stems keep streaming rings.
//
// Song switch is NOT a full teardown: open stems live in a process-wide
// file-path pool (shared across songs). stageSong only rebinds region/track
// → buffer maps, soft-rewinds (dir=fseek), and flips `active`. Same idea as
// region playback inside a song — playhead/window change, not re-open.
class StreamingEngine {
public:
    // Soft cap for RAM-resident audio (active + warm). ~512 MiB default.
    static constexpr size_t kDefaultResidentBudgetBytes = 512ull * 1024ull * 1024ull;
    // Keep this many non-active *song maps* prebuilt for gapless promote.
    // A warm entry is cheap bookkeeping (a vector of shared_ptrs into the
    // process-wide filePool + a small id map) -- the actual open file
    // handles/ring buffers it points at are already retained by filePool for
    // the whole session regardless of warm-cache membership (see filePool's
    // doc comment), so evicting past this cap does NOT free that memory, it
    // only means the next hop to that song has to re-rewind + re-fill its
    // head (now off the message thread -- see stageSong's asyncFill) instead
    // of being a zero-work atomic promote. Sized comfortably past a typical
    // full live setlist (a dozen-plus songs) so "warm every song after load"
    // (see AudioEngine::loadProject) doesn't immediately evict most of it.
    static constexpr size_t kWarmCacheMax = 32;

    struct StagedSong {
        size_t songIndex = static_cast<size_t>(-1);
        // shared_ptr: same file may be held by active + warm + filePool.
        std::vector<std::shared_ptr<StreamingTrackBuffer>> buffers;
        std::unordered_map<std::string, StreamingTrackBuffer*> byId;
        // true when soft-rewound to frame 0 and lightly primed — gapless swap.
        std::atomic<bool> readyAtStart{false};
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
               std::function<void()> onIoThreadStop = nullptr,
               std::function<void()> onResidentThreadStart = nullptr);
    void stop();

    void setResidentBudgetBytes(size_t bytes) {
        residentBudgetBytes.store(bytes, std::memory_order_relaxed);
    }
    size_t residentBudgetBytesValue() const {
        return residentBudgetBytes.load(std::memory_order_relaxed);
    }

    // Bumps stageEpoch so in-flight deferred warm jobs for *other* targets
    // can abandon themselves on rapid hopscotch. Completed warm entries stay
    // until LRU eviction.
    uint64_t stageEpoch() const { return stageEpoch_.load(std::memory_order_acquire); }
    // Bumped on start()/stop() — warm-all after load aborts if project changes.
    uint64_t warmGeneration() const { return warmGeneration_.load(std::memory_order_acquire); }

    // Prepare next song (warm promote or cold open — may take a while), then
    // atomically flip `active`. If `muteBeforeSwap` is non-null it is set true
    // only in the microseconds before the flip so the audio thread can mute
    // without holding silence across a multi-100ms cold open.
    // `primeSeconds` / `primeMaxWait` are ignored (kept for call-site compat).
    //
    // `asyncFill`: when the song wasn't already warm, the flip still happens
    // synchronously/instantly, but the head-buffer decode (fillHeadOnce --
    // real disk I/O + decode, previously done right here) is dispatched to a
    // background thread instead of blocking the caller. This is what makes a
    // "hard hop" (song whose stems were never opened, e.g. jumping around a
    // 12-song setlist faster than the ±2-neighbour warm cache can keep up)
    // return instantly instead of freezing the whole message thread -- and
    // therefore the WS/HTTP command loop, i.e. the entire UI -- for however
    // long the decode took (see ioWorkerLoop's own "message thread must never
    // wait on this path" rule, which the old synchronous call broke). If
    // `muteBeforeSwap` is set, it stays true until the background thread
    // confirms real head audio, so a hard hop never unmutes into silence.
    // `outDeferredMuteClear`, if non-null, is set true when clearing
    // `*muteBeforeSwap` has been handed off to that background thread --
    // callers must skip their own usual post-stage mute-clear in that case
    // (see AudioEngine::selectSongInternal).
    bool stageSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames, double deviceSampleRate,
                   std::string& error, double primeSeconds = 0.0, double primeMaxWait = 0.0,
                   std::atomic<bool>* muteBeforeSwap = nullptr, bool asyncFill = false,
                   bool* outDeferredMuteClear = nullptr);

    // Open into warm LRU (not active). `epoch` must match stageEpoch at commit
    // unless `requireEpochMatch` is false (background warm-all after load).
    void precacheSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                      double deviceSampleRate, uint64_t epoch, bool requireEpochMatch = true);

    // Snap active stems to deviceFrame. `primeMaxWait` caps any ring warm-up
    // (0 = open/seek only — use when stopped; IO workers fill before Play).
    bool seekActiveSongTo(int64_t deviceFrame, std::string& error, double primeMaxWait = 0.05);

    bool tryPromotePrecached(size_t songIndex);
    bool hasPrecacheFor(size_t songIndex) const;
    bool isPrecacheWarm(size_t songIndex, double minSeconds, double deviceSampleRate) const;
    // Drop warm entries that are not `expectedNext` (legacy single-neighbour API).
    void dropPrecacheUnless(size_t expectedNext);

    bool primeActiveSong(double minSeconds, double deviceSampleRate, double maxWaitSeconds);
    double minActiveBufferedSeconds(double deviceSampleRate) const;
    BufferHealth activeBufferHealth(double deviceSampleRate) const;

    ActiveSongHandle acquireActiveSong();
    void updateRegionWindow(const Region& region, double deviceSampleRate = 0.0);

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
    bool residentizeOneBuffer(StagedSong& staged, size_t& budgetRemaining);
    /**
     * Free ordinary resident regions to make room for one that needs random
     * access. Returns how many bytes were actually released.
     *
     * An evicted region loses nothing but speed: it goes back to its ring,
     * which is how every region plays by default. A region that needs random
     * access has no such fallback -- off the ring it plays forwards at 1x, so
     * it is simply wrong.
     */
    size_t evictOrdinaryResident(StagedSong& staged, size_t bytesWanted);
    void recountResidentBytes();
    void refillActiveSlice(StagedSong& s, int workerIndex, int workerCount, bool& urgent, bool& hungry);

    // Warm LRU helpers (caller holds precacheMutex unless noted).
    // `needsRewind`: true when parking a mid-play active song; false when
    // inserting a freshly opened/primed song already at frame 0.
    void putWarmLocked(std::shared_ptr<StagedSong> song, bool needsRewind = true);
    std::shared_ptr<StagedSong> takeWarmLocked(size_t songIndex);
    bool hasWarmLocked(size_t songIndex) const;
    void resetSongToStart(StagedSong& staged);
    // One non-blocking refill pass per unique buffer (fills head after rewind).
    void fillHeadOnce(StagedSong& staged);

    // Bind song regions to pooled file buffers (open only missing paths).
    std::shared_ptr<StagedSong> bindSongToPool(size_t songIndex, const SongDef& song,
                                               int64_t ringCapacityFrames, double deviceSampleRate,
                                               std::string& error, bool openMissing);
    // Get or open one stem by archive-relative path. Thread-safe.
    std::shared_ptr<StreamingTrackBuffer> getOrOpenFile(const std::string& archivePath,
                                                        int64_t ringCapacityFrames,
                                                        double deviceSampleRate, std::string& error);
    // Drops the whole file pool if the requested (ringCapacityFrames,
    // deviceSampleRate) differs from what it was last opened with (device
    // switch / live sample-rate change). Must run before ANY per-file pool
    // lookup for the new request -- including bindSongToPool's own direct
    // filePool lookup -- otherwise a file already resident in the pool from
    // the previous rate would be silently reused with its stale resample
    // ratio instead of being reopened.
    void dropFilePoolIfRateChanged(int64_t ringCapacityFrames, double deviceSampleRate);

    const ProjectLoader* projectLoader = nullptr;
    // File-path → open buffer for the life of the loaded project.
    mutable std::mutex filePoolMutex;
    std::unordered_map<std::string, std::shared_ptr<StreamingTrackBuffer>> filePool;
    int64_t filePoolRingCapacity = 0;
    double filePoolSampleRate = 0.0;
    std::thread ioThread;
    std::thread ioThread2;
    std::thread residentThread;
    std::atomic<bool> running{false};
    std::function<void()> residentThreadStartHook;
    std::function<void()> ioThreadStartHook;
    std::function<void()> ioThreadStopHook;

    std::mutex projectLoaderMutex;

    std::shared_ptr<StagedSong> active;

    // Warm cache: recently staged / background-opened songs for hopscotch.
    mutable std::mutex precacheMutex;
    std::unordered_map<size_t, std::shared_ptr<StagedSong>> warmByIndex;
    std::vector<size_t> warmLru; // oldest at front, newest at back
    // Back-compat alias used by gapless path: newest warm entry that was
    // specifically the sequential "next" — still in warmByIndex.
    std::shared_ptr<StagedSong> precached;

    std::atomic<size_t> residentBudgetBytes{kDefaultResidentBudgetBytes};
    std::atomic<size_t> residentBytesUsed{0};
    std::atomic<uint64_t> stageEpoch_{0};
    std::atomic<uint64_t> warmGeneration_{0};
};

} // namespace resostage
