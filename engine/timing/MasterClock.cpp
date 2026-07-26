#include "MasterClock.h"

#if defined(__APPLE__)
    #include <mach/mach_time.h>
#else
    #include <chrono>
#endif

namespace resoset {

uint64_t SystemMonotonicClock::ticksToNanos(uint64_t ticks) {
#if defined(__APPLE__)
    static const mach_timebase_info_data_t timebase = [] {
        mach_timebase_info_data_t info{};
        mach_timebase_info(&info);
        return info;
    }();
    // 128-bit intermediate avoids overflow for ticks * numer regardless of timebase ratio.
    return static_cast<uint64_t>((static_cast<__uint128_t>(ticks) * timebase.numer) / timebase.denom);
#else
    return ticks;
#endif
}

uint64_t SystemMonotonicClock::nowNanos() const {
#if defined(__APPLE__)
    return ticksToNanos(mach_absolute_time());
#else
    using namespace std::chrono;
    return static_cast<uint64_t>(duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count());
#endif
}

namespace {
const SystemMonotonicClock& defaultClock() {
    static const SystemMonotonicClock instance;
    return instance;
}
} // namespace

MasterClock::MasterClock(const MonotonicClockSource* clockSource)
    : clock(clockSource != nullptr ? clockSource : &defaultClock()) {}

void MasterClock::start(double sampleRateIn, int64_t startSample) {
    sampleRateHz.store(sampleRateIn, std::memory_order_relaxed);
    anchorHostNanos.store(clock->nowNanos(), std::memory_order_relaxed);
    anchorSample.store(startSample, std::memory_order_relaxed);
    gamma.store(1.0, std::memory_order_relaxed);
    integralError = 0.0;
    running.store(true, std::memory_order_release);
}

void MasterClock::stop() {
    running.store(false, std::memory_order_release);
}

void MasterClock::onAudioCallback(uint64_t hostTimeNanos, int64_t hwSamplePosition) {
    if (!running.load(std::memory_order_acquire))
        return;

    const double sr = sampleRateHz.load(std::memory_order_relaxed);
    if (sr <= 0.0)
        return;

    const uint64_t prevAnchorHost = anchorHostNanos.load(std::memory_order_relaxed);
    const int64_t prevAnchorSample = anchorSample.load(std::memory_order_relaxed);
    const double g = gamma.load(std::memory_order_relaxed);

    // Expected sample position at hostTimeNanos, projected forward from the previous anchor.
    const double elapsedSec = (hostTimeNanos > prevAnchorHost)
                                   ? static_cast<double>(hostTimeNanos - prevAnchorHost) * 1e-9
                                   : 0.0;
    const double expectedSample = static_cast<double>(prevAnchorSample) + elapsedSec * sr * g;
    const double errorSamples = static_cast<double>(hwSamplePosition) - expectedSample;
    const double errorSeconds = errorSamples / sr;

    // PI loop filter driving gamma toward eliminating the error.
    integralError += errorSeconds;
    const double integralClamp = 1.0; // +/- 1 second-worth of accumulated error
    if (integralError > integralClamp) integralError = integralClamp;
    if (integralError < -integralClamp) integralError = -integralClamp;

    double newGamma = 1.0 + kProportionalGain * errorSeconds + kIntegralGain * integralError;
    if (newGamma > 1.0 + kMaxGammaDeviation) newGamma = 1.0 + kMaxGammaDeviation;
    if (newGamma < 1.0 - kMaxGammaDeviation) newGamma = 1.0 - kMaxGammaDeviation;
    gamma.store(newGamma, std::memory_order_relaxed);

    // Re-anchor to the hardware-reported position so error doesn't accumulate unbounded.
    anchorHostNanos.store(hostTimeNanos, std::memory_order_relaxed);
    anchorSample.store(hwSamplePosition, std::memory_order_relaxed);
}

int64_t MasterClock::currentSamplePosition() const {
    const int64_t anchorSmp = anchorSample.load(std::memory_order_relaxed);
    if (!running.load(std::memory_order_acquire))
        return anchorSmp;

    const uint64_t nowNanos = clock->nowNanos();
    const uint64_t anchorNanos = anchorHostNanos.load(std::memory_order_relaxed);
    const double sr = sampleRateHz.load(std::memory_order_relaxed);
    const double g = gamma.load(std::memory_order_relaxed);

    const double elapsedSec = (nowNanos > anchorNanos)
                                   ? static_cast<double>(nowNanos - anchorNanos) * 1e-9
                                   : 0.0;

    return anchorSmp + static_cast<int64_t>(elapsedSec * sr * g);
}

double MasterClock::currentSeconds() const {
    const double sr = sampleRateHz.load(std::memory_order_relaxed);
    if (sr <= 0.0)
        return 0.0;
    return static_cast<double>(currentSamplePosition()) / sr;
}

} // namespace resoset
