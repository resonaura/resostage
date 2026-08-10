#include "SincInterpolator.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iterator>

namespace resostage {

namespace {

/**
 * Zeroth-order modified Bessel function, for the Kaiser window.
 *
 * Series form rather than a table: this runs a few thousand times at build,
 * never during playback, and the series converges in well under thirty terms
 * for the arguments a Kaiser beta produces.
 */
double besselI0(double x) {
    double sum = 1.0;
    double term = 1.0;
    const double halfX = x * 0.5;
    for (int k = 1; k < 64; ++k) {
        term *= (halfX / k) * (halfX / k);
        sum += term;
        if (term < sum * 1e-16)
            break;
    }
    return sum;
}

/**
 * Kaiser beta.
 *
 * 8.6 puts the stopband around -90 dB, which is below the noise floor of any
 * 24-bit source and well below what a stage rig will reproduce. Higher betas
 * buy rejection nobody can hear at the cost of a wider transition band -- i.e.
 * they trade audible top end for inaudible cleanliness, which is backwards.
 */
constexpr double kKaiserBeta = 8.6;

double sinc(double x) {
    if (std::abs(x) < 1e-9)
        return 1.0;
    const double pix = 3.14159265358979323846 * x;
    return std::sin(pix) / pix;
}

} // namespace

void SincTable::build(double speedRatio) {
    const double ratio = speedRatio > 0.0 && std::isfinite(speedRatio) ? speedRatio : 1.0;
    // Only speeding up folds content back. Slowing down just spreads the
    // spectrum out, so the kernel stays at full width and keeps the top end.
    const double cutoff = ratio > 1.0 ? 1.0 / ratio : 1.0;
    const int n = taps();

    table.assign(static_cast<size_t>(kSincPhases + 1) * static_cast<size_t>(n), 0.0f);
    const double i0Beta = besselI0(kKaiserBeta);

    for (int p = 0; p <= kSincPhases; ++p) {
        const double phase = static_cast<double>(p) / static_cast<double>(kSincPhases);
        float* row = table.data() + static_cast<size_t>(p) * static_cast<size_t>(n);

        double sum = 0.0;
        for (int t = 0; t < n; ++t) {
            // Distance from the output position to this tap's source frame.
            const double x = static_cast<double>(t - kSincHalfTaps + 1) - phase;

            // Kaiser window over the kernel's own span, so the taper reaches
            // zero at the edges however wide the cutoff made the kernel.
            const double w = x / static_cast<double>(kSincHalfTaps);
            const double windowArg = 1.0 - w * w;
            const double window =
                windowArg > 0.0
                    ? besselI0(kKaiserBeta * std::sqrt(windowArg)) / i0Beta
                    : 0.0;

            const double h = cutoff * sinc(cutoff * x) * window;
            row[t] = static_cast<float>(h);
            sum += h;
        }

        // Normalise each phase to unity DC gain. Without this the kernel's
        // gain ripples with phase, which on a sustained tone is heard as a
        // slow tremolo at the beat frequency between the speed and the sample
        // rate -- a very odd-sounding artefact for something that is meant to
        // be a straight speed change.
        if (sum > 1e-12) {
            const float norm = static_cast<float>(1.0 / sum);
            for (int t = 0; t < n; ++t)
                row[t] *= norm;
        }
    }

    builtRatio = ratio;
}

void SincTableSet::build() {
    // Covers MIN_REGION_SPEED..MAX_REGION_SPEED (0.25..4 -- see the timeline's
    // regionDrag.ts). Everything at or below 1x shares the unity kernel,
    // because slowing down creates nothing that needs filtering out.
    static constexpr double kRatios[] = {1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0};
    tables.clear();
    tables.resize(std::size(kRatios));
    for (size_t i = 0; i < std::size(kRatios); ++i)
        tables[i].build(kRatios[i]);
}

const SincTable& SincTableSet::forSpeed(double speed) const {
    for (const SincTable& t : tables) {
        if (speed <= t.ratio())
            return t;
    }
    // Past the top of the ladder: the widest kernel is the safest thing left.
    return tables.back();
}

const float* SincTable::weightsForPhase(double phase) const {
    if (table.empty())
        return nullptr;
    int index = static_cast<int>(phase * static_cast<double>(kSincPhases) + 0.5);
    index = std::clamp(index, 0, kSincPhases);
    return table.data() + static_cast<size_t>(index) * static_cast<size_t>(taps());
}

float sincSample(const SincTable& table, const float* source, int64_t length, double position) {
    if (source == nullptr || length <= 0 || !std::isfinite(position))
        return 0.0f;
    const float* w = table.weightsForPhase(position - std::floor(position));
    if (w == nullptr)
        return 0.0f;

    const int64_t base = static_cast<int64_t>(std::floor(position)) - kSincHalfTaps + 1;
    const int n = SincTable::taps();

    // Fast path: the whole kernel is inside the source, which is every sample
    // except the first and last few of a region.
    if (base >= 0 && base + n <= length) {
        const float* s = source + base;
        float acc = 0.0f;
        for (int t = 0; t < n; ++t)
            acc += s[t] * w[t];
        return acc;
    }

    float acc = 0.0f;
    for (int t = 0; t < n; ++t) {
        const int64_t i = base + t;
        if (i >= 0 && i < length)
            acc += source[i] * w[t];
    }
    return acc;
}

float sincSampleLooped(const SincTable& table, const float* source, int64_t length,
                       double position) {
    if (source == nullptr || length <= 0 || !std::isfinite(position))
        return 0.0f;
    const float* w = table.weightsForPhase(position - std::floor(position));
    if (w == nullptr)
        return 0.0f;

    const int64_t base = static_cast<int64_t>(std::floor(position)) - kSincHalfTaps + 1;
    const int n = SincTable::taps();

    if (base >= 0 && base + n <= length) {
        const float* s = source + base;
        float acc = 0.0f;
        for (int t = 0; t < n; ++t)
            acc += s[t] * w[t];
        return acc;
    }

    float acc = 0.0f;
    for (int t = 0; t < n; ++t) {
        int64_t i = (base + t) % length;
        if (i < 0)
            i += length;
        acc += source[i] * w[t];
    }
    return acc;
}

} // namespace resostage
