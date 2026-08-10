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
    uint32_t cpuCoreCount = 1;
    // Audio-thread counters.
    uint64_t underrunCount = 0;
    uint64_t audioCallbackCount = 0;
    // Blocks the transport was playing for but that reached the outputs as
    // silence, because the render callback bailed out early -- see
    // noteSilentBlock(). Distinct from underrunCount: the driver called us on
    // time and we had nothing to give it, which is inaudible as a "dropout"
    // in any driver statistic but is exactly what a listener hears as a
    // crackle.
    uint64_t silentBlockCount = 0;
    // Blocks the region transposer actually ran on.
    //
    // Transposition is invisible to every other number here: it preserves
    // level, it is not a dropout, and one region's worth of phase vocoder
    // disappears into process CPU. Without this, the only way to answer "is
    // transpose doing anything at all" is to listen -- which cannot be
    // checked in a log, a bug report or a test.
    uint64_t pitchBlockCount = 0;
    int webClientCount = 0;
    // Disk throughput this app is causing, averaged over the sample interval.
    //
    // Here because a saturated or thermally throttled SSD stalls everything --
    // stem streaming first, and once the streams starve the render callback
    // has nothing to hand the driver. CPU and RAM look fine the whole time,
    // so a health panel that watches only those reports a healthy machine
    // while the audio breaks up. Cumulative byte counters come free from the
    // same proc_pid_rusage call the CPU numbers already use.
    double diskReadBytesPerSec = 0.0;
    double diskWriteBytesPerSec = 0.0;
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
    // Called when the render callback returns while the transport is playing
    // without having written anything -- the block leaves as silence. The
    // driver never notices (it was serviced on time), so this is invisible to
    // underrunCount, yet a handful of these per second is the "хрип" a
    // listener reports while a fader is being dragged.
    void noteSilentBlock() { silentBlockCount.fetch_add(1, std::memory_order_relaxed); }
    /** One block pushed through a region's transposer. See pitchBlockCount. */
    void notePitchBlock() { pitchBlockCount.fetch_add(1, std::memory_order_relaxed); }

    void setWebClientCount(int count) { webClientCount.store(count, std::memory_order_relaxed); }

    // Message-thread / web-thread: samples process + system memory and folds
    // in the atomic counters. May take a few syscalls -- not for audio RT.
    SystemHealthSnapshot sample() const;

private:
    std::atomic<uint64_t> underrunCount{0};
    std::atomic<uint64_t> audioCallbackCount{0};
    std::atomic<uint64_t> silentBlockCount{0};
    std::atomic<uint64_t> pitchBlockCount{0};
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
    // Previous cumulative disk I/O, for the same per-interval delta.
    mutable uint64_t prevDiskReadBytes = 0;
    mutable uint64_t prevDiskWriteBytes = 0;
};

} // namespace resostage
