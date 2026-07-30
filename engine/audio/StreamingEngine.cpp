#include "StreamingEngine.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <thread>

namespace resostage {

namespace {

constexpr double kLowWaterFrac = 0.25;
constexpr double kHighWaterFrac = 0.75;
constexpr int kMaxRefillsPerBufferPerTick = 4;
constexpr int kMaxActiveBurstRefills = 64;
constexpr int kMaxPrecacheBurstHealthy = 8;
constexpr int kMaxPrecacheBurstHungry = 2;
constexpr int kMutexYieldEveryRefills = 8;

void applyWindowFromRegion(StreamingTrackBuffer& buf, const Region& region, double deviceSampleRate) {
    (void)region;
    (void)deviceSampleRate;
    const int64_t total = buf.totalFrames();
    buf.setPreferredResidentWindow(0, std::max<int64_t>(0, total));
}

} // namespace

StreamingTrackBuffer* StreamingEngine::ActiveSongHandle::track(const std::string& trackId) const {
    if (staged == nullptr)
        return nullptr;
    auto it = staged->byId.find(trackId);
    return it != staged->byId.end() ? it->second : nullptr;
}

StreamingEngine::StreamingEngine() = default;
StreamingEngine::~StreamingEngine() { stop(); }

void StreamingEngine::start(const ProjectLoader* loader, std::function<void()> onIoThreadStart,
                            std::function<void()> onIoThreadStop) {
    stop();
    projectLoader = loader;
    ioThreadStartHook = std::move(onIoThreadStart);
    ioThreadStopHook = std::move(onIoThreadStop);
    warmGeneration_.fetch_add(1, std::memory_order_acq_rel);
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        warmByIndex.clear();
        warmLru.clear();
        precached.reset();
    }
    {
        std::lock_guard<std::mutex> lock(filePoolMutex);
        filePool.clear();
        filePoolRingCapacity = 0;
        filePoolSampleRate = 0.0;
    }
    std::atomic_store_explicit(&active, std::shared_ptr<StagedSong>{}, std::memory_order_release);
    running.store(true, std::memory_order_release);
    ioThread = std::thread([this] { ioWorkerLoop(0); });
    ioThread2 = std::thread([this] { ioWorkerLoop(1); });
    residentThread = std::thread([this] { residentThreadLoop(); });
}

void StreamingEngine::stop() {
    running.store(false, std::memory_order_release);
    if (ioThread.joinable())
        ioThread.join();
    if (ioThread2.joinable())
        ioThread2.join();
    if (residentThread.joinable())
        residentThread.join();
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        warmByIndex.clear();
        warmLru.clear();
        precached.reset();
    }
    {
        std::lock_guard<std::mutex> lock(filePoolMutex);
        filePool.clear();
        filePoolRingCapacity = 0;
        filePoolSampleRate = 0.0;
    }
    std::atomic_store_explicit(&active, std::shared_ptr<StagedSong>{}, std::memory_order_release);
    projectLoader = nullptr;
    warmGeneration_.fetch_add(1, std::memory_order_acq_rel);
}

void StreamingEngine::applyRegionWindow(StreamingTrackBuffer& buf, const Region& region,
                                        double deviceSampleRate) const {
    applyWindowFromRegion(buf, region, deviceSampleRate);
}

void StreamingEngine::updateRegionWindow(const Region& region, double deviceSampleRate) {
    if (auto handle = acquireActiveSong()) {
        if (StreamingTrackBuffer* buf = handle.region(region.id)) {
            applyWindowFromRegion(*buf, region, deviceSampleRate);
        }
    }
}

void StreamingEngine::putWarmLocked(std::shared_ptr<StagedSong> song, bool needsRewind) {
    if (song == nullptr)
        return;
    const size_t idx = song->songIndex;
    // Drop RAM-resident windows on parked songs so hopscotch doesn't pin
    // multi-GB of audio for songs the user left.
    for (auto& b : song->buffers) {
        if (b)
            b->releaseResident();
    }
    if (needsRewind)
        song->readyAtStart.store(false, std::memory_order_release);
    warmByIndex[idx] = std::move(song);
    warmLru.erase(std::remove(warmLru.begin(), warmLru.end(), idx), warmLru.end());
    warmLru.push_back(idx);
    while (warmByIndex.size() > kWarmCacheMax && !warmLru.empty()) {
        const size_t victim = warmLru.front();
        warmLru.erase(warmLru.begin());
        warmByIndex.erase(victim);
        if (precached && precached->songIndex == victim)
            precached.reset();
    }
    if (precached && warmByIndex.find(precached->songIndex) == warmByIndex.end())
        precached.reset();
}

std::shared_ptr<StreamingEngine::StagedSong> StreamingEngine::takeWarmLocked(size_t songIndex) {
    auto it = warmByIndex.find(songIndex);
    if (it == warmByIndex.end())
        return nullptr;
    auto s = std::move(it->second);
    warmByIndex.erase(it);
    warmLru.erase(std::remove(warmLru.begin(), warmLru.end(), songIndex), warmLru.end());
    if (precached && precached->songIndex == songIndex)
        precached.reset();
    return s;
}

bool StreamingEngine::hasWarmLocked(size_t songIndex) const {
    return warmByIndex.find(songIndex) != warmByIndex.end()
           || (precached != nullptr && precached->songIndex == songIndex);
}

void StreamingEngine::resetSongToStart(StagedSong& staged) {
    // Soft rewind unique file buffers (same stem may appear on multiple regions).
    // Directory: fseek to data payload — microseconds per file. Skips wipe if
    // already at frame 0 with ring data (see softRewindToStart).
    std::unordered_map<StreamingTrackBuffer*, bool> seen;
    auto resetOne = [](StreamingTrackBuffer& buf) {
        std::string err;
        (void)buf.softRewindToStart(err);
    };
    const bool dir = projectLoader != nullptr && projectLoader->isDirectoryContainer();
    auto run = [&] {
        for (auto& b : staged.buffers) {
            if (b == nullptr || seen.count(b.get()))
                continue;
            seen[b.get()] = true;
            resetOne(*b);
        }
    };
    if (dir) {
        run();
    } else {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        run();
    }
    staged.readyAtStart.store(false, std::memory_order_release);
}

void StreamingEngine::fillHeadOnce(StagedSong& staged) {
    // Tiny head only (~4096 frames ≈ 85ms @ 48k). Old 4×16k×N-stems path
    // was tens of ms on the message thread even with warm file pool — that
    // delay is the "still lags on every hop" feel (shared stems always rewind).
    constexpr int64_t kHopHeadFrames = 4096;
    std::unordered_map<StreamingTrackBuffer*, bool> seen;
    const bool dir = projectLoader != nullptr && projectLoader->isDirectoryContainer();
    auto run = [&] {
        for (auto& b : staged.buffers) {
            if (b == nullptr || seen.count(b.get()))
                continue;
            seen[b.get()] = true;
            if (b->isResident())
                continue;
            if (b->framesAvailable() >= kHopHeadFrames)
                continue;
            if (b->wantsRefill())
                (void)b->refill(kHopHeadFrames);
        }
    };
    if (dir) {
        run();
    } else {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        run();
    }
}

static bool songHeadHasAudio(const StreamingEngine::StagedSong& staged, double minSeconds,
                             double deviceSampleRate) {
    if (deviceSampleRate <= 0.0)
        deviceSampleRate = 48000.0;
    const int64_t need = static_cast<int64_t>(std::max(0.0, minSeconds) * deviceSampleRate);
    if (staged.buffers.empty())
        return true;
    for (const auto& buf : staged.buffers) {
        if (buf == nullptr)
            continue;
        if (buf->isResident())
            continue;
        if (buf->isExhausted())
            continue;
        if (buf->framesAvailable() < need)
            return false;
    }
    return true;
}

void StreamingEngine::recountResidentBytes() {
    size_t used = 0;
    if (auto s = std::atomic_load_explicit(&active, std::memory_order_acquire)) {
        for (const auto& b : s->buffers)
            if (b && b->isResident())
                used += b->residentBytes();
    }
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        for (const auto& [idx, song] : warmByIndex) {
            (void)idx;
            if (song == nullptr)
                continue;
            for (const auto& b : song->buffers)
                if (b && b->isResident())
                    used += b->residentBytes();
        }
    }
    residentBytesUsed.store(used, std::memory_order_relaxed);
}

bool StreamingEngine::residentizeOneBuffer(StagedSong& staged, size_t& budgetRemaining) {
    StreamingTrackBuffer* best = nullptr;
    size_t bestBytes = std::numeric_limits<size_t>::max();
    for (auto& b : staged.buffers) {
        if (b == nullptr || b->isResident())
            continue;
        const size_t need = b->estimatedResidentBytes();
        if (need > budgetRemaining && need > 0)
            continue;
        if (need < bestBytes) {
            bestBytes = need;
            best = b.get();
        }
    }
    if (best == nullptr)
        return false;

    size_t got = 0;
    std::string err;
    const bool dir = projectLoader != nullptr && projectLoader->isDirectoryContainer();
    bool ok = false;
    if (dir) {
        ok = best->tryLoadResident(budgetRemaining, got, err);
    } else {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        ok = best->tryLoadResident(budgetRemaining, got, err);
    }
    if (ok && got <= budgetRemaining)
        budgetRemaining -= got;
    return ok;
}

void StreamingEngine::residentThreadLoop() {
    while (running.load(std::memory_order_acquire)) {
        const uint64_t epochBefore = stageEpoch_.load(std::memory_order_acquire);
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        if (stageEpoch_.load(std::memory_order_acquire) != epochBefore) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            continue;
        }

        const size_t budget = residentBudgetBytes.load(std::memory_order_relaxed);
        size_t used = residentBytesUsed.load(std::memory_order_relaxed);
        size_t remain = budget > used ? budget - used : 0;
        bool didWork = false;

        if (remain > 0) {
            if (auto s = std::atomic_load_explicit(&active, std::memory_order_acquire)) {
                if (residentizeOneBuffer(*s, remain)) {
                    didWork = true;
                    recountResidentBytes();
                }
            }
        }

        if (!didWork) {
            used = residentBytesUsed.load(std::memory_order_relaxed);
            remain = budget > used ? budget - used : 0;
            std::shared_ptr<StagedSong> warm;
            {
                std::lock_guard<std::mutex> lock(precacheMutex);
                // Prefer newest warm (LRU back).
                if (!warmLru.empty()) {
                    auto it = warmByIndex.find(warmLru.back());
                    if (it != warmByIndex.end())
                        warm = it->second;
                } else if (precached != nullptr) {
                    warm = precached;
                }
            }
            if (warm != nullptr && remain > 0) {
                if (residentizeOneBuffer(*warm, remain)) {
                    didWork = true;
                    recountResidentBytes();
                }
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(didWork ? 15 : 40));
    }
}

void StreamingEngine::dropPrecacheUnless(size_t expectedNext) {
    std::lock_guard<std::mutex> lock(precacheMutex);
    if (precached != nullptr && precached->songIndex != expectedNext)
        precached.reset();
    // Keep warm LRU otherwise — hopscotch depends on it.
    (void)expectedNext;
}

void StreamingEngine::refillActiveSlice(StagedSong& s, int workerIndex, int workerCount, bool& urgent,
                                        bool& hungry) {
    int globalBudget = kMaxActiveBurstRefills / std::max(1, workerCount);
    int sinceYield = 0;
    bool progress = true;
    const bool dirContainer =
        projectLoader != nullptr && projectLoader->isDirectoryContainer();

    while (progress && globalBudget > 0 && running.load(std::memory_order_relaxed)) {
        progress = false;
        auto doPass = [&] {
            for (size_t bi = 0; bi < s.buffers.size(); ++bi) {
                if (static_cast<int>(bi % static_cast<size_t>(workerCount)) != workerIndex)
                    continue;
                auto& buf = s.buffers[bi];
                if (buf == nullptr || globalBudget <= 0)
                    continue;
                if (buf->isResident())
                    continue;

                const int64_t cap = std::max<int64_t>(1, buf->ringCapacity());
                const int64_t low = static_cast<int64_t>(cap * kLowWaterFrac);
                const int64_t high = static_cast<int64_t>(cap * kHighWaterFrac);
                const int64_t avail = buf->framesAvailable();
                const bool skipPending = buf->hasPendingSkip();
                const bool lowWater = avail < low && buf->wantsRefill();
                const bool belowHigh = avail < high && buf->wantsRefill();

                if (skipPending || lowWater) {
                    urgent = true;
                    hungry = true;
                } else if (belowHigh) {
                    hungry = true;
                } else if (!buf->wantsRefill()) {
                    continue;
                }

                const int allow = (skipPending || lowWater)
                                      ? kMaxRefillsPerBufferPerTick
                                      : (belowHigh ? 2 : 1);
                for (int n = 0; n < allow && globalBudget > 0; ++n) {
                    if (!buf->wantsRefill())
                        break;
                    if (!skipPending && !lowWater && !belowHigh && n >= 1)
                        break;
                    if (!skipPending && !lowWater && buf->framesAvailable() >= high && n >= 1)
                        break;
                    buf->refill();
                    --globalBudget;
                    ++sinceYield;
                    progress = true;
                    if (!dirContainer && sinceYield >= kMutexYieldEveryRefills)
                        return;
                }
            }
        };

        if (dirContainer) {
            doPass();
        } else {
            std::lock_guard<std::mutex> lock(projectLoaderMutex);
            doPass();
            sinceYield = 0;
        }
        if (!dirContainer && sinceYield >= kMutexYieldEveryRefills) {
            sinceYield = 0;
            progress = true;
        }
    }
}

void StreamingEngine::ioWorkerLoop(int workerIndex) {
    if (workerIndex == 0 && ioThreadStartHook)
        ioThreadStartHook();

    while (running.load(std::memory_order_acquire)) {
        bool urgent = false;
        bool hungry = false;

        {
            std::shared_ptr<StagedSong> s = std::atomic_load_explicit(&active, std::memory_order_acquire);
            if (s != nullptr)
                refillActiveSlice(*s, workerIndex, 2, urgent, hungry);
        }

        // Worker 0: rewind parked songs to frame 0 + top-up rings so the next
        // promote is a pure atomic swap (readyAtStart).
        if (workerIndex == 0 && !urgent) {
            std::vector<std::shared_ptr<StagedSong>> warmSnap;
            {
                std::lock_guard<std::mutex> pcLock(precacheMutex);
                warmSnap.reserve(warmByIndex.size());
                for (auto it = warmLru.rbegin(); it != warmLru.rend(); ++it) {
                    auto w = warmByIndex.find(*it);
                    if (w != warmByIndex.end() && w->second)
                        warmSnap.push_back(w->second);
                }
            }
            const bool dirContainer =
                projectLoader != nullptr && projectLoader->isDirectoryContainer();
            int budget = hungry ? kMaxPrecacheBurstHungry : kMaxPrecacheBurstHealthy;
            for (auto& song : warmSnap) {
                if (song == nullptr || budget <= 0)
                    break;
                if (!song->readyAtStart.load(std::memory_order_acquire)) {
                    // Soft-rewind once, then fill head. Message thread must
                    // never wait on this path.
                    resetSongToStart(*song);
                    if (dirContainer) {
                        primeBuffersLocked(*song, 0.25, 48000.0, 0.08);
                    } else {
                        std::lock_guard<std::mutex> zipLock(projectLoaderMutex);
                        primeBuffersLocked(*song, 0.25, 48000.0, 0.08);
                    }
                    if (songHeadHasAudio(*song, 0.12, 48000.0))
                        song->readyAtStart.store(true, std::memory_order_release);
                    budget = 0; // one song per tick — keep active feeder responsive
                    continue;
                }
                for (auto& buf : song->buffers) {
                    if (buf == nullptr || budget <= 0)
                        continue;
                    if (buf->isResident())
                        continue;
                    if (buf->wantsRefill()) {
                        if (dirContainer) {
                            buf->refill();
                        } else {
                            std::lock_guard<std::mutex> zipLock(projectLoaderMutex);
                            buf->refill();
                        }
                        --budget;
                    }
                }
            }
        }

        if (urgent)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        else if (hungry)
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        else
            std::this_thread::sleep_for(std::chrono::milliseconds(workerIndex == 0 ? 8 : 10));
    }

    if (workerIndex == 0 && ioThreadStopHook)
        ioThreadStopHook();
}

StreamingTrackBuffer* StreamingEngine::ActiveSongHandle::region(const std::string& regionId) const {
    return track(regionId);
}

void StreamingEngine::primeBuffersLocked(StagedSong& staged, double minSeconds, double deviceSampleRate,
                                         double maxWaitSeconds) {
    if (deviceSampleRate <= 0.0)
        deviceSampleRate = 48000.0;
    const int64_t minFrames = static_cast<int64_t>(std::max(0.0, minSeconds) * deviceSampleRate);
    const auto deadline = std::chrono::steady_clock::now()
                          + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                              std::chrono::duration<double>(std::max(0.0, maxWaitSeconds)));

    while (std::chrono::steady_clock::now() < deadline) {
        bool anyProgress = false;
        bool allSatisfied = true;
        for (auto& buf : staged.buffers) {
            if (buf == nullptr)
                continue;
            if (buf->isResident())
                continue;
            if (!buf->wantsRefill())
                continue;
            if (buf->framesAvailable() >= minFrames && !buf->hasPendingSkip())
                continue;
            allSatisfied = false;
            const int64_t before = buf->framesAvailable();
            const bool hadSkip = buf->hasPendingSkip();
            buf->refill();
            if (buf->framesAvailable() > before || (hadSkip && !buf->hasPendingSkip()))
                anyProgress = true;
        }
        if (allSatisfied || !anyProgress)
            break;
    }
}

std::shared_ptr<StreamingTrackBuffer> StreamingEngine::getOrOpenFile(
    const std::string& archivePath, int64_t ringCapacityFrames, double deviceSampleRate,
    std::string& error) {
    if (archivePath.empty() || projectLoader == nullptr) {
        error = "no path / loader";
        return nullptr;
    }

    {
        std::lock_guard<std::mutex> lock(filePoolMutex);
        // Sample-rate / ring size change (device switch) → drop pool.
        if (filePoolRingCapacity != ringCapacityFrames
            || std::abs(filePoolSampleRate - deviceSampleRate) > 1e-6) {
            filePool.clear();
            filePoolRingCapacity = ringCapacityFrames;
            filePoolSampleRate = deviceSampleRate;
        }
        auto it = filePool.find(archivePath);
        if (it != filePool.end() && it->second != nullptr)
            return it->second;
    }

    auto buf = std::make_shared<StreamingTrackBuffer>();
    std::string openError;
    bool opened = false;
    const bool dir = projectLoader->isDirectoryContainer();
    if (dir) {
        opened = buf->open(*projectLoader, archivePath, ringCapacityFrames, deviceSampleRate,
                           openError);
    } else {
        std::lock_guard<std::mutex> zipLock(projectLoaderMutex);
        opened = buf->open(*projectLoader, archivePath, ringCapacityFrames, deviceSampleRate,
                           openError);
    }
    if (!opened) {
        error = openError.empty() ? "open failed" : openError;
        return nullptr;
    }

    {
        std::lock_guard<std::mutex> lock(filePoolMutex);
        auto [it, inserted] = filePool.emplace(archivePath, buf);
        if (!inserted && it->second != nullptr)
            return it->second; // another thread won the race
        it->second = buf;
    }
    return buf;
}

std::shared_ptr<StreamingEngine::StagedSong> StreamingEngine::bindSongToPool(
    size_t songIndex, const SongDef& song, int64_t ringCapacityFrames, double deviceSampleRate,
    std::string& error, bool openMissing) {
    auto staged = std::make_shared<StagedSong>();
    staged->songIndex = songIndex;

    // Dedup paths first so multi-region same file opens once.
    std::vector<const Region*> regions;
    regions.reserve(song.regions.size());
    for (const Region& r : song.regions) {
        if (!r.file.empty())
            regions.push_back(&r);
    }

    for (const Region* r : regions) {
        std::shared_ptr<StreamingTrackBuffer> buf;
        {
            std::lock_guard<std::mutex> lock(filePoolMutex);
            auto it = filePool.find(r->file);
            if (it != filePool.end())
                buf = it->second;
        }
        if (buf == nullptr) {
            if (!openMissing) {
                error = "file not in pool: " + r->file;
                return nullptr;
            }
            std::string openError;
            buf = getOrOpenFile(r->file, ringCapacityFrames, deviceSampleRate, openError);
            if (buf == nullptr) {
                error = "Region '" + r->id + "': " + openError;
                return nullptr;
            }
        }
        applyRegionWindow(*buf, *r, deviceSampleRate);
        staged->buffers.push_back(buf);
        staged->byId[r->id] = buf.get();
        staged->byId[r->trackId] = buf.get();
    }
    return staged;
}

bool StreamingEngine::stageSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                                double deviceSampleRate, std::string& error, double primeSeconds,
                                double primeMaxWait, std::atomic<bool>* muteBeforeSwap) {
    (void)primeSeconds;
    (void)primeMaxWait;
    stageEpoch_.fetch_add(1, std::memory_order_acq_rel);

    // Prefer a prebuilt warm map (gapless); else bind from file pool.
    // Only *missing* files are opened — shared stems stay open across songs.
    std::shared_ptr<StagedSong> next;
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        next = takeWarmLocked(songIndex);
        if (next == nullptr && precached != nullptr && precached->songIndex == songIndex) {
            next = std::move(precached);
            precached.reset();
        }
    }

    // Shared file-pool stems usually need a rewind (left mid-file by the
    // previous song). Do fseek-only first; fill AFTER the active flip so the
    // switch commits immediately (user isn't stuck hearing the old song).
    bool needFill = false;
    if (next == nullptr) {
        next = bindSongToPool(songIndex, song, ringCapacityFrames, deviceSampleRate, error,
                              /*openMissing=*/true);
        if (next == nullptr)
            return false;
        resetSongToStart(*next); // no-op if already at 0 with ring data
        needFill = true;
    } else if (!next->readyAtStart.load(std::memory_order_acquire)) {
        resetSongToStart(*next);
        needFill = true;
    }

    if (muteBeforeSwap != nullptr)
        muteBeforeSwap->store(true, std::memory_order_release);

    std::shared_ptr<StagedSong> prev =
        std::atomic_load_explicit(&active, std::memory_order_acquire);
    next->readyAtStart.store(false, std::memory_order_release);
    std::atomic_store_explicit(&active, next, std::memory_order_release);
    if (prev != nullptr && prev->songIndex != songIndex) {
        std::lock_guard<std::mutex> lock(precacheMutex);
        putWarmLocked(std::move(prev), /*needsRewind=*/true);
    }
    // Under handoff silence: push a tiny head so the first unmuted blocks
    // have audio. Keep this after the flip so hop latency ≠ decode time.
    if (needFill)
        fillHeadOnce(*next);

    recountResidentBytes();
    return true;
}

void StreamingEngine::precacheSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                                   double deviceSampleRate, uint64_t epoch, bool requireEpochMatch) {
    if (requireEpochMatch && epoch != stageEpoch_.load(std::memory_order_acquire))
        return;

    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        if (hasWarmLocked(songIndex))
            return;
        if (auto a = std::atomic_load_explicit(&active, std::memory_order_acquire)) {
            if (a->songIndex == songIndex)
                return;
        }
    }

    std::string err;
    auto staged = bindSongToPool(songIndex, song, ringCapacityFrames, deviceSampleRate, err,
                                 /*openMissing=*/true);
    if (staged == nullptr)
        return;
    if (requireEpochMatch && epoch != stageEpoch_.load(std::memory_order_acquire))
        return;

    resetSongToStart(*staged);
    // Light prime so gapless audio-thread promote has head audio.
    {
        const bool dir = projectLoader != nullptr && projectLoader->isDirectoryContainer();
        if (dir) {
            primeBuffersLocked(*staged, 0.25, deviceSampleRate, 0.08);
        } else {
            std::lock_guard<std::mutex> lock(projectLoaderMutex);
            if (requireEpochMatch && epoch != stageEpoch_.load(std::memory_order_acquire))
                return;
            primeBuffersLocked(*staged, 0.25, deviceSampleRate, 0.08);
        }
    }

    if (requireEpochMatch && epoch != stageEpoch_.load(std::memory_order_acquire))
        return;

    std::lock_guard<std::mutex> lock(precacheMutex);
    if (requireEpochMatch && epoch != stageEpoch_.load(std::memory_order_acquire))
        return;
    if (hasWarmLocked(songIndex))
        return;
    staged->readyAtStart.store(true, std::memory_order_release);
    precached = staged;
    putWarmLocked(std::move(staged), /*needsRewind=*/false);
}

bool StreamingEngine::seekActiveSongTo(int64_t deviceFrame, std::string& error, double primeMaxWait) {
    std::shared_ptr<StagedSong> s = std::atomic_load_explicit(&active, std::memory_order_acquire);
    if (s == nullptr) {
        error = "No active song to seek";
        return false;
    }
    double deviceSr = 0.0;
    std::lock_guard<std::mutex> lock(projectLoaderMutex);
    for (auto& buf : s->buffers) {
        if (buf == nullptr)
            continue;
        if (deviceSr <= 0.0)
            deviceSr = buf->deviceSampleRate();
        std::string bufError;
        if (!buf->hardSeekTo(deviceFrame, bufError)) {
            error = bufError;
            return false;
        }
    }
    if (primeMaxWait > 0.0)
        primeBuffersLocked(*s, std::min(0.25, primeMaxWait * 4.0), deviceSr, primeMaxWait);
    return true;
}

bool StreamingEngine::isPrecacheWarm(size_t songIndex, double minSeconds, double deviceSampleRate) const {
    if (deviceSampleRate <= 0.0)
        deviceSampleRate = 48000.0;
    const int64_t need = static_cast<int64_t>(std::max(0.0, minSeconds) * deviceSampleRate);
    std::shared_ptr<StagedSong> song;
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        auto it = warmByIndex.find(songIndex);
        if (it != warmByIndex.end())
            song = it->second;
        else if (precached && precached->songIndex == songIndex)
            song = precached;
    }
    if (song == nullptr)
        return false;
    if (song->buffers.empty())
        return true;
    for (const auto& buf : song->buffers) {
        if (buf == nullptr)
            continue;
        if (buf->isResident())
            continue;
        if (buf->isExhausted())
            continue;
        if (buf->framesAvailable() < need)
            return false;
    }
    return true;
}

bool StreamingEngine::tryPromotePrecached(size_t songIndex) {
    // AUDIO THREAD — pointer swaps + short mutex only. No disk I/O, no prime.
    //
    // Previously required 0.25s headroom while precache only primed ~0.15s, so
    // gapless AutoplayNext *always* failed promote → message-thread
    // switchToSongGapless under streamHandoff (audible multi-100ms silence).
    // If the next song is in the warm cache at all, promote it; IO tops rings
    // and the short recovery fade-in covers a thin head.
    std::shared_ptr<StagedSong> promoted;
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        promoted = takeWarmLocked(songIndex);
        if (promoted == nullptr && precached != nullptr && precached->songIndex == songIndex) {
            promoted = std::move(precached);
            precached.reset();
        }
        if (promoted == nullptr)
            return false;
    }

    // Park previous active for hopscotch return (needsRewind — was mid-play).
    if (auto prev = std::atomic_load_explicit(&active, std::memory_order_acquire)) {
        if (prev->songIndex != songIndex) {
            std::lock_guard<std::mutex> lock(precacheMutex);
            putWarmLocked(prev, /*needsRewind=*/true);
        }
    }

    size_t used = 0;
    for (auto& b : promoted->buffers)
        if (b && b->isResident())
            used += b->residentBytes();
    residentBytesUsed.store(used, std::memory_order_relaxed);
    // Consumed as the new live song — no longer "ready parked at start".
    promoted->readyAtStart.store(false, std::memory_order_release);
    std::atomic_store_explicit(&active, std::move(promoted), std::memory_order_release);
    return true;
}

bool StreamingEngine::hasPrecacheFor(size_t songIndex) const {
    std::lock_guard<std::mutex> lock(precacheMutex);
    return hasWarmLocked(songIndex);
}

bool StreamingEngine::primeActiveSong(double minSeconds, double deviceSampleRate, double maxWaitSeconds) {
    std::shared_ptr<StagedSong> s = std::atomic_load_explicit(&active, std::memory_order_acquire);
    if (s == nullptr)
        return false;
    std::lock_guard<std::mutex> lock(projectLoaderMutex);
    primeBuffersLocked(*s, minSeconds, deviceSampleRate, maxWaitSeconds);
    return true;
}

double StreamingEngine::minActiveBufferedSeconds(double deviceSampleRate) const {
    return activeBufferHealth(deviceSampleRate).minBufferedSeconds;
}

StreamingEngine::BufferHealth StreamingEngine::activeBufferHealth(double deviceSampleRate) const {
    BufferHealth h;
    if (deviceSampleRate <= 0.0)
        deviceSampleRate = 48000.0;
    std::shared_ptr<StagedSong> s = std::atomic_load_explicit(&active, std::memory_order_acquire);
    if (s == nullptr || s->buffers.empty())
        return h;

    double sum = 0.0;
    int64_t minFrames = std::numeric_limits<int64_t>::max();
    const int64_t urgentFrames = static_cast<int64_t>(1.0 * deviceSampleRate);
    int counted = 0;

    for (const auto& buf : s->buffers) {
        if (buf == nullptr)
            continue;
        ++h.trackCount;
        if (buf->isResident()) {
            ++h.residentTracks;
            h.residentBytes += buf->residentBytes();
            const double sec = 3600.0;
            sum += sec;
            ++counted;
            continue;
        }
        ++h.streamingTracks;
        if (buf->isExhausted())
            continue;
        const int64_t av = buf->framesAvailable();
        minFrames = std::min(minFrames, av);
        sum += static_cast<double>(av) / deviceSampleRate;
        ++counted;
        if (av < urgentFrames)
            h.urgent = true;
    }
    if (counted > 0) {
        h.avgBufferedSeconds = sum / static_cast<double>(counted);
        if (minFrames != std::numeric_limits<int64_t>::max())
            h.minBufferedSeconds = static_cast<double>(minFrames) / deviceSampleRate;
    }
    return h;
}

StreamingEngine::ActiveSongHandle StreamingEngine::acquireActiveSong() {
    ActiveSongHandle h;
    h.staged = std::atomic_load_explicit(&active, std::memory_order_acquire);
    return h;
}

} // namespace resostage
