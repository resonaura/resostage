#pragma once

#include "../telemetry/Telemetry.h"

#include <cstdint>
#include <vector>

namespace resoset {

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
    std::vector<TruePeakEstimator> truePeakEstimators;

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
    float currentTruePeakDb = -144.0f;
    float currentMomentaryLufs = -144.0f;
    float currentShortTermLufs = -144.0f;
    float currentIntegratedLufs = -144.0f;

    void finishHop(double hopMeanSquareEnergy);
};

} // namespace resoset
