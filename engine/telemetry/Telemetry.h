#pragma once

#include <atomic>
#include <cstdint>

namespace resoset {

// Per-meter-point snapshot (one instance per track or per bus), written by the
// audio thread's Metering pass and consumed by UI/web threads via SeqLock<MeterFrame>.
// Trivially copyable, as required by SeqLock.
struct MeterFrame {
    float peakDb = -144.0f;   // max(L, R) — mono / legacy consumers
    float peakDbL = -144.0f;  // left-channel sample peak this block
    float peakDbR = -144.0f;  // right-channel sample peak (mono: same as L)
    float truePeakDb = -144.0f;
    float momentaryLufs = -144.0f;  // ~400ms window
    float shortTermLufs = -144.0f;  // 3s window
    float integratedLufs = -144.0f; // gated, since measurement start
};

// Global transport state. Individual scalar fields are independently atomic
// (each is small enough for a lock-free native atomic store/load), matching the
// "atomic registers for simple scalars" half of the wait-free telemetry design
// (MeterFrame's multi-field struct is the other half, via SeqLock).
struct TransportTelemetry {
    std::atomic<int64_t> playheadSamples{0};
    std::atomic<double> playheadSeconds{0.0};
    std::atomic<double> sampleRate{48000.0};
    std::atomic<double> driftFactor{1.0};
    std::atomic<bool> running{false};
    std::atomic<bool> hardwareAlarm{false}; // set by device hot-plug/failure handling (later milestone)
};

} // namespace resoset
