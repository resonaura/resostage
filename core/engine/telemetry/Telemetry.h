#pragma once

#include <atomic>
#include <cstdint>

namespace resostage {

// Number of log-spaced frequency bands the audio meter splits into for the
// light engine's GEQ/Blurz effects (see BandEnergyMeter in Metering.h).
// Fixed so the band array lives inline in the trivially-copyable MeterFrame
// (a SeqLock payload) and both the C++ lighting code and the TypeScript port
// agree on the layout without a shared schema generator.
constexpr int kLightBandCount = 6;

// Per-meter-point snapshot (one instance per track or per bus), written by the
// audio thread's Metering pass and consumed by UI/web threads via SeqLock<MeterFrame>.
// Trivially copyable, as required by SeqLock.
struct MeterFrame {
    float peakDb = -144.0f;   // max(L, R) — mono / legacy consumers
    float peakDbL = -144.0f;  // left-channel sample peak this block
    float peakDbR = -144.0f;  // right-channel sample peak (mono: same as L)
    /**
     * Needle value with PPM ballistics, computed on the audio thread every 64
     * samples (see engine/audio/MeterEnvelope.h).
     *
     * Distinct from peakDb, which is "loudest sample in the block": at a large
     * buffer that is one reading per 85ms and says nothing about the shape of
     * what happened inside. This one is a filter with a defined release, so it
     * behaves the same at every buffer size.
     */
    float ppmDbL = -144.0f;
    float ppmDbR = -144.0f;
    float truePeakDb = -144.0f;
    float momentaryLufs = -144.0f;  // ~400ms window
    float shortTermLufs = -144.0f;  // 3s window
    float integratedLufs = -144.0f; // gated, since measurement start
    // 0..1 per-band energy (index 0 = lowest band), fed from the meter point's
    // BandEnergyMeter pass. Only meaningful for the light engine's GEQ/Blurz
    // effects; all other consumers ignore it.
    float bandLevel[kLightBandCount] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
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

} // namespace resostage
