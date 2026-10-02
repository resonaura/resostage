/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "OfflineRenderer.h"

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace resostage::offline_detail {

/** Streaming WAV writer used by the offline renderer's finalization pass. */
class WAVWriter {
public:
    ~WAVWriter();

    bool open(const std::string& path, int sampleRate, int bitDepth,
              RenderDither dither, RenderNormalization normalization,
              double ceilingDb, std::string& error);
    bool write(const float* left, const float* right, int frames);
    bool finish(std::string& error);
    void abort();

private:
    bool writeEmptyHeader();
    float randomUnit();
    bool writeEncoded(const float* left, const float* right, int frames, float gain);
    bool finalizeWAVFile();
    bool finalizeWavFile() { return finalizeWAVFile(); }

    FILE* file = nullptr;
    int sampleRate_ = 48000;
    int bitDepth_ = 24;
    uint64_t dataBytes = 0;
    float peak = 0.0f;
    float ceilingLinear = 1.0f;
    RenderDither dither_ = RenderDither::None;
    RenderNormalization normalization_ = RenderNormalization::Off;
    uint32_t randomState = 0x9e3779b9u;
    std::string finalPath;
    std::string partPath;
    std::string rawPath;
    bool partCreated = false;
    bool rawCreated = false;
    std::vector<uint8_t> scratch;
    std::vector<float> floatScratch;
    std::vector<float> planarL;
    std::vector<float> planarR;
};

// Canonical acronym spelling alias
using WavWriter = WAVWriter;

} // namespace resostage::offline_detail
