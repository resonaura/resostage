#pragma once

#include "../project/ProjectLoader.h"

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

    // Streams `archivePath` from the open ProjectLoader into `numBins` peak
    // bins (clamped 32..4096). Returns false on open/decode failure.
    bool build(const ProjectLoader& loader, const std::string& archivePath,
               int numBins, std::string& error);
};

} // namespace resoset
