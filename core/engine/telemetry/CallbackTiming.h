#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace resostage {

/**
 * How long the render callback took, and -- the part that matters -- why.
 *
 * A dropout on stage is close to impossible to diagnose after the fact. The
 * driver's own underrun counter stays at zero whenever we were serviced on
 * time and simply had nothing to give (we count those separately as silent
 * blocks), and process CPU averaged over a second says nothing about the one
 * callback in ten thousand that ran long. By the time anyone looks, the
 * evidence is gone.
 *
 * The measurement that survives is the ratio of two clocks:
 *
 *   - WALL time: how long the callback actually took, start to finish.
 *   - CPU time: how much of that this thread was actually running on a core.
 *
 * Their gap is the whole diagnosis. A callback that took 4 ms of wall time and
 * 3.9 ms of CPU was doing too much work -- too many stems, too much DSP, or a
 * clock that has been throttled down. A callback that took 4 ms of wall and
 * 0.3 ms of CPU was not doing anything at all: it was waiting. Waiting on a
 * lock, on the disk, or on a scheduler that gave the core to something else.
 *
 * Those two need completely different fixes, and without this they look
 * identical from the outside -- which is exactly the position we were in with
 * "low CPU, no underruns, audio breaking up anyway".
 *
 * Everything here is free of platform headers and of JUCE so it can be tested
 * against known numbers. The platform supplies the two clocks; see
 * app/platform/ThreadTime.h.
 */

/** What a long callback was actually doing. */
enum class CallbackStall {
    /** Comfortably inside its deadline. */
    None,
    /** Burned the time on a core: too much work, or a throttled clock. */
    Compute,
    /** Barely ran: waited on a lock, on I/O, or for a core at all. */
    Preempted,
};

/**
 * Fraction of the deadline past which a callback is worth recording.
 *
 * Not 1.0: by the time a callback overruns its deadline the damage is already
 * audible. 0.75 catches the approach, which is what tells you a rig is on the
 * edge before a show rather than after one.
 */
inline constexpr double kCallbackStallRatio = 0.75;

/**
 * Below this share of wall time spent running, a slow callback was waiting
 * rather than working.
 *
 * Deliberately low. Anything between the two is genuinely ambiguous -- a
 * callback can both compute a lot and get preempted -- and calling an
 * ambiguous case "compute" is the safer error: it points at our own DSP, which
 * we can measure further, rather than at the OS, which we cannot.
 */
inline constexpr double kPreemptedCpuShare = 0.5;

/**
 * Classify one callback.
 *
 * `deadlineMs` is the wall-clock budget: the block's duration at the device
 * sample rate. A callback has exactly that long before the driver needs the
 * next block.
 */
inline CallbackStall classifyCallback(double wallMs, double cpuMs, double deadlineMs) {
    if (!(deadlineMs > 0.0) || !(wallMs > 0.0))
        return CallbackStall::None;
    if (wallMs < deadlineMs * kCallbackStallRatio)
        return CallbackStall::None;
    // A platform that cannot report thread CPU time reports 0; treat that as
    // "unknown", which under the rule above means Compute rather than a
    // fabricated preemption.
    if (cpuMs <= 0.0)
        return CallbackStall::Compute;
    return (cpuMs / wallMs) < kPreemptedCpuShare ? CallbackStall::Preempted
                                                 : CallbackStall::Compute;
}

/**
 * Where a callback's wall time landed relative to its deadline.
 *
 * Averages are useless here: a rig that averages 30% of its deadline and
 * touches 105% twice an hour sounds broken, and a rig that sits at 70% for
 * ever sounds perfect. Only the tail is worth keeping, so the buckets get
 * finer as they approach the deadline.
 */
enum class CallbackBucket : size_t {
    UpTo25 = 0,
    UpTo50,
    UpTo75,
    UpTo90,
    UpTo100,
    Over100,
    Count,
};

inline constexpr size_t kCallbackBucketCount = static_cast<size_t>(CallbackBucket::Count);

inline CallbackBucket callbackBucketFor(double wallMs, double deadlineMs) {
    if (!(deadlineMs > 0.0))
        return CallbackBucket::UpTo25;
    const double r = wallMs / deadlineMs;
    if (r <= 0.25) return CallbackBucket::UpTo25;
    if (r <= 0.50) return CallbackBucket::UpTo50;
    if (r <= 0.75) return CallbackBucket::UpTo75;
    if (r <= 0.90) return CallbackBucket::UpTo90;
    if (r <= 1.00) return CallbackBucket::UpTo100;
    return CallbackBucket::Over100;
}

/** A read of the histogram, for the health panel and for a bug report. */
struct CallbackTimingSnapshot {
    std::array<uint64_t, kCallbackBucketCount> buckets{};
    uint64_t total = 0;
    /** Slow callbacks split by what they were doing. */
    uint64_t computeStalls = 0;
    uint64_t preemptedStalls = 0;
    /** Worst wall/deadline ratio seen, and the CPU share of that callback. */
    double worstRatio = 0.0;
    double worstCpuShare = 0.0;
    /** Wall ms of the worst callback, for a number a human can read. */
    double worstWallMs = 0.0;
};

/**
 * Lock-free histogram written from the audio thread.
 *
 * Every operation is a relaxed atomic add or a compare-exchange on a value
 * nobody blocks on, so recording a callback costs a handful of instructions
 * and never waits. The worst-case tracking is a CAS loop that gives up
 * naturally under contention -- there is only one writer, so it does not spin.
 */
class CallbackTimingHistogram {
public:
    /** Audio thread. Real-time safe. */
    void record(double wallMs, double cpuMs, double deadlineMs) {
        if (!(deadlineMs > 0.0) || !(wallMs >= 0.0))
            return;

        const size_t bucket = static_cast<size_t>(callbackBucketFor(wallMs, deadlineMs));
        counts[bucket].fetch_add(1, std::memory_order_relaxed);
        totalCount.fetch_add(1, std::memory_order_relaxed);

        switch (classifyCallback(wallMs, cpuMs, deadlineMs)) {
            case CallbackStall::Compute:
                compute.fetch_add(1, std::memory_order_relaxed);
                break;
            case CallbackStall::Preempted:
                preempted.fetch_add(1, std::memory_order_relaxed);
                break;
            case CallbackStall::None:
                break;
        }

        const double ratio = wallMs / deadlineMs;
        double seen = worst.load(std::memory_order_relaxed);
        while (ratio > seen
               && !worst.compare_exchange_weak(seen, ratio, std::memory_order_relaxed,
                                               std::memory_order_relaxed)) {
            // seen refreshed by the failed exchange
        }
        // Only meaningful alongside the ratio above; a torn pair here would
        // mislabel one line of a diagnostic, which is worth far less than
        // keeping this branch free of anything that could block.
        if (ratio >= worst.load(std::memory_order_relaxed)) {
            worstWall.store(wallMs, std::memory_order_relaxed);
            worstShare.store(wallMs > 0.0 ? cpuMs / wallMs : 0.0, std::memory_order_relaxed);
        }
    }

    CallbackTimingSnapshot snapshot() const {
        CallbackTimingSnapshot s;
        for (size_t i = 0; i < kCallbackBucketCount; ++i)
            s.buckets[i] = counts[i].load(std::memory_order_relaxed);
        s.total = totalCount.load(std::memory_order_relaxed);
        s.computeStalls = compute.load(std::memory_order_relaxed);
        s.preemptedStalls = preempted.load(std::memory_order_relaxed);
        s.worstRatio = worst.load(std::memory_order_relaxed);
        s.worstCpuShare = worstShare.load(std::memory_order_relaxed);
        s.worstWallMs = worstWall.load(std::memory_order_relaxed);
        return s;
    }

    /**
     * Start a fresh window.
     *
     * The worst case is the whole point of the histogram, so this exists for
     * deliberate boundaries -- opening a project, changing device -- where
     * carrying the previous rig's worst case forward would be a lie.
     */
    void reset() {
        for (auto& c : counts)
            c.store(0, std::memory_order_relaxed);
        totalCount.store(0, std::memory_order_relaxed);
        compute.store(0, std::memory_order_relaxed);
        preempted.store(0, std::memory_order_relaxed);
        worst.store(0.0, std::memory_order_relaxed);
        worstShare.store(0.0, std::memory_order_relaxed);
        worstWall.store(0.0, std::memory_order_relaxed);
    }

private:
    std::array<std::atomic<uint64_t>, kCallbackBucketCount> counts{};
    std::atomic<uint64_t> totalCount{0};
    std::atomic<uint64_t> compute{0};
    std::atomic<uint64_t> preempted{0};
    std::atomic<double> worst{0.0};
    std::atomic<double> worstShare{0.0};
    std::atomic<double> worstWall{0.0};
};

} // namespace resostage
