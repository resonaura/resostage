#include "PeakCache.h"

#include <cstring>

namespace resostage {

namespace {
void appendU32(std::vector<uint8_t>& out, uint32_t v) {
    out.push_back(static_cast<uint8_t>(v));
    out.push_back(static_cast<uint8_t>(v >> 8));
    out.push_back(static_cast<uint8_t>(v >> 16));
    out.push_back(static_cast<uint8_t>(v >> 24));
}
void appendI32(std::vector<uint8_t>& out, int32_t v) {
    appendU32(out, static_cast<uint32_t>(v));
}
void appendF64(std::vector<uint8_t>& out, double v) {
    static_assert(sizeof(double) == 8, "unexpected double size");
    uint8_t bytes[8];
    std::memcpy(bytes, &v, 8);
    out.insert(out.end(), bytes, bytes + 8);
}
void appendF32(std::vector<uint8_t>& out, float v) {
    uint8_t bytes[4];
    std::memcpy(bytes, &v, 4);
    out.insert(out.end(), bytes, bytes + 4);
}
bool readU32(const uint8_t*& p, const uint8_t* end, uint32_t& v) {
    if (end - p < 4)
        return false;
    v = static_cast<uint32_t>(p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24));
    p += 4;
    return true;
}
bool readI32(const uint8_t*& p, const uint8_t* end, int32_t& v) {
    uint32_t u = 0;
    if (!readU32(p, end, u))
        return false;
    v = static_cast<int32_t>(u);
    return true;
}
bool readF64(const uint8_t*& p, const uint8_t* end, double& v) {
    if (end - p < 8)
        return false;
    std::memcpy(&v, p, 8);
    p += 8;
    return true;
}
bool readF32(const uint8_t*& p, const uint8_t* end, float& v) {
    if (end - p < 4)
        return false;
    std::memcpy(&v, p, 4);
    p += 4;
    return true;
}
} // namespace

std::string PeakCache::cacheEntryPath(const std::string& audioArchivePath) {
    std::string key = audioArchivePath;
    for (char& c : key) {
        if (c == '/' || c == '\\' || c == ' ')
            c = '_';
    }
    return "Peaks/" + key + ".rpk";
}

std::vector<uint8_t> PeakCache::serialize(const PeakOverview& overview) {
    std::vector<uint8_t> out;
    out.insert(out.end(), kMagic, kMagic + 4);
    appendF64(out, overview.durationSeconds);
    appendI32(out, overview.numChannels);
    appendU32(out, static_cast<uint32_t>(overview.levels.size()));
    for (const auto& level : overview.levels) {
        appendI32(out, level.samplesPerBin);
        appendU32(out, static_cast<uint32_t>(level.bins.size()));
        for (const auto& bin : level.bins)
            appendF32(out, bin.minVal);
        for (const auto& bin : level.bins)
            appendF32(out, bin.maxVal);
        for (const auto& bin : level.bins)
            appendF32(out, bin.rms);
    }
    return out;
}

bool PeakCache::deserialize(const uint8_t* data, size_t size, PeakOverview& out, std::string& error) {
    out = PeakOverview{};
    if (data == nullptr || size < 4 + 8 + 4 + 4) {
        error = "Peak cache too short";
        return false;
    }
    if (std::memcmp(data, kMagic, 4) != 0) {
        error = "Peak cache bad magic or old format";
        return false;
    }
    const uint8_t* p = data + 4;
    const uint8_t* end = data + size;
    if (!readF64(p, end, out.durationSeconds)) {
        error = "Peak cache bad duration";
        return false;
    }
    int32_t ch = 0;
    if (!readI32(p, end, ch)) {
        error = "Peak cache bad channel count";
        return false;
    }
    out.numChannels = ch;
    uint32_t numLevels = 0;
    if (!readU32(p, end, numLevels) || numLevels > 16) {
        error = "Peak cache bad level count";
        return false;
    }
    out.levels.resize(numLevels);
    for (auto& level : out.levels) {
        int32_t samplesPerBin = 0;
        if (!readI32(p, end, samplesPerBin)) {
            error = "Peak cache bad level header";
            return false;
        }
        level.samplesPerBin = samplesPerBin;
        uint32_t numBins = 0;
        if (!readU32(p, end, numBins) || numBins > (1u << 20)) {
            error = "Peak cache bad bin count";
            return false;
        }
        level.bins.resize(numBins);
        for (uint32_t i = 0; i < numBins; ++i)
            if (!readF32(p, end, level.bins[i].minVal)) {
                error = "Peak cache truncated min values";
                return false;
            }
        for (uint32_t i = 0; i < numBins; ++i)
            if (!readF32(p, end, level.bins[i].maxVal)) {
                error = "Peak cache truncated max values";
                return false;
            }
        for (uint32_t i = 0; i < numBins; ++i)
            if (!readF32(p, end, level.bins[i].rms)) {
                error = "Peak cache truncated rms values";
                return false;
            }
    }
    return true;
}

bool PeakCache::loadFromArchive(const ProjectLoader& loader, const std::string& audioArchivePath,
                                PeakOverview& out, std::string& error) {
    std::vector<uint8_t> bytes;
    if (!loader.extractFile(cacheEntryPath(audioArchivePath), bytes, error))
        return false;
    return deserialize(bytes.data(), bytes.size(), out, error);
}

ProjectLoader::ExtraFile PeakCache::makeCacheExtra(const PeakOverview& overview,
                                                   const std::string& audioArchivePath) {
    ProjectLoader::ExtraFile extra;
    extra.archivePath = cacheEntryPath(audioArchivePath);
    extra.data = serialize(overview);
    return extra;
}

} // namespace resostage
