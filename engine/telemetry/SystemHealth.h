#pragma once

#include <atomic>
#include <cstdint>

namespace resoset {

// Lightweight process/system health snapshot for the on-stage "task manager"
// panel (native UI + web remote). Updated from the message thread / a slow
// background poll -- never from the audio callback.
//
// Audio-thread-safe counters (underruns) are separate atomics written by the
// audio path and only *read* here when composing a snapshot.
struct SystemHealthSnapshot {
    double processCpuPercent = 0.0; // 0..100+ (can exceed 100 on multi-core)
    uint64_t processRssBytes = 0;
    uint64_t systemFreeBytes = 0;
    uint64_t systemTotalBytes = 0;
    uint64_t underrunCount = 0;
    uint64_t audioCallbackCount = 0;
    int webClientCount = 0;
};

// Collects macOS process RSS / free RAM and exposes the audio underrun
// counters that AudioEngine increments when a driver stall is detected.
class SystemHealth {
public:
    SystemHealth() = default;

    // Safe from the audio thread (atomic increments only).
    void noteAudioCallback() { audioCallbackCount.fetch_add(1, std::memory_order_relaxed); }
    void noteUnderrun() { underrunCount.fetch_add(1, std::memory_order_relaxed); }

    void setWebClientCount(int count) { webClientCount.store(count, std::memory_order_relaxed); }

    // Message-thread / web-thread: samples process + system memory and folds
    // in the atomic counters. May take a few syscalls -- not for audio RT.
    SystemHealthSnapshot sample() const;

private:
    std::atomic<uint64_t> underrunCount{0};
    std::atomic<uint64_t> audioCallbackCount{0};
    std::atomic<int> webClientCount{0};

    // CPU estimation state (message-thread sample() only).
    mutable uint64_t lastCpuNanos = 0;
    mutable uint64_t lastWallNanos = 0;
    mutable SystemHealthSnapshot cachedSnapshot{};
};

} // namespace resoset
