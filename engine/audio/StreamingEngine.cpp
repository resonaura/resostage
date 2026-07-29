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
}

void StreamingEngine::stop() {
    running.store(false, std::memory_order_release);
    if (ioThread.joinable())
        ioThread.join();
    if (ioThread2.joinable())
        ioThread2.join();
}

void StreamingEngine::applyRegionWindow(StreamingTrackBuffer& buf, const Region& region,
                                        double deviceSampleRate) const {
    applyWindowFromRegion(buf, region, deviceSampleRate);
}

void StreamingEngine::residentizeSong(StagedSong& staged, size_t budgetBytes, size_t& usedBytes) {
    usedBytes = 0;
    if (budgetBytes == 0 || staged.buffers.empty())
        return;

    struct Cand {
        StreamingTrackBuffer* buf = nullptr;
        size_t bytes = 0;
    };
    std::vector<Cand> cands;
    cands.reserve(staged.buffers.size());
    for (auto& b : staged.buffers) {
        if (b == nullptr || b->isResident())
            continue;
        Cand c;
        c.buf = b.get();
        c.bytes = b->estimatedResidentBytes();
        // Empty window still "resident" cheaply.
        cands.push_back(c);
    }
    // Smallest first → more stems go RAM-resident (smart under "lots of emptiness"
    // after windowing: short used clips win over multi-minute full stems).
    std::sort(cands.begin(), cands.end(),
              [](const Cand& a, const Cand& b) { return a.bytes < b.bytes; });

    for (const Cand& c : cands) {
        if (c.buf == nullptr)
            continue;
        const size_t need = c.bytes;
        if (need > budgetBytes - usedBytes && need > 0)
            continue; // leave this stem streaming
        size_t got = 0;
        std::string err;
        if (c.buf->tryLoadResident(budgetBytes - usedBytes, got, err)) {
            usedBytes += got;
        }
        // On failure keep streaming ring — no hard error.
    }
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
                                double deviceSampleRate, std::string& error) {
    const size_t budget = residentBudgetBytes.load(std::memory_order_relaxed);

    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        if (precached != nullptr && precached->songIndex == songIndex) {
            auto promoted = std::shared_ptr<StagedSong>(std::move(precached));
            size_t used = 0;
            for (auto& b : promoted->buffers)
                if (b && b->isResident())
                    used += b->residentBytes();
            // Fill any stems that were only ring-primed during precache.
            {
                std::lock_guard<std::mutex> zipLock(projectLoaderMutex);
                size_t add = 0;
                residentizeSong(*promoted, budget > used ? budget - used : 0, add);
                used += add;
                primeBuffersLocked(*promoted, 1.0, deviceSampleRate, 0.35);
            }
            residentBytesUsed.store(used, std::memory_order_relaxed);
            std::atomic_store_explicit(&active, promoted, std::memory_order_release);
            return true;
        }
    }

    auto staged = std::make_shared<StagedSong>();
    staged->songIndex = songIndex;
    for (const Region& regionDef : song.regions) {
        if (regionDef.file.empty())
            continue;
        auto buf = std::make_unique<StreamingTrackBuffer>();
        std::string openError;
        {
            std::lock_guard<std::mutex> lock(projectLoaderMutex);
            if (projectLoader == nullptr
                || !buf->open(*projectLoader, regionDef.file, ringCapacityFrames, deviceSampleRate,
                              openError)) {
                error = "Region '" + regionDef.id + "': "
                        + (openError.empty() ? "no project loader" : openError);
                return false;
            }
            applyRegionWindow(*buf, regionDef, deviceSampleRate);
        }
        staged->byId[regionDef.id] = buf.get();
        staged->byId[regionDef.trackId] = buf.get();
        staged->buffers.push_back(std::move(buf));
    }

    size_t used = 0;
    {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        // Active song gets the full budget first.
        residentizeSong(*staged, budget, used);
        primeBuffersLocked(*staged, 1.0, deviceSampleRate, 0.5);
    }
    residentBytesUsed.store(used, std::memory_order_relaxed);
    std::atomic_store_explicit(&active, staged, std::memory_order_release);
    return true;
}

void StreamingEngine::precacheSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                                   double deviceSampleRate) {
    auto staged = std::make_unique<StagedSong>();
    staged->songIndex = songIndex;
    for (const Region& regionDef : song.regions) {
        if (regionDef.file.empty())
            continue;
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

    // Next song gets only leftover budget after active residency.
    size_t activeUsed = residentBytesUsed.load(std::memory_order_relaxed);
    const size_t budget = residentBudgetBytes.load(std::memory_order_relaxed);
    const size_t remain = budget > activeUsed ? budget - activeUsed : 0;
    size_t pcUsed = 0;
    {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        residentizeSong(*staged, remain, pcUsed);
        primeBuffersLocked(*staged, 0.5, deviceSampleRate, 0.2);
    }

    std::lock_guard<std::mutex> lock(precacheMutex);
    precached = std::move(staged);
}

bool StreamingEngine::seekActiveSongTo(int64_t deviceFrame, std::string& error) {
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
    primeBuffersLocked(*s, 1.5, deviceSr, 0.4);
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

    size_t used = 0;
    for (auto& b : precached->buffers)
        if (b && b->isResident())
            used += b->residentBytes();
    residentBytesUsed.store(used, std::memory_order_relaxed);

    std::atomic_store_explicit(&active, std::shared_ptr<StagedSong>(std::move(precached)),
                               std::memory_order_release);
    precached.reset();
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
