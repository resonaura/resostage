#pragma once

#include "../telemetry/Telemetry.h"

#include <cstdint>
#include <vector>

namespace resostage {

// Log-spaced band centre frequencies (Hz) for BandEnergyMeter -- index 0 is
// the lowest band, matching kLightBandCount's layout. Each band is an RBJ
// bandpass biquad (constant 0 dB peak gain) with Q=1, so the -3dB edges sit
// at f0/2 and 2*f0 and adjacent bands overlap gently (a real mix lights a
// few neighbouring columns, not one lonely one).
constexpr double kLightBandCentersHz[kLightBandCount] = {100.0, 250.0, 630.0, 1600.0, 4000.0, 10000.0};

// Direct-form II transposed biquad.
class Biquad {
public:
    void setCoefficients(double b0, double b1, double b2, double a1, double a2);
    float processSample(float x);
    void reset();

private:
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;
    double z1 = 0.0, z2 = 0.0;
};

// The two cascaded K-weighting biquad stages defined by ITU-R BS.1770-4 Annex 1:
// a high-shelf pre-filter (models head acoustic boost) followed by an RLB
// high-pass (models the ear's low-frequency roll-off). Coefficients are
// derived from sample rate at prepare() time via the standard bilinear-
// transform parameters, so this is correct at 44.1kHz, 48kHz, or any other rate.
struct KWeightingFilter {
    Biquad stage1;
    Biquad stage2;

    void prepare(double sampleRateHz);
    float process(float x) { return stage2.processSample(stage1.processSample(x)); }
    void reset() {
        stage1.reset();
        stage2.reset();
    }
};

// True-peak estimation via oversampled polyphase FIR interpolation (default
// 4x), per ITU-R BS.1770-4 Annex 2 guidance: detects inter-sample peaks that
// could clip after D/A reconstruction but wouldn't show up in a naive
// per-sample peak scan. Taps are precomputed at prepare() time (may
// allocate); processBlock() never allocates.
//
// NOT currently wired into any meter. It used to run inside LoudnessMeter on
// every bus, every block -- 4 phases x 8 taps (with two integer modulos in the
// inner loop) per sample per channel -- and every one of those results was
// then discarded: AudioEngine::publishStripMeter overwrites MeterFrame::
// truePeakDb with the sample peak before the frame is ever published, and
// nothing downstream (UI included) reads a true-peak value. It was the single
// most expensive thing on the audio thread on a many-output rig. Kept here,
// correct and ready, for whoever actually wants to SHOW inter-sample peaks --
// at which point it needs a way to be enabled per meter point rather than
// unconditionally on all of them.
class TruePeakEstimator {
public:
    void prepare(int oversampleFactor = 4);
    void reset();
    // Returns the block's true-peak absolute value (linear, 0..~a few for hot signals).
    float processBlock(const float* samples, int numSamples);

private:
    int factor = 4;
    int tapsPerPhase = 8;
    std::vector<float> polyphaseTaps; // [phase * tapsPerPhase + k]
    std::vector<float> history;       // ring of the last tapsPerPhase input samples
    int historyPos = 0;
};

// Splits one meter point's signal into kLightBandCount log-spaced bands via
// constant-0dB-peak RBJ bandpass biquads and publishes a smoothed 0..1 level
// per band -- the light engine's GEQ/Blurz audio source (see the RESTORE_POINT
// "no FFT / spectral analysis exists yet" note: this is the band-energy
// approach chosen there, real-time-safe and allocation-free after prepare()).
//
// Per-block mean-square energy per band is mapped to 0..1 with a -48dBFS
// floor (quieter-than-that reads as a dark column; -24dBFS RMS sits at half
// height), then passed through fast-attack / slow-release one-pole smoothing
// so the LED columns
// rise instantly with a hit but fall naturally instead of strobing with the
// sample-level envelope. processBlock() never allocates; the per-channel
// filter banks are allocated once in prepare().
class BandEnergyMeter {
public:
    void prepare(double sampleRateHz, int numChannels);
    void reset();
    // Called from the audio thread once per render block. `channels` is the
    // same pointer array LoudnessMeter::processBlock accepts; a mono signal
    // may pass one channel, or two with channel[1] == channel[0] / nullptr.
    void processBlock(const float* const* channels, int numSamples);
    // Copies the current smoothed 0..1 levels into out[0..kLightBandCount).
    void currentLevels(float* out) const;

private:
    double sampleRateHz = 48000.0;
    int channelCount = 2;
    // [band][channel] bandpass biquads (Q=1, constant 0dB peak gain).
    std::vector<std::vector<Biquad>> filters;
    // [band] mean-square energy accumulated over the current render block.
    std::vector<double> sumSquares;
    // [band] smoothed 0..1 levels.
    std::vector<float> levels;
};

// Owns K-weighting + block accumulation + gating for ONE meter point (a track
// or a bus), across up to `channelCount` channels. All processing after
// prepare() is allocation-free.
//
// Integrated-loudness note: exact ITU-R BS.1770-4 compliance-grade integrated
// loudness requires the two-stage gate to be re-evaluated over the FULL stored
// block history (absolute gate, then a relative gate derived from the
// absolute-gated mean). Storing unbounded history and re-scanning it isn't
// compatible with a zero-allocation, bounded-memory real-time meter running
// for an entire show. This implementation instead maintains a running,
// incrementally-updated estimate (absolute-gated running mean feeds the
// relative threshold, which is then applied going forward) that converges to
// the same value and is suitable for on-stage level monitoring. It is not
// intended as a broadcast-compliance certification tool.
class LoudnessMeter {
public:
    void prepare(double sampleRateHz, int numChannels);
    void reset();

    // Called from the audio thread once per render block.
    void processBlock(const float* const* channels, int numSamples);

    MeterFrame currentFrame() const;

private:
    double sampleRateHz = 48000.0;
    int channelCount = 2;

    std::vector<KWeightingFilter> kFilters;

    // Per-band (GEQ/Blurz) energy analysis, processed alongside the peak/LUFS
    // path from the same block.
    BandEnergyMeter bandEnergy;

    // 400ms analysis blocks, 100ms hop (75% overlap) per BS.1770-4 / EBU Tech 3341.
    int blockSizeSamples = 0;
    int hopSizeSamples = 0;
    int samplesAccumulated = 0;
    std::vector<double> sumSquaresPerChannel; // accumulates over the current 400ms window

    // A rolling ring of per-hop (100ms) block mean-square energies, used for the
    // 3s short-term window (30 blocks). Fixed size, allocated once in prepare().
    static constexpr int kShortTermBlocks = 30;
    std::vector<double> blockEnergyRing;
    int ringWritePos = 0;
    int ringFilledCount = 0;

    // Running integrated-loudness gating state (see class comment above).
    double absoluteGateEnergySum = 0.0;
    int64_t absoluteGateBlockCount = 0;
    double relativeGateEnergySum = 0.0;
    int64_t relativeGateBlockCount = 0;

    float currentPeakDb = -144.0f;
    float currentPeakDbL = -144.0f;
    float currentPeakDbR = -144.0f;
    float currentTruePeakDb = -144.0f;
    float currentMomentaryLufs = -144.0f;
    float currentShortTermLufs = -144.0f;
    float currentIntegratedLufs = -144.0f;

    void finishHop(double hopMeanSquareEnergy);
};

} // namespace resostage
