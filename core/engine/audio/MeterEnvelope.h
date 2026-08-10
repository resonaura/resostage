#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace resostage {

/**
 * Meter values sampled far more often than the audio callback runs.
 *
 * A meter is normally published as one number per callback: the peak of that
 * block. That works while the callback is the faster of the two clocks. At a
 * large buffer it is not -- 4096 frames is one callback every 85ms against a
 * UI polling three times as often -- and one number cannot describe what
 * happened inside those 85ms. A transient and a steady tone of the same peak
 * arrive identical, every poll that lands between callbacks has nothing to
 * report, and the needle either freezes or falls to the floor.
 *
 * So the engine walks the block in short sub-blocks, runs the ballistics on
 * each, and publishes the resulting TRAJECTORY. The display then replays that
 * trajectory at its own rate instead of interpolating between two lonely
 * samples. The cost is one atomic store per sub-block per meter.
 *
 * Everything here is deliberately free of JUCE and of the audio device, so
 * the ballistics can be tested against known signals rather than by ear.
 */

/**
 * One point on the trajectory. Plain data: it crosses a lock-free ring.
 *
 * Per channel, because the needles are per channel -- collapsing to one number
 * here would put the same reading on both sides of a hard-panned strip. A mono
 * source reports the same value twice, which is what the meters already do.
 */
struct MeterEnvelopePoint {
    /** Sample peak of this sub-block, linear. */
    float peakL = 0.0f;
    float peakR = 0.0f;
    /** Peak-programme-meter reading after this sub-block, linear. */
    float ppmL = 0.0f;
    float ppmR = 0.0f;
    /** RMS over this sub-block across channels, linear. */
    float rms = 0.0f;

    /**
     * Louder side. Valid as the mono reading of the PPM too, not just of the
     * peak: both channels release at the same rate, so the filter of the max
     * is the max of the filters.
     */
    float peak() const { return peakL > peakR ? peakL : peakR; }
    float ppm() const { return ppmL > ppmR ? ppmL : ppmR; }
};

/**
 * Sub-block length, in samples.
 *
 * 64 at 48kHz is 1.33ms -- finer than any needle can show and finer than any
 * ballistic constant here, so the trajectory is limited by the ballistics
 * rather than by the sampling of them. It also divides every buffer size a
 * device offers, so no sub-block is ever a ragged remainder.
 */
inline constexpr int kMeterSubBlock = 64;

/**
 * Peak-programme ballistics, IEC 60268-10 in shape.
 *
 * Attack is instant on purpose: a digital peak meter must never under-read,
 * and the sub-block IS the integration window. The release is the part that
 * makes a needle readable -- a fall of 20dB in 1.7s, which is the standard's
 * Type II figure and close enough to what an engineer expects that nobody
 * looks twice.
 */
class PpmBallistics {
public:
    static constexpr double kReleaseDbPerSecond = 20.0 / 1.7;

    void prepare(double sampleRate);
    /** Feed one sub-block's peak; returns the new needle value (linear). */
    float process(float blockPeak, int numSamples);
    void reset() { current = 0.0f; }
    float value() const { return current; }

private:
    float current = 0.0f;
    /** Multiplier applied per sample of release. */
    double releasePerSample = 1.0;
};

/**
 * Turns a block of audio into a trajectory of envelope points.
 *
 * Stateful across calls -- the ballistics are a filter, and resetting them at
 * every block boundary is exactly the discontinuity this exists to remove.
 */
class MeterEnvelopeTracker {
public:
    void prepare(double sampleRate);
    void reset();

    /**
     * Walk `numSamples` of interleaved-by-channel-pointer audio in sub-blocks,
     * emitting one point per sub-block.
     *
     * `emit` is called with each point in order. It must not allocate or block
     * -- this runs on the audio thread; in production it pushes into
     * MeterEnvelopeRing.
     */
    template <typename EmitFn>
    void process(const float* const* channels, int numChannels, int numSamples, EmitFn&& emit) {
        if (channels == nullptr || numChannels <= 0 || numSamples <= 0)
            return;
        for (int start = 0; start < numSamples; start += kMeterSubBlock) {
            const int len = (numSamples - start) < kMeterSubBlock ? (numSamples - start)
                                                                  : kMeterSubBlock;
            emit(measure(channels, numChannels, start, len));
        }
    }

    /** One sub-block, exposed for tests and for callers doing their own loop. */
    MeterEnvelopePoint measure(const float* const* channels, int numChannels, int start, int len);

private:
    PpmBallistics ppmL;
    PpmBallistics ppmR;
};

/**
 * Single-producer single-consumer ring of envelope points.
 *
 * The audio thread pushes, the UI drains whatever accumulated since its last
 * frame. Overflow drops the OLDEST point rather than refusing the newest: a
 * display that has fallen behind wants the recent past, not a stall from
 * whenever it stopped reading.
 *
 * Capacity is a power of two so the wrap is a mask.
 */
template <size_t Capacity>
class MeterEnvelopeRing {
public:
    static_assert((Capacity & (Capacity - 1)) == 0, "Capacity must be a power of two");

    void push(const MeterEnvelopePoint& point) {
        const size_t w = write.load(std::memory_order_relaxed);
        buffer[w & (Capacity - 1)] = point;
        // Release: the point must be visible before the index that publishes it.
        write.store(w + 1, std::memory_order_release);
    }

    /** Copies up to `max` points out; returns how many. Oldest first. */
    size_t drain(MeterEnvelopePoint* out, size_t max) {
        const size_t w = write.load(std::memory_order_acquire);
        size_t r = read.load(std::memory_order_relaxed);
        // Anything older than the ring's span is gone -- skip straight to what
        // is still there rather than reporting stale points as new.
        if (w - r > Capacity)
            r = w - Capacity;
        size_t n = 0;
        while (r != w && n < max)
            out[n++] = buffer[r++ & (Capacity - 1)];
        read.store(r, std::memory_order_relaxed);
        return n;
    }

    /** Points waiting, capped at the ring's span. */
    size_t available() const {
        const size_t pending =
            write.load(std::memory_order_acquire) - read.load(std::memory_order_relaxed);
        return pending > Capacity ? Capacity : pending;
    }

    void clear() {
        read.store(write.load(std::memory_order_acquire), std::memory_order_relaxed);
    }

private:
    std::array<MeterEnvelopePoint, Capacity> buffer{};
    std::atomic<size_t> write{0};
    std::atomic<size_t> read{0};
};

} // namespace resostage
