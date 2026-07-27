#include "PeakOverview.h"
#include "WavStreamDecoder.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace resoset {

namespace {

bool decodePeaksFromWav(const uint8_t* data, size_t size, int numBins,
                        float& baseline, double& durationSeconds, int& numChannels,
                        std::vector<float>& peaks, std::string& error) {
    baseline = 0.5f;
    durationSeconds = 0.0;
    numChannels = 0;

    numBins = std::clamp(numBins, 32, 16384);

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

    peaks.assign(static_cast<size_t>(numBins), 0.0f);

    constexpr int64_t kChunk = 262144;
    std::vector<std::vector<float>> planar(static_cast<size_t>(numChannels));
    for (auto& ch : planar)
        ch.resize(static_cast<size_t>(kChunk));
    std::vector<float*> ptrs(static_cast<size_t>(numChannels));
    for (int c = 0; c < numChannels; ++c)
        ptrs[static_cast<size_t>(c)] = planar[static_cast<size_t>(c)].data();

    const double invTotal = 1.0 / static_cast<double>(total);
    const int nBins = numBins;

    int64_t framePos = 0;
    double sampleSum = 0.0;
    int64_t sampleCount = 0;
    while (framePos < total) {
        const int64_t got = decoder.decodeFrames(memReadFn, ptrs.data(), kChunk);
        if (got <= 0)
            break;

        const int64_t fp = framePos;
        for (int64_t i = 0; i < got; ++i) {
            float peak = 0.0f;
            for (int c = 0; c < numChannels; ++c) {
                const float s = planar[static_cast<size_t>(c)][static_cast<size_t>(i)];
                const float a = std::abs(s);
                if (a > peak) peak = a;
                sampleSum += s;
            }
            sampleCount += numChannels;

            const int b = std::clamp(static_cast<int>((fp + i) * invTotal * nBins), 0, nBins - 1);
            if (peak > peaks[static_cast<size_t>(b)])
                peaks[static_cast<size_t>(b)] = peak;
        }
        framePos += got;
    }

    if (sampleCount > 0) {
        const float avg = static_cast<float>(sampleSum / sampleCount);
        baseline = std::clamp(0.5f + avg * 0.5f, 0.0f, 1.0f);
    }

    return true;
}

} // namespace

bool PeakOverview::build(const ProjectLoader& loader, const std::string& archivePath,
                         int numBins, std::string& error) {
    peaks.clear();
    durationSeconds = 0.0;
    numChannels = 0;
    baseline = 0.5f;

    std::vector<uint8_t> wavData;
    if (!loader.extractFile(archivePath, wavData, error))
        return false;

    return decodePeaksFromWav(wavData.data(), wavData.size(), numBins,
                              baseline, durationSeconds, numChannels, peaks, error);
}

bool PeakOverview::buildFromBuffer(const uint8_t* data, size_t size,
                                   int numBins, std::string& error) {
    peaks.clear();
    durationSeconds = 0.0;
    numChannels = 0;
    baseline = 0.5f;

    return decodePeaksFromWav(data, size, numBins,
                              baseline, durationSeconds, numChannels, peaks, error);
}

} // namespace resoset
