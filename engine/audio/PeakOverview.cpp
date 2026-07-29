#include "PeakOverview.h"
#include "WavStreamDecoder.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>

#if defined(__APPLE__)
#include <Accelerate/Accelerate.h>
#define RESOSTAGE_HAVE_ACCELERATE 1
#endif

namespace resostage {

namespace {

// Target bin counts for each pyramid level, finest first. Bounded (not tied
// to file length) so a JSON-serialized level never balloons for a long file
// -- see PeakOverview.h's class comment. Zooming in past level 0 switches to
// an on-demand raw-sample fetch instead of growing this list.
constexpr int kLevelBinTargets[] = {8192, 1024, 128, 16};

struct ChannelStats {
    float minV;
    float maxV;
    double sumSq;
};

// Computes {min, max, sum-of-squares} over one contiguous channel slice.
// Accelerate's vDSP does this with real SIMD on Apple hardware (including
// Apple Silicon, where the AVX2 intrinsics some peak-generation writeups
// suggest wouldn't even compile); a portable scalar loop covers everything
// else so the engine keeps building on non-Apple targets.
ChannelStats channelStats(const float* data, size_t n) {
    ChannelStats s{0.0f, 0.0f, 0.0};
    if (n == 0)
        return s;
#if defined(RESOSTAGE_HAVE_ACCELERATE)
    vDSP_minv(data, 1, &s.minV, static_cast<vDSP_Length>(n));
    vDSP_maxv(data, 1, &s.maxV, static_cast<vDSP_Length>(n));
    float sumSqF = 0.0f;
    vDSP_svesq(const_cast<float*>(data), 1, &sumSqF, static_cast<vDSP_Length>(n));
    s.sumSq = static_cast<double>(sumSqF);
#else
    s.minV = data[0];
    s.maxV = data[0];
    for (size_t i = 0; i < n; ++i) {
        s.minV = std::min(s.minV, data[i]);
        s.maxV = std::max(s.maxV, data[i]);
        s.sumSq += static_cast<double>(data[i]) * static_cast<double>(data[i]);
    }
#endif
    return s;
}

// How many bins level `levelIdx` should target for a file with `totalFrames`
// samples, clamped so each level is strictly coarser (fewer bins) than the
// previous one and never exceeds the source frame count.
std::vector<int> resolveLevelBinCounts(int64_t totalFrames) {
    std::vector<int> counts;
    int prevBins = -1;
    for (int target : kLevelBinTargets) {
        int bins = static_cast<int>(std::min<int64_t>(target, std::max<int64_t>(1, totalFrames)));
        if (prevBins >= 0)
            bins = std::min(bins, prevBins > 1 ? prevBins - 1 : 1); // strictly coarser than the previous level
        counts.push_back(std::max(1, bins));
        prevBins = counts.back();
        if (prevBins <= 1)
            break;
    }
    return counts;
}

bool decodePyramidFromWav(const uint8_t* data, size_t size, double& durationSeconds, int& numChannels,
                          std::vector<PeakLevel>& levels, std::string& error) {
    durationSeconds = 0.0;
    numChannels = 0;
    levels.clear();

    size_t readPos = 0;
    auto memReadFn = [&](void* buf, size_t n) -> size_t {
        const size_t avail = size - readPos;
        const size_t toCopy = std::min(n, avail);
        if (toCopy > 0) {
            std::memcpy(buf, data + readPos, toCopy);
            readPos += toCopy;
        }
        return toCopy;
    };

    WavStreamDecoder decoder;
    if (!decoder.parseHeader(memReadFn, error))
        return false;

    numChannels = decoder.numChannels();
    const int64_t total = decoder.totalFrames();
    const double sr = decoder.sampleRate();
    if (numChannels <= 0 || total <= 0 || sr <= 0.0) {
        error = "Empty or invalid WAV for peak overview";
        return false;
    }
    durationSeconds = static_cast<double>(total) / sr;

    const std::vector<int> binCounts = resolveLevelBinCounts(total);
    if (binCounts.empty()) {
        error = "Unable to size peak pyramid";
        return false;
    }

    // Level 0 (finest) is built directly from decoded PCM; every coarser
    // level is a cheap reduction of the previous level's bins, never
    // re-touching PCM (same approach REAPER/Logic use for their own
    // multi-resolution peak caches).
    const int numBins0 = binCounts[0];
    std::vector<PeakBin> level0(static_cast<size_t>(numBins0));
    std::vector<double> sumSq(static_cast<size_t>(numBins0), 0.0);
    std::vector<int64_t> counts(static_cast<size_t>(numBins0), 0);
    for (auto& b : level0) {
        b.minVal = std::numeric_limits<float>::max();
        b.maxVal = std::numeric_limits<float>::lowest();
    }

    constexpr int64_t kChunk = 262144;
    std::vector<std::vector<float>> planar(static_cast<size_t>(numChannels));
    for (auto& ch : planar)
        ch.resize(static_cast<size_t>(kChunk));
    std::vector<float*> ptrs(static_cast<size_t>(numChannels));
    for (int c = 0; c < numChannels; ++c)
        ptrs[static_cast<size_t>(c)] = planar[static_cast<size_t>(c)].data();

    auto binFrameStart = [&](int64_t bin) -> int64_t {
        return (bin * total) / numBins0;
    };

    int64_t framePos = 0;
    while (framePos < total) {
        const int64_t got = decoder.decodeFrames(memReadFn, ptrs.data(), kChunk);
        if (got <= 0)
            break;

        int64_t bin = std::clamp<int64_t>((framePos * numBins0) / total, 0, numBins0 - 1);
        int64_t chunkEnd = framePos + got;
        while (bin < numBins0 && binFrameStart(bin) < chunkEnd) {
            const int64_t binStart = binFrameStart(bin);
            const int64_t binEnd = (bin + 1 < numBins0) ? binFrameStart(bin + 1) : total;
            const int64_t lo = std::max(framePos, binStart);
            const int64_t hi = std::min(chunkEnd, binEnd);
            if (hi > lo) {
                const size_t localLo = static_cast<size_t>(lo - framePos);
                const size_t n = static_cast<size_t>(hi - lo);
                PeakBin& outBin = level0[static_cast<size_t>(bin)];
                for (int c = 0; c < numChannels; ++c) {
                    const ChannelStats cs = channelStats(ptrs[static_cast<size_t>(c)] + localLo, n);
                    outBin.minVal = std::min(outBin.minVal, cs.minV);
                    outBin.maxVal = std::max(outBin.maxVal, cs.maxV);
                    sumSq[static_cast<size_t>(bin)] += cs.sumSq;
                    counts[static_cast<size_t>(bin)] += static_cast<int64_t>(n);
                }
            }
            if (binEnd > chunkEnd)
                break;
            ++bin;
        }

        framePos += got;
    }

    for (size_t i = 0; i < level0.size(); ++i) {
        if (counts[i] > 0) {
            level0[i].rms = static_cast<float>(std::sqrt(sumSq[i] / static_cast<double>(counts[i])));
        } else {
            level0[i].minVal = 0.0f;
            level0[i].maxVal = 0.0f;
            level0[i].rms = 0.0f;
        }
    }

    levels.push_back(PeakLevel{static_cast<int>(std::max<int64_t>(1, total / numBins0)), std::move(level0)});

    for (size_t li = 1; li < binCounts.size(); ++li) {
        const PeakLevel& prevLevel = levels.back();
        const int targetBins = binCounts[li];
        const int prevBins = static_cast<int>(prevLevel.bins.size());
        const int ratio = std::max(1, prevBins / std::max(1, targetBins));

        PeakLevel level;
        level.samplesPerBin = prevLevel.samplesPerBin * ratio;
        level.bins.resize(static_cast<size_t>((prevBins + ratio - 1) / ratio));
        for (size_t j = 0; j < level.bins.size(); ++j) {
            const size_t lo = j * static_cast<size_t>(ratio);
            const size_t hi = std::min(prevLevel.bins.size(), lo + static_cast<size_t>(ratio));
            float minV = std::numeric_limits<float>::max();
            float maxV = std::numeric_limits<float>::lowest();
            double sumSqNorm = 0.0;
            for (size_t k = lo; k < hi; ++k) {
                minV = std::min(minV, prevLevel.bins[k].minVal);
                maxV = std::max(maxV, prevLevel.bins[k].maxVal);
                sumSqNorm += static_cast<double>(prevLevel.bins[k].rms) * static_cast<double>(prevLevel.bins[k].rms);
            }
            const size_t n = hi - lo;
            level.bins[j].minVal = minV;
            level.bins[j].maxVal = maxV;
            level.bins[j].rms = n > 0 ? static_cast<float>(std::sqrt(sumSqNorm / static_cast<double>(n))) : 0.0f;
        }
        levels.push_back(std::move(level));
    }

    return true;
}

// Interpolates a sample at continuous position mu in [0, 1] between y1 and y2
// using 4 surrounding discrete points (y0, y1, y2, y3) for subsample zoom rendering.
float cubicHermite(float y0, float y1, float y2, float y3, float mu) {
    const float mu2 = mu * mu;
    const float a0 = y3 - y2 - y0 + y1;
    const float a1 = y0 - y1 - a0;
    const float a2 = y2 - y0;
    const float a3 = y1;
    return (a0 * mu * mu2 + a1 * mu2 + a2 * mu + a3);
}

} // namespace

bool PeakOverview::build(const ProjectLoader& loader, const std::string& archivePath, std::string& error) {
    levels.clear();
    durationSeconds = 0.0;
    numChannels = 0;

    std::vector<uint8_t> wavData;
    if (!loader.extractFile(archivePath, wavData, error))
        return false;

    return decodePyramidFromWav(wavData.data(), wavData.size(), durationSeconds, numChannels, levels, error);
}

bool PeakOverview::buildFromBuffer(const uint8_t* data, size_t size, std::string& error) {
    levels.clear();
    durationSeconds = 0.0;
    numChannels = 0;

    return decodePyramidFromWav(data, size, durationSeconds, numChannels, levels, error);
}

const PeakLevel* PeakOverview::bestLevelForZoom(double samplesPerPixel) const {
    if (levels.empty())
        return nullptr;
    const PeakLevel* best = &levels.front();
    for (const auto& level : levels) {
        if (level.samplesPerBin <= samplesPerPixel)
            best = &level;
        else
            break;
    }
    return best;
}

} // namespace resostage

