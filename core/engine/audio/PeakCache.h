#pragma once

#include "PeakOverview.h"

#include <cstdint>
#include <string>
#include <vector>

namespace resostage {

// On-disk peak overview format stored inside .rsnraset as
//   Peaks/<sanitized-audio-path>.rsnrapeak
//
// Binary little-endian:
//   char magic[4] = "RSN1"
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
// of a stem naturally invalidates the old file when the path changes. Anything
// that isn't this exact extension + magic (the older .rpk "RPK2"/"RPK3" files)
// is simply a cache miss and gets rebuilt in the background -- peaks are
// derived data, never worth a bit-for-bit migration.
struct PeakCache {
    static constexpr char kMagic[4] = {'R', 'S', 'N', '1'};

    // "Audio/song1_kick.wav" -> "Peaks/Audio_song1_kick.wav.rsnrapeak"
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
