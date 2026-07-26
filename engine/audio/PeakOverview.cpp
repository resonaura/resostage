#include "PeakOverview.h"
#include "WavStreamDecoder.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace resoset {

bool PeakOverview::build(const ProjectLoader& loader, const std::string& archivePath,
                         int numBins, std::string& error) {
    peaks.clear();
    durationSeconds = 0.0;
    numChannels = 0;

    numBins = std::clamp(numBins, 32, 4096);

    ProjectLoader::StreamCursor cursor = loader.openStream(archivePath, error);
    if (!cursor.isValid())
        return false;

    auto readFn = [&](void* buf, size_t n) -> size_t { return cursor.read(buf, n); };

    WavStreamDecoder decoder;
    if (!decoder.parseHeader(readFn, error))
        return false;

    numChannels = decoder.numChannels();
    const int64_t total = decoder.totalFrames();
    const double sr = decoder.sampleRate();
    if (numChannels <= 0 || total <= 0 || sr <= 0.0) {
        error = "Empty or invalid WAV for peak overview: " + archivePath;
        return false;
    }
    durationSeconds = static_cast<double>(total) / sr;

    peaks.assign(static_cast<size_t>(numBins), 0.0f);

    // Decode in chunks; map each frame to a bin via absolute position.
    constexpr int64_t kChunk = 4096;
    std::vector<std::vector<float>> planar(static_cast<size_t>(numChannels));
    for (auto& ch : planar)
        ch.resize(static_cast<size_t>(kChunk));
    std::vector<float*> ptrs(static_cast<size_t>(numChannels));
    for (int c = 0; c < numChannels; ++c)
        ptrs[static_cast<size_t>(c)] = planar[static_cast<size_t>(c)].data();

    int64_t framePos = 0;
    while (framePos < total) {
        const int64_t got = decoder.decodeFrames(readFn, ptrs.data(), kChunk);
        if (got <= 0)
            break;

        for (int64_t i = 0; i < got; ++i) {
            float peak = 0.0f;
            for (int c = 0; c < numChannels; ++c)
                peak = std::max(peak, std::abs(planar[static_cast<size_t>(c)][static_cast<size_t>(i)]));

            const int bin = static_cast<int>((framePos + i) * numBins / total);
            const int b = std::clamp(bin, 0, numBins - 1);
            peaks[static_cast<size_t>(b)] = std::max(peaks[static_cast<size_t>(b)], peak);
        }
        framePos += got;
    }

    return true;
}

} // namespace resoset
