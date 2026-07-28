#include "Metering.h"

#include <algorithm>
#include <cmath>

namespace resoset {

namespace {
constexpr double kPi = 3.14159265358979323846;

float linearToDb(double linear) {
    if (!(linear > 1.0e-10) || !std::isfinite(linear))
        return -144.0f;
    // Hard-cap so a single garbage sample (e.g. float-decoded zip garbage
    // after an EOF skip overflow) can never report +400 dBFS into the UI.
    constexpr double kMaxLinear = 32.0; // ~+30 dBFS -- above any real true-peak
    const double clamped = std::min(linear, kMaxLinear);
    return static_cast<float>(20.0 * std::log10(clamped));
}

float energyToLufs(double meanSquareEnergy) {
    if (meanSquareEnergy <= 1.0e-10)
        return -144.0f;
    return static_cast<float>(-0.691 + 10.0 * std::log10(meanSquareEnergy));
}
} // namespace

// ---------------------------------------------------------------------------
// Biquad
// ---------------------------------------------------------------------------

void Biquad::setCoefficients(double b0_, double b1_, double b2_, double a1_, double a2_) {
    b0 = b0_;
    b1 = b1_;
    b2 = b2_;
    a1 = a1_;
    a2 = a2_;
}

float Biquad::processSample(float x) {
    // Direct-form II transposed.
    const double in = static_cast<double>(x);
    const double out = b0 * in + z1;
    z1 = b1 * in - a1 * out + z2;
    z2 = b2 * in - a2 * out;
    return static_cast<float>(out);
}

void Biquad::reset() {
    z1 = 0.0;
    z2 = 0.0;
}

// ---------------------------------------------------------------------------
// KWeightingFilter — ITU-R BS.1770-4 Annex 1 coefficient derivation.
// Constants below are the standard BS.1770 filter design parameters (as used
// by reference implementations such as libebur128 / ffmpeg's ebur128 filter),
// derived analytically so they're correct at any sample rate.
// ---------------------------------------------------------------------------

void KWeightingFilter::prepare(double sampleRateHz) {
    {
        // Stage 1: high-shelf pre-filter.
        const double f0 = 1681.9744509555319;
        const double G = 3.99984385397;
        const double Q = 0.7071752369554193;

        const double K = std::tan(kPi * f0 / sampleRateHz);
        const double Vh = std::pow(10.0, G / 20.0);
        const double Vb = std::pow(Vh, 0.4996667741545416);

        const double a0 = 1.0 + K / Q + K * K;
        const double b0 = (Vh + Vb * K / Q + K * K) / a0;
        const double b1 = 2.0 * (K * K - Vh) / a0;
        const double b2 = (Vh - Vb * K / Q + K * K) / a0;
        const double a1 = 2.0 * (K * K - 1.0) / a0;
        const double a2 = (1.0 - K / Q + K * K) / a0;

        stage1.setCoefficients(b0, b1, b2, a1, a2);
    }
    {
        // Stage 2: RLB weighting high-pass.
        const double f0 = 38.13547087602444;
        const double Q = 0.5003270373238773;

        const double K = std::tan(kPi * f0 / sampleRateHz);
        const double a0 = 1.0 + K / Q + K * K;
        const double b0 = 1.0 / a0;
        const double b1 = -2.0 / a0;
        const double b2 = 1.0 / a0;
        const double a1 = 2.0 * (K * K - 1.0) / a0;
        const double a2 = (1.0 - K / Q + K * K) / a0;

        stage2.setCoefficients(b0, b1, b2, a1, a2);
    }
    reset();
}

// ---------------------------------------------------------------------------
// TruePeakEstimator
// ---------------------------------------------------------------------------

void TruePeakEstimator::prepare(int oversampleFactor) {
    factor = std::max(2, oversampleFactor);
    tapsPerPhase = 8;
    const int totalTaps = tapsPerPhase * factor;
    polyphaseTaps.assign(static_cast<size_t>(totalTaps), 0.0f);

    // Windowed-sinc lowpass, designed at the oversampled rate, cutoff at the
    // original Nyquist (i.e. 1/factor of the oversampled Nyquist). The *factor
    // gain compensates for the amplitude loss of zero-stuffing during upsampling.
    const double cutoff = 1.0 / factor;
    const int center = totalTaps / 2;
    for (int n = 0; n < totalTaps; ++n) {
        const int m = n - center;
        const double sinc = (m == 0) ? cutoff : std::sin(kPi * cutoff * m) / (kPi * m);
        const double window = 0.5 - 0.5 * std::cos(2.0 * kPi * n / (totalTaps - 1));
        polyphaseTaps[static_cast<size_t>(n)] = static_cast<float>(sinc * window * factor);
    }

    history.assign(static_cast<size_t>(tapsPerPhase), 0.0f);
    historyPos = 0;
}

void TruePeakEstimator::reset() {
    std::fill(history.begin(), history.end(), 0.0f);
    historyPos = 0;
}

float TruePeakEstimator::processBlock(const float* samples, int numSamples) {
    if (samples == nullptr || numSamples <= 0 || tapsPerPhase <= 0 ||
        history.size() < static_cast<size_t>(tapsPerPhase) || polyphaseTaps.empty())
        return 0.0f;

    float peak = 0.0f;
    for (int i = 0; i < numSamples; ++i) {
        history[static_cast<size_t>(historyPos)] = samples[i];
        historyPos = (historyPos + 1) % tapsPerPhase;

        for (int phase = 0; phase < factor; ++phase) {
            double acc = 0.0;
            for (int k = 0; k < tapsPerPhase; ++k) {
                const int idx = (historyPos + k) % tapsPerPhase;
                const size_t tapIdx = static_cast<size_t>(phase * tapsPerPhase + k);
                if (tapIdx < polyphaseTaps.size() && static_cast<size_t>(idx) < history.size()) {
                    acc += static_cast<double>(history[static_cast<size_t>(idx)]) *
                           polyphaseTaps[tapIdx];
                }
            }
            peak = std::max(peak, static_cast<float>(std::abs(acc)));
        }
    }
    return peak;
}

// ---------------------------------------------------------------------------
// LoudnessMeter
// ---------------------------------------------------------------------------

void LoudnessMeter::prepare(double sampleRateHzIn, int numChannels) {
    sampleRateHz = sampleRateHzIn;
    channelCount = std::max(1, numChannels);

    kFilters.assign(static_cast<size_t>(channelCount), KWeightingFilter{});
    for (auto& f : kFilters)
        f.prepare(sampleRateHz);

    truePeakEstimators.assign(static_cast<size_t>(channelCount), TruePeakEstimator{});
    for (auto& tp : truePeakEstimators)
        tp.prepare(4);

    blockSizeSamples = static_cast<int>(sampleRateHz * 0.4);
    hopSizeSamples = static_cast<int>(sampleRateHz * 0.1);
    sumSquaresPerChannel.assign(static_cast<size_t>(channelCount), 0.0);

    blockEnergyRing.assign(static_cast<size_t>(kShortTermBlocks), 0.0);

    reset();
}

void LoudnessMeter::reset() {
    for (auto& f : kFilters)
        f.reset();
    for (auto& tp : truePeakEstimators)
        tp.reset();

    std::fill(sumSquaresPerChannel.begin(), sumSquaresPerChannel.end(), 0.0);
    samplesAccumulated = 0;

    std::fill(blockEnergyRing.begin(), blockEnergyRing.end(), 0.0);
    ringWritePos = 0;
    ringFilledCount = 0;

    absoluteGateEnergySum = 0.0;
    absoluteGateBlockCount = 0;
    relativeGateEnergySum = 0.0;
    relativeGateBlockCount = 0;

    currentPeakDb = -144.0f;
    currentPeakDbL = -144.0f;
    currentPeakDbR = -144.0f;
    currentTruePeakDb = -144.0f;
    currentMomentaryLufs = -144.0f;
    currentShortTermLufs = -144.0f;
    currentIntegratedLufs = -144.0f;
}

void LoudnessMeter::processBlock(const float* const* channels, int numSamples) {
    if (channels == nullptr || numSamples <= 0 || blockSizeSamples <= 0 || hopSizeSamples <= 0)
        return;

    float peakLinear = 0.0f;
    float peakLinearL = 0.0f;
    float peakLinearR = 0.0f;
    float truePeakLinear = 0.0f;

    const int chs = std::min(channelCount, std::min(static_cast<int>(truePeakEstimators.size()), static_cast<int>(kFilters.size())));

    for (int ch = 0; ch < chs; ++ch) {
        const float* in = channels[ch];
        if (in == nullptr)
            continue;

        float chPeak = 0.0f;
        for (int i = 0; i < numSamples; ++i) {
            const float s = in[i];
            if (!std::isfinite(s))
                continue;
            chPeak = std::max(chPeak, std::abs(s));
        }
        peakLinear = std::max(peakLinear, chPeak);
        if (ch == 0)
            peakLinearL = chPeak;
        else if (ch == 1)
            peakLinearR = chPeak;

        truePeakLinear = std::max(truePeakLinear, truePeakEstimators[static_cast<size_t>(ch)].processBlock(in, numSamples));

        double sumSq = sumSquaresPerChannel[static_cast<size_t>(ch)];
        auto& filter = kFilters[static_cast<size_t>(ch)];
        for (int i = 0; i < numSamples; ++i) {
            const float weighted = filter.process(in[i]);

            sumSq += static_cast<double>(weighted) * static_cast<double>(weighted);
        }
        sumSquaresPerChannel[static_cast<size_t>(ch)] = sumSq;
    }

    // Mono sources: mirror L into R so stereo meters stay balanced.
    if (chs < 2)
        peakLinearR = peakLinearL;

    // Block-level peak capture (this render block's peak), not an all-time max,
    // so the meter reflects current signal level rather than latching forever.
    currentPeakDb = linearToDb(peakLinear);
    currentPeakDbL = linearToDb(peakLinearL);
    currentPeakDbR = linearToDb(peakLinearR);
    currentTruePeakDb = linearToDb(truePeakLinear);

    samplesAccumulated += numSamples;
    while (samplesAccumulated >= hopSizeSamples) {
        // Mean-square energy across channels (channel weight = 1.0 for L/R; not
        // extended to surround weighting in this milestone), normalized by the
        // *analysis block* length (400ms), matching BS.1770-4's block definition.
        double energy = 0.0;
        for (int ch = 0; ch < channelCount; ++ch)
            energy += sumSquaresPerChannel[static_cast<size_t>(ch)];
        energy /= static_cast<double>(blockSizeSamples);

        finishHop(energy);

        // Slide the accumulation window forward by one hop (75% overlap: keep the
        // remaining 300ms worth of energy by simply decaying the running sums by
        // the hop fraction rather than re-summing raw samples we've discarded).
        const double keepFraction = 1.0 - (static_cast<double>(hopSizeSamples) / blockSizeSamples);
        for (int ch = 0; ch < channelCount; ++ch)
            sumSquaresPerChannel[static_cast<size_t>(ch)] *= keepFraction;

        samplesAccumulated -= hopSizeSamples;
    }
}

void LoudnessMeter::finishHop(double hopMeanSquareEnergy) {
    currentMomentaryLufs = energyToLufs(hopMeanSquareEnergy);

    blockEnergyRing[static_cast<size_t>(ringWritePos)] = hopMeanSquareEnergy;
    ringWritePos = (ringWritePos + 1) % kShortTermBlocks;
    ringFilledCount = std::min(ringFilledCount + 1, kShortTermBlocks);

    double sum = 0.0;
    for (int i = 0; i < ringFilledCount; ++i)
        sum += blockEnergyRing[static_cast<size_t>(i)];
    currentShortTermLufs = energyToLufs(sum / std::max(1, ringFilledCount));

    // Running integrated-loudness gating (see class comment in the header).
    constexpr double kAbsoluteGateLufs = -70.0;
    constexpr double kRelativeGateOffsetLu = -10.0;

    const float blockLufs = energyToLufs(hopMeanSquareEnergy);
    if (blockLufs > kAbsoluteGateLufs) {
        absoluteGateEnergySum += hopMeanSquareEnergy;
        ++absoluteGateBlockCount;

        const double absoluteGatedMean = absoluteGateEnergySum / static_cast<double>(absoluteGateBlockCount);
        const double relativeThresholdLufs = energyToLufs(absoluteGatedMean) + kRelativeGateOffsetLu;

        if (blockLufs > relativeThresholdLufs) {
            relativeGateEnergySum += hopMeanSquareEnergy;
            ++relativeGateBlockCount;
        }

        currentIntegratedLufs = relativeGateBlockCount > 0
                                     ? energyToLufs(relativeGateEnergySum / static_cast<double>(relativeGateBlockCount))
                                     : energyToLufs(absoluteGatedMean);
    }
}

MeterFrame LoudnessMeter::currentFrame() const {
    MeterFrame frame;
    frame.peakDb = currentPeakDb;
    frame.peakDbL = currentPeakDbL;
    frame.peakDbR = currentPeakDbR;
    frame.truePeakDb = currentTruePeakDb;
    frame.momentaryLufs = currentMomentaryLufs;
    frame.shortTermLufs = currentShortTermLufs;
    frame.integratedLufs = currentIntegratedLufs;
    return frame;
}

} // namespace resoset
