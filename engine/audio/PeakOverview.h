#pragma once

#include "../project/ProjectLoader.h"

#include <cstdint>
#include <string>
#include <vector>

namespace resoset {

// One bin's summary at a given pyramid level: true signed min/max (not
// abs-magnitude) so the drawn envelope reflects the real waveform shape and
// DC offset without a separate baseline correction, plus RMS for the
// "loudness" fill Reaper/Logic draw inside the min/max envelope.
struct PeakBin {
    float minVal = 0.0f;
    float maxVal = 0.0f;
    float rms = 0.0f;
};

struct PeakLevel {
    int samplesPerBin = 0; // source samples represented by one bin at this level
    std::vector<PeakBin> bins;
};

// Multi-resolution (mipmap) peak pyramid for fast waveform rendering at any
// zoom level -- mirrors Reaper's .reapeaks / Logic's .ovw approach: a handful
// of precomputed decimation levels let the UI pick the one closest to the
// current samples-per-pixel instead of rescanning raw PCM on every frame.
//
// Levels are ordered finest-to-coarsest. Unlike Reaper/Logic (which mmap a
// binary peak file directly in-process), this pyramid gets serialized to
// JSON and shipped to a browser over HTTP, so level 0 is deliberately kept
// small (bounded bin count, not a fixed sample-per-bin ratio) rather than
// scaling with file length -- an hours-long file would otherwise produce an
// impractically large payload. Zooming in further than level 0's resolution
// is handled by fetching a raw PCM window on demand for just the visible
// range (see WebServer's /api/v1/player/waveform-raw), not by growing this
// pyramid.
struct PeakOverview {
    std::vector<PeakLevel> levels;
    double durationSeconds = 0.0;
    int numChannels = 0;

    // Streams `archivePath` from the open ProjectLoader, decodes once, and
    // builds every pyramid level from that single pass. Extracts the entire
    // WAV to memory first for fast bulk decompression. Returns false on
    // open/decode failure.
    bool build(const ProjectLoader& loader, const std::string& archivePath, std::string& error);

    // Builds the pyramid from an already-extracted WAV buffer (raw bytes).
    // Avoids the zip extraction step entirely; useful when multiple files
    // are extracted up front and then decoded in parallel.
    bool buildFromBuffer(const uint8_t* data, size_t size, std::string& error);

    bool empty() const { return levels.empty(); }

    // The coarsest level whose samplesPerBin is still <= samplesPerPixel
    // (most detail without going finer than the zoom actually needs); falls
    // back to the finest level if even that is coarser than the zoom needs,
    // since that's the best available short of a raw-sample fetch.
    const PeakLevel* bestLevelForZoom(double samplesPerPixel) const;
};

} // namespace resoset
