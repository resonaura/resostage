#pragma once

#include <algorithm>

namespace resostage {

/**
 * What the disk should be doing, decided from how full the playing song's
 * rings are.
 *
 * The engine has two things competing for one SSD: the refill workers, which
 * are feeding audio that is coming out of the speakers in the next few
 * hundred milliseconds, and the resident promoter, which pulls whole regions
 * into RAM so that LATER playback is free. The second is pure optimisation.
 * It is also, by far, the bigger reader -- a resident load is a whole stem in
 * one go, while a refill is a few thousand frames.
 *
 * On an idle machine that never matters. On a loaded one, or a slow disk, the
 * promoter's bulk read sits in front of the refills in the device queue and
 * the rings run down behind it. The symptom is the one that is hardest to
 * diagnose: low CPU, no underruns reported by the driver, and audio breaking
 * up anyway -- because the render callback was serviced on time and simply had
 * nothing to hand over.
 *
 * So the promoter yields. Not by being polite in general (it already runs at a
 * lower priority, and that was not enough), but by watching the same number
 * the refill workers watch and getting out of the way when it drops.
 *
 * The thresholds are expressed against the ring's own capacity, so they mean
 * the same thing at every buffer size and sample rate.
 */
enum class IoPressureLevel {
    /** Rings comfortably full. Everything may read. */
    Healthy,
    /** Draining. Do not START new bulk reads; one already going may finish. */
    Tight,
    /** Nearly empty. Abandon bulk reads in flight; refill gets the disk. */
    Critical,
};

/** Below this fraction of ring capacity, stop starting resident loads. */
inline constexpr double kIoTightFraction = 0.30;
/** Below this, abandon whatever bulk read is in flight. */
inline constexpr double kIoCriticalFraction = 0.10;

/**
 * `minRingFraction` is the emptiest non-resident ring in the playing song, as
 * a fraction of its capacity. A song entirely in RAM has no ring to run down,
 * and reports 1.0.
 */
inline IoPressureLevel ioPressureFor(double minRingFraction) {
    if (!(minRingFraction >= 0.0)) // NaN, or a negative that means "unknown"
        return IoPressureLevel::Healthy;
    if (minRingFraction < kIoCriticalFraction)
        return IoPressureLevel::Critical;
    if (minRingFraction < kIoTightFraction)
        return IoPressureLevel::Tight;
    return IoPressureLevel::Healthy;
}

/**
 * Whether the resident promoter may begin a new bulk read.
 *
 * Deliberately checked before starting rather than only while running: a load
 * that should not have begun still costs a full stem's worth of disk before
 * anyone can abort it.
 */
inline bool residentPromoterMayStart(IoPressureLevel level) {
    return level == IoPressureLevel::Healthy;
}

/**
 * Whether a bulk read already in flight should give up.
 *
 * Only at Critical, because abandoning one throws away everything it has read
 * so far -- worth it to save the audio, wasteful if the rings were merely
 * dipping. The partial result is discarded rather than published: a
 * half-resident region would read silence past its end.
 */
inline bool residentLoadShouldAbort(IoPressureLevel level) {
    return level == IoPressureLevel::Critical;
}

/**
 * How many refill chunks a single buffer may take in one pass.
 *
 * Fewer, larger visits to a busy disk beat many small ones: each `refill()` is
 * a read syscall against a device whose queue is the contended resource, so
 * under pressure the worker stays on one buffer and drains its backlog instead
 * of round-robining a chunk at a time.
 */
inline int refillBurstFor(IoPressureLevel level, int healthyBurst) {
    const int base = std::max(1, healthyBurst);
    switch (level) {
        case IoPressureLevel::Critical:
            return base * 4;
        case IoPressureLevel::Tight:
            return base * 2;
        case IoPressureLevel::Healthy:
            break;
    }
    return base;
}

} // namespace resostage
