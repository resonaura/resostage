#pragma once

#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace resostage {

// Fixed-size worker pool for peak/waveform decode jobs. Replaces the old
// pattern of spawning one raw std::thread per file: for a large project with
// many uncached stems, that pattern could fan out to dozens or hundreds of
// concurrent OS threads (see AudioEngine::ensureAllSongPeaksBuilt()), causing
// scheduler thrashing and memory-bandwidth contention instead of a speedup.
// A bounded pool exploits the same parallelism without oversubscription, and
// because it's shared, concurrent callers (a song-switch rebuild racing a
// whole-project sweep) queue against the same fixed worker set rather than
// each spawning their own unbounded batch.
class PeakBuildThreadPool {
public:
    explicit PeakBuildThreadPool(size_t numThreads);
    ~PeakBuildThreadPool();

    PeakBuildThreadPool(const PeakBuildThreadPool&) = delete;
    PeakBuildThreadPool& operator=(const PeakBuildThreadPool&) = delete;

    // Enqueues all `jobs` on the pool's workers and blocks the calling thread
    // until every job in this batch has completed. Safe to call concurrently
    // from multiple threads -- batches interleave on the shared workers.
    void runBatchAndWait(std::vector<std::function<void()>> jobs);

private:
    void workerLoop();

    std::vector<std::thread> workers;
    std::mutex queueMutex;
    std::condition_variable queueCv;
    std::deque<std::function<void()>> queue;
    bool shuttingDown = false;
};

} // namespace resostage
