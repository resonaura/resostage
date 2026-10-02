/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "OfflineWAVWriter.h"
#include "OfflineOutputFile.h"
#include "project/Uuid.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>

namespace resostage::offline_detail {
namespace {

constexpr int kNormalizationBlockSize = 1024;

float dbToGain(double db) {
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

} // namespace

WAVWriter::~WAVWriter() { abort(); }

bool WAVWriter::open(const std::string& path, int sampleRate, int bitDepth,
                     RenderDither dither, RenderNormalization normalization,
                     double ceilingDb, std::string& error) {
    finalPath = path;
    const std::string uniqueSuffix = "-" + generateUUIDv7();
    partPath = path + ".resostage-part" + uniqueSuffix;
    rawPath = path + ".resostage-float-part" + uniqueSuffix;
    sampleRate_ = sampleRate;
    bitDepth_ = bitDepth;
    dither_ = dither;
    normalization_ = normalization;
    ceilingLinear = dbToGain(std::clamp(ceilingDb, -12.0, 0.0));
    std::error_code ignored;
    if (std::filesystem::exists(outputFilePath(finalPath), ignored)) {
        error = "Output file already exists: " + finalPath;
        return false;
    }
    file = openOutputFile(normalization_ == RenderNormalization::Off
                              ? partPath : rawPath, "wbx");
    if (file == nullptr) {
        error = "Cannot create output file: " + path;
        return false;
    }
    partCreated = normalization_ == RenderNormalization::Off;
    rawCreated = normalization_ != RenderNormalization::Off;
    if (normalization_ == RenderNormalization::Off && !writeEmptyHeader()) {
        error = "Cannot write WAV header: " + path;
        abort();
        return false;
    }
    return true;
}

bool WAVWriter::write(const float* left, const float* right, int frames) {
    if (file == nullptr || frames <= 0) return false;
    for (int i = 0; i < frames; ++i)
        peak = std::max(peak, std::max(std::abs(left[i]), std::abs(right[i])));
    if (normalization_ == RenderNormalization::Off)
        return writeEncoded(left, right, frames, 1.0f);

    floatScratch.resize(static_cast<size_t>(frames * 2));
    for (int i = 0; i < frames; ++i) {
        floatScratch[static_cast<size_t>(i * 2)] = left[i];
        floatScratch[static_cast<size_t>(i * 2 + 1)] = right[i];
    }
    return std::fwrite(floatScratch.data(), sizeof(float), floatScratch.size(), file)
        == floatScratch.size();
}

bool WAVWriter::finish(std::string& error) {
    if (file == nullptr) { error = "Render writer is not open"; return false; }
    if (normalization_ == RenderNormalization::Off) {
        if (!finalizeWAVFile()) { error = "Failed to finalize output WAV"; return false; }
    } else {
        if (std::fclose(file) != 0) { file = nullptr; error = "Failed to close normalization pass"; return false; }
        file = nullptr;
        FILE* raw = openOutputFile(rawPath, "rb");
        file = openOutputFile(partPath, "wbx");
        partCreated = file != nullptr;
        if (raw == nullptr || file == nullptr || !writeEmptyHeader()) {
            if (raw != nullptr) std::fclose(raw);
            error = "Cannot start normalized WAV finalization";
            return false;
        }
        float gain = 1.0f;
        if (peak > 0.0f) {
            const float target = ceilingLinear;
            const float normalized = target / peak;
            gain = normalization_ == RenderNormalization::OverloadProtection
                ? std::min(1.0f, normalized) : normalized;
        }
        floatScratch.resize(static_cast<size_t>(kNormalizationBlockSize * 2));
        while (true) {
            const size_t samples = std::fread(floatScratch.data(), sizeof(float),
                                              floatScratch.size(), raw);
            if (samples == 0) break;
            const int frames = static_cast<int>(samples / 2);
            planarL.resize(static_cast<size_t>(frames));
            planarR.resize(static_cast<size_t>(frames));
            for (int i = 0; i < frames; ++i) {
                planarL[static_cast<size_t>(i)] = floatScratch[static_cast<size_t>(i * 2)];
                planarR[static_cast<size_t>(i)] = floatScratch[static_cast<size_t>(i * 2 + 1)];
            }
            if (!writeEncoded(planarL.data(), planarR.data(), frames, gain)) {
                std::fclose(raw);
                error = "Failed while normalizing output WAV";
                return false;
            }
        }
        const bool rawOk = std::ferror(raw) == 0;
        std::fclose(raw);
        if (!rawOk || !finalizeWAVFile()) {
            error = "Failed to finalize normalized WAV";
            return false;
        }
        std::error_code ignored;
        std::filesystem::remove(outputFilePath(rawPath), ignored);
        rawCreated = false;
    }

    std::error_code ec;
    if (!publishOutputFile(partPath, finalPath, ec)) {
        error = "Cannot publish rendered WAV: " + ec.message();
        return false;
    }
    partCreated = false;
    finalPath.clear();
    partPath.clear();
    rawPath.clear();
    return true;
}

void WAVWriter::abort() {
    if (file != nullptr) {
        std::fclose(file);
        file = nullptr;
    }
    std::error_code ignored;
    if (partCreated) std::filesystem::remove(outputFilePath(partPath), ignored);
    if (rawCreated) std::filesystem::remove(outputFilePath(rawPath), ignored);
    partCreated = false;
    rawCreated = false;
}

bool WAVWriter::writeEmptyHeader() {
    uint8_t empty[44]{};
    return std::fwrite(empty, 1, sizeof(empty), file) == sizeof(empty);
}

float WAVWriter::randomUnit() {
    randomState ^= randomState << 13u;
    randomState ^= randomState >> 17u;
    randomState ^= randomState << 5u;
    return static_cast<float>(randomState >> 8u) * (1.0f / 16777216.0f);
}

bool WAVWriter::writeEncoded(const float* left, const float* right, int frames, float gain) {
    const int bytes = bitDepth_ / 8;
    scratch.resize(static_cast<size_t>(frames * 2 * bytes));
    uint8_t* p = scratch.data();
    for (int i = 0; i < frames; ++i) {
        const float values[2] = {left[i], right[i]};
        for (float value : values) {
            value *= gain;
            if (bitDepth_ == 16) {
                if (dither_ == RenderDither::Tpdf)
                    value += (randomUnit() - randomUnit()) / 32768.0f;
                const float v = std::clamp(value, -1.0f, 1.0f);
                const int16_t s = static_cast<int16_t>(std::lrint(v * 32767.0f));
                std::memcpy(p, &s, 2); p += 2;
            } else if (bitDepth_ == 24) {
                if (dither_ == RenderDither::Tpdf)
                    value += (randomUnit() - randomUnit()) / 8388608.0f;
                const float v = std::clamp(value, -1.0f, 1.0f);
                const int32_t s = static_cast<int32_t>(std::lrint(v * 8388607.0f));
                *p++ = static_cast<uint8_t>(s);
                *p++ = static_cast<uint8_t>(s >> 8);
                *p++ = static_cast<uint8_t>(s >> 16);
            } else {
                // Float WAV is the archival/interchange path: preserve
                // overs exactly so downstream mastering can recover them.
                // Integer PCM necessarily clips at full scale above.
                std::memcpy(p, &value, 4); p += 4;
            }
        }
    }
    const size_t n = static_cast<size_t>(p - scratch.data());
    // Classic RIFF stores sizes as uint32. Refuse to silently wrap and
    // produce a corrupt file; RF64 can be added as an explicit format.
    if (dataBytes + n > static_cast<uint64_t>(UINT32_MAX) - 36u) return false;
    dataBytes += n;
    return std::fwrite(scratch.data(), 1, n, file) == n;
}

bool WAVWriter::finalizeWAVFile() {
    if (file == nullptr) return true;
    const uint16_t format = bitDepth_ == 32 ? 3 : 1;
    const uint16_t channels = 2;
    const uint32_t byteRate = static_cast<uint32_t>(sampleRate_ * channels * (bitDepth_ / 8));
    const uint16_t blockAlign = static_cast<uint16_t>(channels * (bitDepth_ / 8));
    const uint32_t riffSize = static_cast<uint32_t>(36 + dataBytes);
    const uint32_t dataSize = static_cast<uint32_t>(dataBytes);
    std::fseek(file, 0, SEEK_SET);
    std::fwrite("RIFF", 1, 4, file); std::fwrite(&riffSize, 4, 1, file);
    std::fwrite("WAVEfmt ", 1, 8, file);
    const uint32_t fmtSize = 16;
    std::fwrite(&fmtSize, 4, 1, file); std::fwrite(&format, 2, 1, file);
    std::fwrite(&channels, 2, 1, file);
    const uint32_t rate = static_cast<uint32_t>(sampleRate_);
    std::fwrite(&rate, 4, 1, file); std::fwrite(&byteRate, 4, 1, file);
    std::fwrite(&blockAlign, 2, 1, file);
    const uint16_t bits = static_cast<uint16_t>(bitDepth_);
    std::fwrite(&bits, 2, 1, file); std::fwrite("data", 1, 4, file);
    std::fwrite(&dataSize, 4, 1, file);
    const bool ok = std::fflush(file) == 0 && std::ferror(file) == 0;
    std::fclose(file);
    file = nullptr;
    return ok;
}

} // namespace resostage::offline_detail
