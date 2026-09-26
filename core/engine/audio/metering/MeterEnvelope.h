#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace resostage {

/**
 * Meter peaks sampled far more often than the audio callback runs.
 *
 * A meter is normally published as one number per callback: the peak of that
 * block. That works while the callback is the faster of the two clocks. At a
 * large buffer it is not -- 4096 frames is one callback every 85ms against a
 * UI polling three times as often -- so most polls found nothing at all and
 * reported the floor, and the needle slammed down twelve times a second on
 * steady audio.
 *
 * The fix is a SAMPLING one, and only a sampling one. The engine walks each
 * block in short sub-blocks, measures the true peak of each, and hands them
 * over through a lock-free ring. A poll takes the loudest of everything that
 * arrived since it last asked, which is an honest interval peak whatever the
 * buffer size; a poll that lands between callbacks takes nothing and the
 * previous reading stands, because no measurement happened -- not because
 * anything decided the level had changed.
 *
 * Deliberately no ballistics here. This used to run a PPM release on the audio
 * thread, and it was a mistake: its fall was slower than the display's, so it
 * quietly took over the decay and made the display's own ballistics a no-op.
 * Muting the only track feeding a bus then left the needle gliding down for
 * seconds after the audio was genuinely, measurably gone. Deciding how a
 * needle falls is a question about what is readable, which belongs where the
 * needle is drawn; the engine's job is to say what the signal actually did.
 *
 * Everything here is free of JUCE and of the audio device, so the measurement
 * can be tested against known signals rather than by ear.
 */

/** One sub-block's measurement. Plain data: it crosses a lock-free ring. */
struct MeterEnvelopePoint {
    /**
     * Sample peak of this sub-block, linear, per channel.
     *
     * Per channel because the needles are per channel -- one number would put
     * the same reading on both sides of a hard-panned strip. A mono source
     * reports the same value twice, which is what the meters already do.
     */
    float peakL = 0.0f;
    float peakR = 0.0f;

    /** Louder side, for a single-bar meter or a mono readout. */
    float peak() const { return peakL > peakR ? peakL : peakR; }
};

/**
 * Sub-block length, in samples.
 *
 * 64 at 48kHz is 1.33ms -- far finer than any display refresh, so what the UI
 * sees is limited by how often it asks rather than by how coarsely we
 * measured. It also divides every buffer size a device offers, so no sub-block
 * is ever a ragged remainder.
 */
inline constexpr int kMeterSubBlock = 64;

/**
 * Walk a block in sub-blocks, emitting the peak of each.
 *
 * `emit` is called with each point in order. It must not allocate or block --
 * this runs on the audio thread; in production it pushes into
 * MeterEnvelopeRing.
 *
 * Stateless on purpose. There is nothing to carry between blocks now that the
 * ballistics are gone, which means no per-bus tracker to size, prepare on a
 * sample-rate change, or reset on stop -- and no state to get out of step with
 * the audio.
 */
template <typename EmitFn>
void measureSubBlockPeaks(const float* const* channels, int numChannels, int numSamples,
                          EmitFn&& emit) {
    if (channels == nullptr || numChannels <= 0 || numSamples <= 0)
        return;

    const float* left = channels[0];
    // Channel 1 if there is one, otherwise left again -- a mono strip drives
    // both needles rather than leaving one dead.
    const float* right = (numChannels > 1 && channels[1] != nullptr) ? channels[1] : left;
    if (left == nullptr)
        return;

    for (int start = 0; start < numSamples; start += kMeterSubBlock) {
        const int end = (numSamples - start) < kMeterSubBlock ? numSamples : start + kMeterSubBlock;

        float peakL = 0.0f;
        float peakR = 0.0f;
        for (int i = start; i < end; ++i) {
            const float l = left[i] < 0.0f ? -left[i] : left[i];
            const float r = right[i] < 0.0f ? -right[i] : right[i];
            if (l > peakL) peakL = l;
            if (r > peakR) peakR = r;
        }

        emit(MeterEnvelopePoint{peakL, peakR});
    }
}

/**
 * Single-producer single-consumer ring of measurements.
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

    /**
     * Producer side: drop anything queued but not yet drained.
     *
     * For the moment the engine stops producing audio. The consumer clears the
     * ring too, on Stop, but it cannot win the race against a block already in
     * flight -- that block's points land after the clear, and since a drain
     * reports the LOUDEST of what it finds, one late block was enough to park
     * a meter at a playing level for good.
     *
     * Ordering makes it safe: there is one producer, so its own discard is
     * strictly after its own last block. It moves a mark forward rather than
     * touching the consumer's read index, so neither side writes the other's
     * state.
     */
    void discardQueued() {
        discardBefore.store(write.load(std::memory_order_relaxed), std::memory_order_release);
    }

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
        // Anything the producer disowned is not a measurement any more.
        const size_t discarded = discardBefore.load(std::memory_order_acquire);
        if (r < discarded)
            r = discarded;
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
    std::atomic<size_t> discardBefore{0};
};

} // namespace resostage
