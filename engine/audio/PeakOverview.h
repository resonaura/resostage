#pragma once

#include "../project/ProjectLoader.h"

#include <cstdint>
#include <string>
#include <vector>

namespace resoset {

// Compact max-abs peak bins for timeline waveform drawing. Built offline
// (message / background thread) by streaming the WAV once through
// WavStreamDecoder -- never touches the audio callback.
struct PeakOverview {
    std::vector<float> peaks; // 0..1, one max-abs value per bin
    double durationSeconds = 0.0;
    int numChannels = 0;
    float baseline = 0.5f; // 0..1, zero-crossing level (0.5 = centered)

    // Streams `archivePath` from the open ProjectLoader into `numBins` peak
    // bins (clamped 32..16384). Extracts the entire WAV to memory first for
    // fast bulk decompression. Returns false on open/decode failure.
    bool build(const ProjectLoader& loader, const std::string& archivePath,
               int numBins, std::string& error);

    // Builds peak bins from an already-extracted WAV buffer (raw bytes).
    // Avoids the zip extraction step entirely; useful when multiple files
    // are extracted up front and then decoded in parallel.
    bool buildFromBuffer(const uint8_t* data, size_t size,
                         int numBins, std::string& error);
};

} // namespace resoset
