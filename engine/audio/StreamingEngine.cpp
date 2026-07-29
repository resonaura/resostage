#include "StreamingEngine.h"

#include <algorithm>
#include <chrono>
#include <limits>

namespace resoset {

namespace {

// Watermarks as fractions of ring capacity (device frames).
// Below low → emergency fill (short sleep, starve heavy precache).
// Below high → prefer active, but still trickle-fill precache for gapless.
constexpr double kLowWaterFrac = 0.25;  // e.g. 2s of an 8s ring
constexpr double kHighWaterFrac = 0.75; // e.g. 6s of an 8s ring

// Fairness: never let one stem burn the whole tick. Round-robin with a
// small per-buffer cap, then a global cap so the zip mutex isn't held for
// multi-second wall time under a dead disk.
constexpr int kMaxRefillsPerBufferPerTick = 4;
constexpr int kMaxActiveBurstRefills = 64;
constexpr int kMaxPrecacheBurstHealthy = 8;
constexpr int kMaxPrecacheBurstHungry = 2; // trickle so next song isn't empty
// Release the zip mutex every N refills so play()/save/UI can interleave
// instead of waiting for a full 64-chunk burst on a thrashing SSD.
constexpr int kMutexYieldEveryRefills = 8;

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
    ioThread = std::thread([this] { ioThreadLoop(); });
}

void StreamingEngine::stop() {
    running.store(false, std::memory_order_release);
    if (ioThread.joinable())
        ioThread.join();
}

void StreamingEngine::ioThreadLoop() {
    if (ioThreadStartHook)
        ioThreadStartHook();

    while (running.load(std::memory_order_acquire)) {
        bool urgent = false;       // low-water or pending skip on active
        bool activeHungry = false; // below high-water

        {
            std::shared_ptr<StagedSong> s = std::atomic_load_explicit(&active, std::memory_order_acquire);
            if (s != nullptr) {
                int globalBudget = kMaxActiveBurstRefills;
                int sinceYield = 0;
                bool progress = true;

                // Hold the lock only in short slices so a slow disk cannot
                // freeze play()/prime/seek/save for the entire burst.
                while (progress && globalBudget > 0
                       && running.load(std::memory_order_relaxed)) {
                    progress = false;
                    std::lock_guard<std::mutex> lock(projectLoaderMutex);
                    for (auto& buf : s->buffers) {
                        if (buf == nullptr || globalBudget <= 0)
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
                            activeHungry = true;
                        } else if (belowHigh) {
                            activeHungry = true;
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
                            if (!skipPending && !lowWater && buf->framesAvailable() >= high
                                && n >= 1)
                                break;
                            buf->refill();
                            --globalBudget;
                            ++sinceYield;
                            progress = true;

                            if (sinceYield >= kMutexYieldEveryRefills) {
                                // Drop lock so other waiters can run, then
                                // continue the outer while (re-acquire).
                                sinceYield = 0;
                                // Force re-lock via leaving the lock_guard scope:
                                // break out of buffer loops; outer while continues.
                                goto yield_mutex;
                            }
                        }
                    }
                    continue;
                yield_mutex:
                    progress = true; // try another slice if budget remains
                }
            }
        }

        // Precache policy:
        //  - urgent (about to underrun / skip): zero precache — live first
        //  - hungry but not urgent: tiny trickle so gapless next song isn't empty
        //  - healthy: normal precache budget
        // Previously "hungry ⇒ no precache" left AutoplayNext with dry rings
        // after every multi-track show under moderate disk load.
        if (!urgent) {
            std::lock_guard<std::mutex> pcLock(precacheMutex);
            if (precached != nullptr) {
                std::lock_guard<std::mutex> zipLock(projectLoaderMutex);
                int budget = activeHungry ? kMaxPrecacheBurstHungry
                                          : kMaxPrecacheBurstHealthy;
                for (auto& buf : precached->buffers) {
                    if (buf == nullptr || budget <= 0)
                        continue;
                    if (buf->wantsRefill()) {
                        buf->refill();
                        --budget;
                    }
                }
            }
        }

        if (urgent)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        else if (activeHungry)
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        else
            std::this_thread::sleep_for(std::chrono::milliseconds(8));
    }

    if (ioThreadStopHook)
        ioThreadStopHook();
}

StreamingTrackBuffer* StreamingEngine::ActiveSongHandle::region(const std::string& regionId) const {
    return track(regionId);
}

void StreamingEngine::primeBuffersLocked(StagedSong& staged, double minSeconds, double deviceSampleRate,
                                         double maxWaitSeconds) {
    if (deviceSampleRate <= 0.0)
        deviceSampleRate = 48000.0;
    // Target is "at least minSeconds" — NOT high-water (IO loop owns that).
    const int64_t minFrames = static_cast<int64_t>(
        std::max(0.0, minSeconds) * deviceSampleRate);
    const auto deadline = std::chrono::steady_clock::now()
                          + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                              std::chrono::duration<double>(std::max(0.0, maxWaitSeconds)));

    while (std::chrono::steady_clock::now() < deadline) {
        bool anyProgress = false;
        bool allSatisfied = true;
        for (auto& buf : staged.buffers) {
            if (buf == nullptr)
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
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        if (precached != nullptr && precached->songIndex == songIndex) {
            auto promoted = std::shared_ptr<StagedSong>(std::move(precached));
            {
                std::lock_guard<std::mutex> zipLock(projectLoaderMutex);
                primeBuffersLocked(*promoted, /*minSeconds=*/1.0, deviceSampleRate,
                                   /*maxWaitSeconds=*/0.35);
            }
            std::atomic_store_explicit(&active, promoted, std::memory_order_release);
            return true;
        }
    }

    auto staged = std::make_shared<StagedSong>();
    staged->songIndex = songIndex;
    {
        // Open one region at a time with unlock between so a live active
        // song (gapless handoff / concurrent play) can still refill.
        for (const Region& regionDef : song.regions) {
            if (regionDef.file.empty())
                continue;
            auto buf = std::make_unique<StreamingTrackBuffer>();
            std::string openError;
            {
                // One open per lock slice so a concurrent live song can refill.
                std::lock_guard<std::mutex> lock(projectLoaderMutex);
                if (projectLoader == nullptr
                    || !buf->open(*projectLoader, regionDef.file, ringCapacityFrames,
                                  deviceSampleRate, openError)) {
                    error = "Region '" + regionDef.id + "': "
                            + (openError.empty() ? "no project loader" : openError);
                    return false;
                }
            }
            staged->byId[regionDef.id] = buf.get();
            staged->byId[regionDef.trackId] = buf.get();
            staged->buffers.push_back(std::move(buf));
        }
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        primeBuffersLocked(*staged, /*minSeconds=*/1.0, deviceSampleRate, /*maxWaitSeconds=*/0.5);
    }

    std::atomic_store_explicit(&active, staged, std::memory_order_release);
    return true;
}

void StreamingEngine::precacheSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                                   double deviceSampleRate) {
    auto staged = std::make_unique<StagedSong>();
    staged->songIndex = songIndex;
    // Open one-at-a-time, releasing the zip lock between stems so the active
    // song's IO thread can keep feeding rings during AutoplayNext prep.
    for (const Region& regionDef : song.regions) {
        if (regionDef.file.empty())
            continue;
        auto buf = std::make_unique<StreamingTrackBuffer>();
        std::string openError;
        {
            std::lock_guard<std::mutex> lock(projectLoaderMutex);
            if (!buf->open(*projectLoader, regionDef.file, ringCapacityFrames, deviceSampleRate,
                           openError))
                return; // best-effort
        }
        staged->byId[regionDef.id] = buf.get();
        staged->byId[regionDef.trackId] = buf.get();
        staged->buffers.push_back(std::move(buf));
    }
    {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        primeBuffersLocked(*staged, /*minSeconds=*/0.5, deviceSampleRate, /*maxWaitSeconds=*/0.2);
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
    primeBuffersLocked(*s, /*minSeconds=*/1.5, deviceSr, /*maxWaitSeconds=*/0.4);
    return true;
}

bool StreamingEngine::isPrecacheWarm(size_t songIndex, double minSeconds,
                                     double deviceSampleRate) const {
    if (deviceSampleRate <= 0.0)
        deviceSampleRate = 48000.0;
    const int64_t need = static_cast<int64_t>(std::max(0.0, minSeconds) * deviceSampleRate);
    std::lock_guard<std::mutex> lock(precacheMutex);
    if (precached == nullptr || precached->songIndex != songIndex)
        return false;
    if (precached->buffers.empty())
        return true; // click-only / empty song is always "warm"
    for (const auto& buf : precached->buffers) {
        if (buf == nullptr)
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
    // Refuse a cold handoff on the audio thread — silence + click desync.
    // Message-thread gapless path will stageSong/prime instead.
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
        if (buf->isExhausted())
            continue;
        if (buf->framesAvailable() < need)
            return false;
    }
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
    if (deviceSampleRate <= 0.0)
        return 0.0;
    std::shared_ptr<StagedSong> s = std::atomic_load_explicit(&active, std::memory_order_acquire);
    if (s == nullptr || s->buffers.empty())
        return 0.0;
    int64_t minFrames = std::numeric_limits<int64_t>::max();
    bool any = false;
    for (const auto& buf : s->buffers) {
        if (buf == nullptr)
            continue;
        if (buf->isExhausted())
            continue;
        any = true;
        minFrames = std::min(minFrames, buf->framesAvailable());
    }
    if (!any)
        return 0.0;
    return static_cast<double>(minFrames) / deviceSampleRate;
}

StreamingEngine::ActiveSongHandle StreamingEngine::acquireActiveSong() {
    ActiveSongHandle handle;
    handle.staged = std::atomic_load_explicit(&active, std::memory_order_acquire);
    return handle;
}

} // namespace resoset
