#include "StreamingEngine.h"

#include <chrono>

namespace resoset {

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
        {
            std::shared_ptr<StagedSong> s = std::atomic_load_explicit(&active, std::memory_order_acquire);
            if (s != nullptr) {
                std::lock_guard<std::mutex> lock(projectLoaderMutex);
                for (auto& buf : s->buffers)
                    buf->refill();
            }
        }
        {
            std::lock_guard<std::mutex> pcLock(precacheMutex);
            if (precached != nullptr) {
                std::lock_guard<std::mutex> zipLock(projectLoaderMutex);
                for (auto& buf : precached->buffers)
                    buf->refill();
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    if (ioThreadStopHook)
        ioThreadStopHook();
}

bool StreamingEngine::stageSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                                double deviceSampleRate, std::string& error) {
    {
        std::lock_guard<std::mutex> lock(precacheMutex);
        if (precached != nullptr && precached->songIndex == songIndex) {
            std::atomic_store_explicit(&active, std::shared_ptr<StagedSong>(std::move(precached)),
                                        std::memory_order_release);
            return true;
        }
    }

    auto staged = std::make_shared<StagedSong>();
    staged->songIndex = songIndex;
    {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        for (const TrackDef& trackDef : song.tracks) {
            if (trackDef.file.empty())
                continue; // empty region — no audio yet, skip streaming
            auto buf = std::make_unique<StreamingTrackBuffer>();
            std::string openError;
            if (!buf->open(*projectLoader, trackDef.file, ringCapacityFrames, deviceSampleRate, openError)) {
                error = "Track '" + trackDef.id + "': " + openError;
                return false;
            }
            staged->byId[trackDef.id] = buf.get();
            staged->buffers.push_back(std::move(buf));
        }
    }

    std::atomic_store_explicit(&active, staged, std::memory_order_release);
    return true;
}

void StreamingEngine::precacheSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames,
                                   double deviceSampleRate) {
    auto staged = std::make_unique<StagedSong>();
    staged->songIndex = songIndex;
    {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        for (const TrackDef& trackDef : song.tracks) {
            auto buf = std::make_unique<StreamingTrackBuffer>();
            std::string openError;
            if (!buf->open(*projectLoader, trackDef.file, ringCapacityFrames, deviceSampleRate, openError))
                return; // best-effort; stageSong() will retry and report properly later
            staged->byId[trackDef.id] = buf.get();
            staged->buffers.push_back(std::move(buf));
        }
    }

    std::lock_guard<std::mutex> lock(precacheMutex);
    precached = std::move(staged);
}

StreamingEngine::ActiveSongHandle StreamingEngine::acquireActiveSong() {
    ActiveSongHandle handle;
    handle.staged = std::atomic_load_explicit(&active, std::memory_order_acquire);
    return handle;
}

} // namespace resoset
