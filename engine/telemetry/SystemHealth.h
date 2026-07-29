#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace resostage {

// Per-process resource entry.
struct ProcessHealthEntry {
    int pid = 0;
    std::string name;
    uint64_t rssBytes = 0;
    double cpuPercent = 0.0;
};

// Lightweight process/system health snapshot for the on-stage "task manager"
// panel (native UI + web remote). Updated from the message thread / a slow
// background poll -- never from the audio callback.
//
// Audio-thread-safe counters (underruns) are separate atomics written by the
// audio path and only *read* here when composing a snapshot.
struct SystemHealthSnapshot {
    // Combined totals across all app-related processes.
    double totalCpuPercent = 0.0;
    uint64_t totalRssBytes = 0;
    // Per-process breakdown (main process + children).
    std::vector<ProcessHealthEntry> processes;
    // System-wide memory.
    uint64_t systemFreeBytes = 0;
    uint64_t systemTotalBytes = 0;
    // Audio-thread counters.
    uint64_t underrunCount = 0;
    uint64_t audioCallbackCount = 0;
    int webClientCount = 0;
};

// Collects macOS process RSS / free RAM and exposes the audio underrun
// counters that AudioEngine increments when a driver stall is detected.
// Automatically discovers child processes of the main PID and sums their
// resource usage for a unified "app total".
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
    // PIDs of child processes discovered at startup / periodically refreshed.
    mutable std::vector<int> childPids;
    mutable uint64_t lastChildRefreshNanos = 0;
    // Per-PID previous CPU time for accurate delta calculation.
    mutable std::unordered_map<int, uint64_t> prevCpuByPid;
};

} // namespace resostage
