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

// Owns exactly one background I/O thread that keeps a bounded set of
// StreamingTrackBuffers topped up. All ProjectLoader::StreamCursor calls for
// a given ProjectLoader happen from this thread or from stageSong()/
// precacheSong() (serialized against each other via projectLoaderMutex),
// since they share one underlying zip file handle.
//
// Bounds memory regardless of set length: only the current song's tracks
// (plus, opportunistically, the next song's) are ever resident, each capped
// at `ringCapacityFrames` of buffered audio -- never the whole file.
class StreamingEngine {
public:
    struct StagedSong {
        size_t songIndex = static_cast<size_t>(-1);
        std::vector<std::unique_ptr<StreamingTrackBuffer>> buffers;
        std::unordered_map<std::string, StreamingTrackBuffer*> byId;
    };

    // Audio-thread-only handle keeping a staged song's buffers alive for as
    // long as it's held (a shared_ptr refcount, not a raw pointer into
    // memory that could be freed mid-use by a concurrent stageSong() call --
    // see RoutingEngine's doc comment for why raw-pointer-plus-manual-delete
    // reclamation is deliberately avoided here too). Acquire ONE handle per
    // render block and hold it for the block's duration.
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

    // `loader` must outlive the engine. `onIoThreadStart`, if given, is
    // called once from the background I/O thread itself before its main
    // loop begins -- e.g. to join a platform real-time thread workgroup.
    // `onIoThreadStop`, if given, is called from that same thread right
    // before it returns/exits -- e.g. to leave that workgroup again. This
    // thread is NOT process-lifetime (stop() joins it on every
    // newProject()/loadProject()/saveProject()), so join and leave must be
    // symmetric: macOS crashes (SIGTRAP in _os_workgroup_tsd_cleanup) if a
    // thread exits while still joined to an os_workgroup. Kept as injectable
    // hooks (rather than calling platform APIs here directly) so this
    // portable engine library stays free of any JUCE/CoreAudio dependency.
    void start(const ProjectLoader* loader, std::function<void()> onIoThreadStart = nullptr,
               std::function<void()> onIoThreadStop = nullptr);
    void stop();

    // Opens WAV headers (fast) for the song's tracks and publishes them as
    // the active staged song. If `songIndex` was already precached, promotes
    // it instead of re-opening. Message-thread-only. Safe to call at any
    // time regardless of playback state (unlike an earlier raw-pointer-swap
    // design this replaced, which relied on the caller guaranteeing playback
    // was stopped -- reference counting removes that fragile precondition).
    // `deviceSampleRate` is forwarded to each StreamingTrackBuffer::open()
    // so it can resample tracks whose native WAV rate differs from it.
    bool stageSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames, double deviceSampleRate,
                   std::string& error);

    // Opportunistically pre-opens the next song's track headers on the
    // message thread (best-effort; failures are silently ignored since
    // stageSong() will retry properly and report errors when that song
    // actually becomes current).
    void precacheSong(size_t songIndex, const SongDef& song, int64_t ringCapacityFrames, double deviceSampleRate);

    // Message-thread-only. Hard-seeks every buffer of the currently active
    // staged song to `deviceFrame` (sample-accurate, sync). Holds
    // projectLoaderMutex so the I/O thread cannot race the re-open/skip.
    // Must be called with playback not consuming these buffers (seek path
    // already stop()s first). Returns false if any buffer fails to seek.
    bool seekActiveSongTo(int64_t deviceFrame, std::string& error);

    // Audio-thread-safe: if `songIndex` is already precached, atomically
    // promote it to active and return true. No disk I/O, no allocation beyond
    // shared_ptr refcount. Used for sample-accurate AutoplayNext handoff
    // without waiting for the message-thread timer (~30 Hz).
    bool tryPromotePrecached(size_t songIndex);

    // True when a precache for `songIndex` is ready to promote.
    bool hasPrecacheFor(size_t songIndex) const;

    // Audio-thread-only. Never allocates (atomic refcount op).
    ActiveSongHandle acquireActiveSong();

    // Serializes ProjectLoader zip access with the I/O thread (peak overview,
    // extractFile, etc. must not race StreamCursor refill).
    template <typename Fn>
    void withProjectLoaderLock(Fn&& fn) {
        std::lock_guard<std::mutex> lock(projectLoaderMutex);
        std::forward<Fn>(fn)();
    }

private:
    void ioThreadLoop();

    const ProjectLoader* projectLoader = nullptr;
    std::thread ioThread;
    std::atomic<bool> running{false};
    std::function<void()> ioThreadStartHook;
    std::function<void()> ioThreadStopHook;

    std::mutex projectLoaderMutex; // serializes StreamCursor-opening/reading across threads

    std::shared_ptr<StagedSong> active; // accessed via std::atomic_load/store

    mutable std::mutex precacheMutex;
    std::unique_ptr<StagedSong> precached;
};

} // namespace resoset
