#include "PeakBuildThreadPool.h"

#include <atomic>
#include <memory>

namespace resostage {

PeakBuildThreadPool::PeakBuildThreadPool(size_t numThreads) {
    if (numThreads < 1)
        numThreads = 1;
    workers.reserve(numThreads);
    for (size_t i = 0; i < numThreads; ++i)
        workers.emplace_back([this] { workerLoop(); });
}

PeakBuildThreadPool::~PeakBuildThreadPool() {
    {
        std::lock_guard<std::mutex> lock(queueMutex);
        shuttingDown = true;
    }
    queueCv.notify_all();
    for (auto& w : workers)
        if (w.joinable())
            w.join();
}

void PeakBuildThreadPool::workerLoop() {
    for (;;) {
        std::function<void()> job;
        {
            std::unique_lock<std::mutex> lock(queueMutex);
            queueCv.wait(lock, [this] { return shuttingDown || !queue.empty(); });
            if (queue.empty()) {
                if (shuttingDown)
                    return;
                continue;
            }
            job = std::move(queue.front());
            queue.pop_front();
        }
        job();
    }
}

void PeakBuildThreadPool::runBatchAndWait(std::vector<std::function<void()>> jobs) {
    if (jobs.empty())
        return;

    auto remaining = std::make_shared<std::atomic<size_t>>(jobs.size());
    auto doneMutex = std::make_shared<std::mutex>();
    auto doneCv = std::make_shared<std::condition_variable>();

    {
        std::lock_guard<std::mutex> lock(queueMutex);
        for (auto& job : jobs) {
            queue.push_back([job = std::move(job), remaining, doneMutex, doneCv]() mutable {
                job();
                if (remaining->fetch_sub(1, std::memory_order_acq_rel) == 1) {
                    std::lock_guard<std::mutex> doneLock(*doneMutex);
                    doneCv->notify_all();
                }
            });
        }
    }
    queueCv.notify_all();

    std::unique_lock<std::mutex> lock(*doneMutex);
    doneCv->wait(lock, [&] { return remaining->load(std::memory_order_acquire) == 0; });
}

} // namespace resostage
