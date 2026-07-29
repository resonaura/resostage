#include "StreamingEngine.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>

namespace resoset {

namespace {

constexpr double kLowWaterFrac = 0.25;
constexpr double kHighWaterFrac = 0.75;
constexpr int kMaxRefillsPerBufferPerTick = 4;
constexpr int kMaxActiveBurstRefills = 64;
constexpr int kMaxPrecacheBurstHealthy = 8;
constexpr int kMaxPrecacheBurstHungry = 2;
constexpr int kMutexYieldEveryRefills = 8;

void applyWindowFromRegion(StreamingTrackBuffer& buf, const Region& region, double deviceSampleRate) {
    const double sr = deviceSampleRate > 0.0 ? deviceSampleRate : 48000.0;
    const int64_t total = buf.totalFrames();
    int64_t srcOff = static_cast<int64_t>(std::llround(std::max(0.0, region.sourceOffsetSeconds) * sr));
    if (srcOff > total)
        srcOff = total;
    const int64_t sourceAvail = std::max<int64_t>(0, total - srcOff);

    int64_t len = sourceAvail;
    if (region.loop) {
        // Loop body only once — engine wraps file positions on read.
        len = sourceAvail;
    } else if (region.durationSeconds > 0.0) {
        const int64_t durFrames =
            static_cast<int64_t>(std::llround(region.durationSeconds * sr));
        len = std::min(sourceAvail, std::max<int64_t>(0, durFrames));
    }
    buf.setPreferredResidentWindow(srcOff, len);
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
    running.store(true, std::memory_order_release);
    ioThread = std::thread([this] { ioWorkerLoop(0); });
    // Second feeder: directory containers have independent FILE* — real parallel
    // refill. For ZIP, worker 1 still runs but serializes on the same mutex
    // (harmless extra waiter; primary work stays on worker 0 when contended).
    ioThread2 = std::thread([this] { ioWorkerLoop(1); });
    // RAM residency is slow (full source-window decode). Never do it on
    // stageSong — a dedicated thread promotes stems after playback is live.
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
}

void StreamingEngine::applyRegionWindow(StreamingTrackBuffer& buf, const Region& region,
                                        double deviceSampleRate) const {
    applyWindowFromRegion(buf, region, deviceSampleRate);
}

void StreamingEngine::recountResidentBytes() {
    size_t used = 0;
    if (auto s = std::atomic_load_explicit(&active, std::memory_order_acquire)) {
        for (const auto& b : s->buffers)
            if (b && b->isResident())
                used += b->residentBytes();
    }
    std::shared_ptr<StagedSong> pc;
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        pc = precached;
    }
    if (pc != nullptr) {
        for (const auto& b : pc->buffers)
            if (b && b->isResident())
                used += b->residentBytes();
    }
    residentBytesUsed.store(used, std::memory_order_relaxed);
}

bool StreamingEngine::residentizeOneBuffer(StagedSong& staged, size_t& budgetRemaining) {
    // Prefer smallest non-resident window first (more stems fit).
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
    // Caller must keep `staged` alive (shared_ptr) for the whole decode.
    // Do NOT hold precacheMutex / stage locks across this — decode is slow.
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
        // Skip work while epoch is spinning (rapid hopscotch) — wait for
        // stageSong to settle so we don't burn CPU decoding abandoned songs.
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

        // Active first — hold shared_ptr for the whole side-channel decode.
        // tryLoadResident no longer mutates live cursor/ring until publish,
        // so audio can keep streaming that stem safely.
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
            std::shared_ptr<StagedSong> pc;
            {
                std::lock_guard<std::mutex> lock(precacheMutex);
                pc = precached;
            }
            if (pc != nullptr && remain > 0) {
                if (residentizeOneBuffer(*pc, remain)) {
                    didWork = true;
                    recountResidentBytes();
                }
            }
        }

        std::this_thread::sleep_for(
            std::chrono::milliseconds(didWork ? 15 : 40));
    }
}

void StreamingEngine::dropPrecacheUnless(size_t expectedNext) {
    std::lock_guard<std::mutex> lock(precacheMutex);
    if (precached != nullptr && precached->songIndex != expectedNext)
        precached.reset();
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
                        return; // drop lock
                }
            }
        };

        if (dirContainer) {
            // Independent FILE* — no shared zip mutex for refill.
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

        // Only worker 0 services precache (avoids double-refill races).
        if (workerIndex == 0 && !urgent) {
            std::lock_guard<std::mutex> pcLock(precacheMutex);
            if (precached != nullptr) {
                const bool dirContainer =
                    projectLoader != nullptr && projectLoader->isDirectoryContainer();
                int budget = hungry ? kMaxPrecacheBurstHungry : kMaxPrecacheBurstHealthy;
                auto refillPc = [&] {
                    for (auto& buf : precached->buffers) {
                        if (buf == nullptr || budget <= 0)
                            continue;
                        if (buf->isResident())
                            continue;
                        if (buf->wantsRefill()) {
                            buf->refill();
                            --budget;
                        }
                    }
                };
                if (dirContainer)
                    refillPc();
                else {
                    std::lock_guard<std::mutex> zipLock(projectLoaderMutex);
                    refillPc();
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

bool StreamingEngine::stageSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                                double deviceSampleRate, std::string& error, double primeSeconds,
                                double primeMaxWait) {
    // FAST PATH ONLY. Bump epoch so deferred precache jobs for other songs abandon.
    stageEpoch_.fetch_add(1, std::memory_order_acq_rel);

    // Promote path: take precache without holding the mutex during prime.
    {
        std::shared_ptr<StagedSong> promoted;
        {
            std::lock_guard<std::mutex> lock(precacheMutex);
            if (precached != nullptr && precached->songIndex == songIndex) {
                promoted = std::move(precached);
                precached.reset();
            }
        }
        if (promoted) {
            if (primeMaxWait > 0.0 && primeSeconds > 0.0) {
                std::lock_guard<std::mutex> zipLock(projectLoaderMutex);
                primeBuffersLocked(*promoted, primeSeconds, deviceSampleRate, primeMaxWait);
            }
            std::atomic_store_explicit(&active, promoted, std::memory_order_release);
            recountResidentBytes();
            return true;
        }
    }

    // Cold stage: drop a stale precache that is not the sequential neighbour.
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        if (precached != nullptr && precached->songIndex != songIndex + 1)
            precached.reset();
    }

    auto staged = std::make_shared<StagedSong>();
    staged->songIndex = songIndex;

    // Directory packages: each open is an independent fopen — open stems
    // without holding the zip mutex across the whole song (serial open was a
    // major "first song click lag" cost with many regions).
    const bool dirContainer =
        projectLoader != nullptr && projectLoader->isDirectoryContainer();

    for (const Region& regionDef : song.regions) {
        if (regionDef.file.empty())
            continue;
        auto buf = std::make_unique<StreamingTrackBuffer>();
        std::string openError;
        bool ok = false;
        if (dirContainer) {
            // No shared mz_zip — parallel-safe vs IO refill of other songs.
            ok = projectLoader != nullptr
                 && buf->open(*projectLoader, regionDef.file, ringCapacityFrames, deviceSampleRate,
                              openError);
        } else {
            std::lock_guard<std::mutex> lock(projectLoaderMutex);
            ok = projectLoader != nullptr
                 && buf->open(*projectLoader, regionDef.file, ringCapacityFrames, deviceSampleRate,
                              openError);
        }
        if (!ok) {
            error = "Region '" + regionDef.id + "': "
                    + (openError.empty() ? "no project loader" : openError);
            return false;
        }
        applyRegionWindow(*buf, regionDef, deviceSampleRate);
        staged->byId[regionDef.id] = buf.get();
        staged->byId[regionDef.trackId] = buf.get();
        staged->buffers.push_back(std::move(buf));
    }

    if (primeMaxWait > 0.0 && primeSeconds > 0.0) {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        primeBuffersLocked(*staged, primeSeconds, deviceSampleRate, primeMaxWait);
    }
    std::atomic_store_explicit(&active, staged, std::memory_order_release);
    recountResidentBytes();
    return true;
}

void StreamingEngine::precacheSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                                   double deviceSampleRate, uint64_t epoch) {
    // Abandon if user already staged another song while we were queued.
    if (epoch != stageEpoch_.load(std::memory_order_acquire))
        return;

    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        if (precached != nullptr && precached->songIndex == songIndex)
            return; // already the right neighbour
    }

    auto staged = std::make_shared<StagedSong>();
    staged->songIndex = songIndex;
    for (const Region& regionDef : song.regions) {
        if (regionDef.file.empty())
            continue;
        // Bail mid-open if user hopped again.
        if (epoch != stageEpoch_.load(std::memory_order_acquire))
            return;
        auto buf = std::make_unique<StreamingTrackBuffer>();
        std::string openError;
        {
            std::lock_guard<std::mutex> lock(projectLoaderMutex);
            if (projectLoader == nullptr
                || !buf->open(*projectLoader, regionDef.file, ringCapacityFrames, deviceSampleRate,
                              openError))
                return;
            applyRegionWindow(*buf, regionDef, deviceSampleRate);
        }
        staged->byId[regionDef.id] = buf.get();
        staged->byId[regionDef.trackId] = buf.get();
        staged->buffers.push_back(std::move(buf));
    }

    if (epoch != stageEpoch_.load(std::memory_order_acquire))
        return;

    {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        if (epoch != stageEpoch_.load(std::memory_order_acquire))
            return;
        primeBuffersLocked(*staged, /*minSeconds=*/0.2, deviceSampleRate,
                           /*maxWaitSeconds=*/0.08);
    }

    if (epoch != stageEpoch_.load(std::memory_order_acquire))
        return;

    std::lock_guard<std::mutex> lock(precacheMutex);
    // Final check under lock — do not clobber a newer precache from a later epoch.
    if (epoch != stageEpoch_.load(std::memory_order_acquire))
        return;
    precached = std::move(staged);
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
    // Optional short prime — skip when stopped (primeMaxWait == 0).
    if (primeMaxWait > 0.0)
        primeBuffersLocked(*s, std::min(0.25, primeMaxWait * 4.0), deviceSr, primeMaxWait);
    return true;
}

bool StreamingEngine::isPrecacheWarm(size_t songIndex, double minSeconds, double deviceSampleRate) const {
    if (deviceSampleRate <= 0.0)
        deviceSampleRate = 48000.0;
    const int64_t need = static_cast<int64_t>(std::max(0.0, minSeconds) * deviceSampleRate);
    std::lock_guard<std::mutex> lock(precacheMutex);
    if (precached == nullptr || precached->songIndex != songIndex)
        return false;
    if (precached->buffers.empty())
        return true;
    for (const auto& buf : precached->buffers) {
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
    std::shared_ptr<StagedSong> promoted;
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        if (precached == nullptr || precached->songIndex != songIndex)
            return false;

        constexpr double kMinWarmSeconds = 0.25;
        double deviceSr = 48000.0;
        for (const auto& buf : precached->buffers) {
            if (buf != nullptr && buf->deviceSampleRate() > 0.0) {
                deviceSr = buf->deviceSampleRate();
                break;
            }
        }
        const int64_t need = static_cast<int64_t>(kMinWarmSeconds * deviceSr);
        for (const auto& buf : precached->buffers) {
            if (buf == nullptr)
                continue;
            if (buf->isResident())
                continue;
            if (buf->isExhausted())
                continue;
            if (buf->framesAvailable() < need)
                return false;
        }
        promoted = std::move(precached);
        precached.reset();
    }

    size_t used = 0;
    for (auto& b : promoted->buffers)
        if (b && b->isResident())
            used += b->residentBytes();
    residentBytesUsed.store(used, std::memory_order_relaxed);
    // Gapless promote: epoch not bumped here — message thread will stage/select
    // and bump when it fully commits; audio-thread path only swaps active.
    std::atomic_store_explicit(&active, std::move(promoted), std::memory_order_release);
    return true;
}

bool StreamingEngine::hasPrecacheFor(size_t songIndex) const {
    std::lock_guard<std::mutex> lock(precacheMutex);
    return precached != nullptr && precached->songIndex == songIndex;
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

    for (const auto& buf : s->buffers) {
        if (buf == nullptr)
            continue;
        ++h.trackCount;
        if (buf->isResident()) {
            ++h.residentTracks;
            h.residentBytes += buf->residentBytes();
            // Treat as "infinite" buffer for min — use a large sentinel for avg.
            const double sec = 3600.0;
            sum += sec;
            continue;
        }
        ++h.streamingTracks;
        if (buf->isExhausted())
            continue;
        const int64_t av = buf->framesAvailable();
        minFrames = std::min(minFrames, av);
        sum += static_cast<double>(av) / deviceSampleRate;
        if (av < urgentFrames)
            h.urgent = true;
    }

    if (h.trackCount > 0)
        h.avgBufferedSeconds = sum / static_cast<double>(h.trackCount);
    if (minFrames != std::numeric_limits<int64_t>::max())
        h.minBufferedSeconds = static_cast<double>(minFrames) / deviceSampleRate;
    else if (h.residentTracks == h.trackCount && h.trackCount > 0)
        h.minBufferedSeconds = 3600.0; // all RAM
    return h;
}

StreamingEngine::ActiveSongHandle StreamingEngine::acquireActiveSong() {
    ActiveSongHandle handle;
    handle.staged = std::atomic_load_explicit(&active, std::memory_order_acquire);
    return handle;
}

} // namespace resoset
