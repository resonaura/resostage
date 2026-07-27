#pragma once

#include "PeakOverview.h"

#include <cstdint>
#include <string>
#include <vector>

namespace resoset {

// On-disk peak overview format stored inside .rsnraset as
//   Peaks/<sanitized-audio-path>.rpk
//
// Binary little-endian:
//   char magic[4] = "RPK2"
//   uint32_t numBins
//   double durationSeconds
//   int32_t numChannels
//   float baseline
//   float peaks[numBins]
//
// Cache key is derived from the archive-relative audio path so import/replace
// of a stem naturally invalidates the old file when the path changes.
struct PeakCache {
    static constexpr char kMagic[4] = {'R', 'P', 'K', '2'};

    // "Audio/song1_kick.wav" -> "Peaks/Audio_song1_kick.wav.rpk"
    static std::string cacheEntryPath(const std::string& audioArchivePath);

    static std::vector<uint8_t> serialize(const PeakOverview& overview);
    static bool deserialize(const uint8_t* data, size_t size, PeakOverview& out, std::string& error);

    // Load from open archive; returns false if missing/corrupt.
    static bool loadFromArchive(const ProjectLoader& loader, const std::string& audioArchivePath,
                                PeakOverview& out, std::string& error);

    // Build overview (or load cache), then return ExtraFile for saveAsWithExtras
    // so the next open hits disk cache. `built` is set when decode ran.
    static ProjectLoader::ExtraFile makeCacheExtra(const PeakOverview& overview,
                                                   const std::string& audioArchivePath);
};

} // namespace resoset
