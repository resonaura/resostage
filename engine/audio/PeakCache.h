#pragma once

#include "PeakOverview.h"

#include <cstdint>
#include <string>
#include <vector>

namespace resostage {

// On-disk peak overview format stored inside .rsnraset as
//   Peaks/<sanitized-audio-path>.rpk
//
// Binary little-endian:
//   char magic[4] = "RPK3"
//   double durationSeconds
//   int32_t numChannels
//   uint32_t numLevels
//   per level:
//     int32_t samplesPerBin
//     uint32_t numBins
//     float minVal[numBins]
//     float maxVal[numBins]
//     float rms[numBins]
//
// Cache key is derived from the archive-relative audio path so import/replace
// of a stem naturally invalidates the old file when the path changes. Files
// written by the older single-resolution "RPK2" format are treated as a
// cache miss and rebuilt -- cheap, not worth a bit-for-bit migration.
struct PeakCache {
    static constexpr char kMagic[4] = {'R', 'P', 'K', '3'};

    // "Audio/song1_kick.wav" -> "Peaks/Audio_song1_kick.wav.rpk"
    static std::string cacheEntryPath(const std::string& audioArchivePath);

    static std::vector<uint8_t> serialize(const PeakOverview& overview);
    static bool deserialize(const uint8_t* data, size_t size, PeakOverview& out, std::string& error);

    // Load from open archive; returns false if missing/corrupt/old-format.
    static bool loadFromArchive(const ProjectLoader& loader, const std::string& audioArchivePath,
                                PeakOverview& out, std::string& error);

    // Build overview (or load cache), then return ExtraFile for saveAsWithExtras
    // so the next open hits disk cache. `built` is set when decode ran.
    static ProjectLoader::ExtraFile makeCacheExtra(const PeakOverview& overview,
                                                   const std::string& audioArchivePath);
};

} // namespace resostage
