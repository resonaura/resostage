#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace resostage {

/**
 * Fractional-position resampling for varispeed and reverse playback.
 *
 * The shaped playback path reads a region's source at a non-integer rate --
 * that is what a speed of 1.5 or a reversed loop IS -- so every output sample
 * falls between two source frames and something has to decide what is there.
 *
 * Linear interpolation, which this replaces, decides badly. Its response is a
 * sinc-squared curve: it rolls the top octave off (about -4 dB at Nyquist/2,
 * and far worse near Nyquist) and it does not reject the images that
 * resampling creates, so those fold back as aliasing. On a drum loop at 1.5x
 * that is heard as a dull top end with a metallic edge -- present, quiet, and
 * very hard to attribute to anything, because nothing about it looks wrong.
 *
 * A windowed sinc is the interpolator that band-limited sampling theory
 * actually asks for. It is stored as a POLYPHASE table: the kernel is
 * evaluated once at load for a fixed set of sub-sample phases, so playback is
 * a dot product over precomputed weights rather than transcendental maths per
 * sample. That is what makes it affordable on the audio thread.
 *
 * Speeding up needs one more thing. Reading the source faster than the output
 * rate moves content above Nyquist, and no interpolator can put that back once
 * it has folded. So above 1x the kernel is STRETCHED by the speed ratio, which
 * lowers its cutoff to the output's Nyquist and filters the offending content
 * out before it aliases, rather than after.
 */

/** Taps per side; the kernel spans 2 * kSincHalfTaps source frames. */
inline constexpr int kSincHalfTaps = 16;
/** Sub-sample phases the kernel is precomputed at. */
inline constexpr int kSincPhases = 512;

/**
 * A polyphase windowed-sinc kernel, built once for a given speed.
 *
 * Not built per block: the table is a few hundred kilobytes of transcendental
 * evaluation, which is a message-thread cost, not an audio-thread one. The
 * engine keeps one per distinct speed and looks it up by ratio.
 */
class SincTable {
public:
    /**
     * `speedRatio` is source frames consumed per output frame. Above 1 the
     * kernel is widened to band-limit; at or below 1 it is the plain
     * interpolating kernel, because slowing down creates no images to reject.
     */
    void build(double speedRatio);

    /** The ratio this table was built for; 0 until built. */
    double ratio() const { return builtRatio; }
    bool isBuilt() const { return builtRatio > 0.0; }

    /**
     * Weights for a phase in [0, 1), as 2 * kSincHalfTaps contiguous floats
     * aligned so index 0 multiplies source frame `floor(pos) - kSincHalfTaps + 1`.
     */
    const float* weightsForPhase(double phase) const;

    static constexpr int taps() { return kSincHalfTaps * 2; }

private:
    // kSincPhases + 1 rows so a phase of exactly 1.0 (rounding) has a row and
    // does not index past the end.
    std::vector<float> table;
    double builtRatio = 0.0;
};

/**
 * The ladder of kernels the engine plays through.
 *
 * A table costs a few hundred thousand transcendental evaluations to build,
 * which is fine once and impossible on the audio thread -- and speed is a
 * continuous parameter the operator DRAGS, so building on demand is exactly
 * the wrong shape. Instead a fixed ladder is built up front and a block picks
 * the nearest kernel at or above its speed.
 *
 * Rounding UP matters: the chosen kernel's cutoff is then at or below what the
 * speed requires, so the worst case is very slightly more filtering than
 * strictly needed. Rounding down would leave images unrejected, which is the
 * artefact this whole file exists to remove.
 */
class SincTableSet {
public:
    /** Builds every kernel. Message thread only. */
    void build();
    bool isBuilt() const { return !tables.empty(); }

    /** Nearest kernel at or above `speed`; unity for anything at or below 1. */
    const SincTable& forSpeed(double speed) const;

    size_t size() const { return tables.size(); }

private:
    std::vector<SincTable> tables;
};

/**
 * One output sample from a resident (fully in-RAM) source.
 *
 * `source` is a plain array of `length` frames; positions outside it read as
 * silence, which is what a region's edges should sound like. `position` is the
 * fractional source frame.
 *
 * Real-time safe: no allocation, no branching on anything but bounds.
 */
float sincSample(const SincTable& table, const float* source, int64_t length, double position);

/**
 * One output sample from weights already chosen for its phase.
 *
 * Split out because the phase -- and therefore the kernel row -- depends only
 * on WHERE in the source we are, not on which channel we are reading. A
 * stereo region resolved that twice per sample; resolving it once per block
 * and passing the answer in leaves this loop as pure multiply-accumulate,
 * which is also the shape a compiler can vectorise.
 *
 * `base` is the first source frame the kernel touches, i.e.
 * floor(position) - kSincHalfTaps + 1.
 */
float sincSampleAt(const float* weights, const float* source, int64_t length, int64_t base);

/** The wrapping form of the above, for a looping region. */
float sincSampleAtLooped(const float* weights, const float* source, int64_t length, int64_t base);

/**
 * The kernel row and starting frame for a source position.
 *
 * Returns false when there is nothing to read (a position outside the region);
 * callers leave those samples as the silence the scratch already holds.
 */
bool sincLookup(const SincTable& table, double position, const float*& weightsOut,
                int64_t& baseOut);

/**
 * The same, for a source that wraps -- a looping region.
 *
 * Taps that fall past either end of [0, length) come from the other end, so
 * the kernel never reads silence across a loop point. Without this a loop
 * seam gets a sixteen-sample dip on every cycle, which is a click.
 */
float sincSampleLooped(const SincTable& table, const float* source, int64_t length, double position);

} // namespace resostage
