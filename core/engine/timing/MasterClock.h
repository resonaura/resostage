#pragma once

#include <atomic>
#include <cstdint>

namespace resostage {

// Abstraction over a monotonic time source, in nanoseconds since an arbitrary epoch.
// Production code uses mach_absolute_time() (macOS). Tests inject a fake source to
// simulate wall-clock passage without real sleeps, and to prove the playhead keeps
// advancing even when the audio callback never fires (the core fail-safe property).
class MonotonicClockSource {
public:
    virtual ~MonotonicClockSource() = default;
    virtual uint64_t nowNanos() const = 0;
};

class SystemMonotonicClock final : public MonotonicClockSource {
public:
    uint64_t nowNanos() const override;

    // Converts a raw platform host-time value (mach_absolute_time() ticks on
    // macOS; passthrough elsewhere) into nanoseconds, using the same
    // timebase ratio nowNanos() uses internally. Needed because some OS/
    // framework APIs hand back a host timestamp in raw tick units under a
    // misleadingly nanosecond-sounding name (e.g. JUCE's
    // AudioIODeviceCallbackContext::hostTimeNs on the CoreAudio backend is
    // actually AudioTimeStamp::mHostTime, i.e. raw ticks) -- mixing that
    // directly with an already-converted nanosecond value elsewhere corrupts
    // MasterClock's elapsed-time math by the timebase ratio (~41.7x on Intel
    // Macs and some Apple Silicon configurations), causing the playhead to
    // rocket forward and immediately trip the song-end check.
    static uint64_t ticksToNanos(uint64_t ticks);
};

// Fail-safe master playhead.
//
// The engine's global timeline position must never stall just because the audio
// driver glitches, underruns, or the interface is unplugged. MasterClock derives
// its position primarily from wall-clock time (via a MonotonicClockSource),
// anchored to the most recent (hostTime, samplePosition) pair reported by the real
// audio callback. A small proportional-integral (PI) loop filter tracks the drift
// between the anchor's projected position and the hardware-reported position, and
// biases the wall-clock-to-samples projection rate (gamma) to compensate.
//
// If the audio callback stops calling onAudioCallback() (device glitch, hot-unplug,
// CPU overload), currentSamplePosition() keeps advancing at the last known
// drift-corrected rate, purely from elapsed wall-clock time. MIDI/DMX schedulers
// that read this clock are therefore unaffected by audio dropouts.
//
// Thread-safety: start()/stop()/onAudioCallback() are intended to be called from a
// single writer (the audio thread, or the thread that owns transport control).
// currentSamplePosition()/currentSeconds()/driftFactor() are safe to call from any
// thread (relaxed atomic reads of independently-consistent fields; a torn read
// across anchor update mid-flight yields at most one stale-but-still-monotonic
// sample estimate for that single read, which is acceptable for telemetry/UI use).
class MasterClock {
public:
    // clockSource is not owned; caller must keep it alive for the MasterClock's lifetime.
    // Defaults to a shared process-wide SystemMonotonicClock instance.
    explicit MasterClock(const MonotonicClockSource* clockSource = nullptr);

    void start(double sampleRate, int64_t startSample = 0);
    void stop();
    bool isRunning() const { return running.load(std::memory_order_acquire); }

    // Called once per real audio callback, from the audio thread.
    //   hostTimeNanos    - wall-clock time (same domain as the clock source) at which
    //                       hwSamplePosition was/will be rendered by the hardware.
    //   hwSamplePosition - the sample counter the hardware/driver reports at hostTimeNanos.
    void onAudioCallback(uint64_t hostTimeNanos, int64_t hwSamplePosition);

    // Free-running read, safe from any thread. Advances continuously off wall-clock
    // time even if onAudioCallback() has not been called recently.
    int64_t currentSamplePosition() const;
    double currentSeconds() const;

    // Song index: set by transport when the active song changes; read by
    // LightEngine (and any other subscriber) from any thread.
    int  currentSongIndex() const { return songIndex.load(std::memory_order_acquire); }
    void setSongIndex(int idx)    { songIndex.store(idx, std::memory_order_release); }

    double sampleRate() const { return sampleRateHz.load(std::memory_order_relaxed); }
    // Current drift-correction multiplier (diagnostics/telemetry only).
    double driftFactor() const { return gamma.load(std::memory_order_relaxed); }

private:
    const MonotonicClockSource* clock;

    std::atomic<bool> running{false};
    std::atomic<double> sampleRateHz{48000.0};

    // Anchor: at wall-clock time anchorHostNanos, the timeline was at anchorSample.
    std::atomic<uint64_t> anchorHostNanos{0};
    std::atomic<int64_t> anchorSample{0};

    // PI-loop drift-correction factor, applied to elapsed wall-clock time when
    // projecting forward from the anchor. Written only from onAudioCallback()
    // (single-writer), read from any thread.
    std::atomic<double> gamma{1.0};
    double integralError = 0.0; // owned by the writer (audio) thread only

    // Active song index. Written from transport/message thread (setSongIndex),
    // read from LightEngine thread (currentSongIndex). Relaxed store/acquire
    // load matches the existing pattern for all other clock fields.
    std::atomic<int> songIndex{0};

    // Conservative placeholder gains; tune against real CoreAudio callback jitter
    // once running on actual hardware.
    static constexpr double kProportionalGain = 0.0005;
    static constexpr double kIntegralGain = 0.0000005;
    static constexpr double kMaxGammaDeviation = 0.02; // clamp +/-2% to prevent runaway correction
};

} // namespace resostage
