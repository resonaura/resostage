/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "WAVStreamDecoder.h"

#include <algorithm>
#include <cstring>
#include <limits>

namespace resostage {

namespace {

bool readExact(const WAVStreamDecoder::ReadFn& read, void* buf, size_t size) {
    uint8_t* p = static_cast<uint8_t*>(buf);
    size_t total = 0;
    while (total < size) {
        const size_t got = read(p + total, size - total);
        if (got == 0)
            return false;
        total += got;
    }
    return true;
}

uint16_t readU16LE(const uint8_t* p) {
    return static_cast<uint16_t>(p[0] | (p[1] << 8));
}

uint32_t readU32LE(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

uint64_t readU64LE(const uint8_t* p) {
    return static_cast<uint64_t>(readU32LE(p))
        | (static_cast<uint64_t>(readU32LE(p + 4)) << 32);
}

bool skipBytes(const WAVStreamDecoder::ReadFn& read, uint64_t count) {
    uint8_t discard[256];
    while (count > 0) {
        const size_t chunk = static_cast<size_t>(std::min<uint64_t>(count, sizeof(discard)));
        if (!readExact(read, discard, chunk))
            return false;
        count -= chunk;
    }
    return true;
}

} // namespace

bool WAVStreamDecoder::parseHeader(const ReadFn& read, std::string& error) {
    channels = 0;
    sampleRateHz = 0.0;
    dataChunkBytesTotal = dataChunkBytesRemaining = 0;
    uint8_t riffHeader[12];
    if (!readExact(read, riffHeader, sizeof(riffHeader))) {
        error = "Truncated RIFF header";
        return false;
    }
    const bool isRF64 = std::memcmp(riffHeader, "RF64", 4) == 0;
    if ((!isRF64 && std::memcmp(riffHeader, "RIFF", 4) != 0)
        || std::memcmp(riffHeader + 8, "WAVE", 4) != 0) {
        error = "Not a RIFF/RF64 WAVE file";
        return false;
    }

    bool haveFmt = false;
    bool haveDs64 = false;
    uint64_t rf64DataBytes = 0;
    for (;;) {
        uint8_t chunkHeader[8];
        if (!readExact(read, chunkHeader, sizeof(chunkHeader))) {
            error = "Truncated chunk header (no data chunk found)";
            return false;
        }
        char id[5] = {0, 0, 0, 0, 0};
        std::memcpy(id, chunkHeader, 4);
        const uint32_t chunkSize = readU32LE(chunkHeader + 4);

        if (isRF64 && std::memcmp(id, "ds64", 4) == 0) {
            uint8_t ds64[28];
            if (haveDs64 || chunkSize < sizeof(ds64)
                || !readExact(read, ds64, sizeof(ds64))
                || !skipBytes(read, chunkSize - sizeof(ds64) + (chunkSize % 2))) {
                error = "Invalid RF64 ds64 chunk";
                return false;
            }
            rf64DataBytes = readU64LE(ds64 + 8);
            if (rf64DataBytes > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
                error = "RF64 data exceeds the supported frame-count range";
                return false;
            }
            haveDs64 = true;
        } else if (std::memcmp(id, "fmt ", 4) == 0) {
            if (chunkSize < 16) {
                error = "fmt chunk too small";
                return false;
            }
            uint8_t fmtBuf[16];
            if (!readExact(read, fmtBuf, sizeof(fmtBuf))) {
                error = "Truncated fmt chunk";
                return false;
            }
            audioFormat = readU16LE(fmtBuf + 0);
            channels = readU16LE(fmtBuf + 2);
            sampleRateHz = static_cast<double>(readU32LE(fmtBuf + 4));
            bitsPerSample = readU16LE(fmtBuf + 14);

            const uint32_t extra = chunkSize - 16;
            if (!skipBytes(read, extra)) {
                error = "Truncated fmt chunk extension";
                return false;
            }
            if (chunkSize % 2 != 0 && !skipBytes(read, 1)) {
                error = "Truncated fmt chunk pad byte";
                return false;
            }
            haveFmt = true;
        } else if (std::memcmp(id, "data", 4) == 0) {
            if (!haveFmt) {
                error = "'data' chunk appeared before 'fmt ' chunk (unsupported)";
                return false;
            }
            if (audioFormat != 1 && audioFormat != 3) {
                error = "Unsupported WAV audio format code " + std::to_string(audioFormat);
                return false;
            }
            if (bitsPerSample != 16 && bitsPerSample != 24 && bitsPerSample != 32) {
                error = "Unsupported bits per sample: " + std::to_string(bitsPerSample);
                return false;
            }
            if (channels <= 0 || channels > 64 || sampleRateHz <= 0.0) {
                error = "Invalid sample rate or unsupported channel count (maximum 64)";
                return false;
            }
            if (isRF64 && (!haveDs64 || chunkSize != UINT32_MAX)) {
                error = "RF64 data requires ds64 and a sentinel data size";
                return false;
            }

            dataChunkBytesTotal = isRF64 ? rf64DataBytes : chunkSize;
            dataChunkBytesRemaining = dataChunkBytesTotal;
            return true;
        } else {
            if (!skipBytes(read, static_cast<uint64_t>(chunkSize) + (chunkSize % 2))) {
                error = "Truncated chunk while skipping '" + std::string(id) + "'";
                return false;
            }
        }
    }
}

int64_t WAVStreamDecoder::decodeFrames(const ReadFn& read, float* const* outChannels, int64_t maxFrames) {
    if (dataChunkBytesRemaining == 0 || maxFrames <= 0)
        return 0;

    const int bpf = bytesPerFrame();
    if (bpf <= 0)
        return 0;

    const int64_t framesAvailable = static_cast<int64_t>(dataChunkBytesRemaining) / bpf;
    const int64_t framesToRead = std::min(maxFrames, framesAvailable);
    if (framesToRead <= 0)
        return 0;

    const size_t bytesNeeded = static_cast<size_t>(framesToRead) * static_cast<size_t>(bpf);
    if (rawScratch.size() < bytesNeeded)
        rawScratch.resize(bytesNeeded);

    size_t gotTotal = 0;
    while (gotTotal < bytesNeeded) {
        const size_t got = read(rawScratch.data() + gotTotal, bytesNeeded - gotTotal);
        if (got == 0)
            break;
        gotTotal += got;
    }

    const int64_t framesGot = static_cast<int64_t>(gotTotal) / bpf;
    dataChunkBytesRemaining -= static_cast<uint64_t>(framesGot) * static_cast<uint64_t>(bpf);

    const int bytesPerSample = bitsPerSample / 8;
    const uint8_t* src = rawScratch.data();

    for (int64_t f = 0; f < framesGot; ++f) {
        for (int ch = 0; ch < channels; ++ch) {
            const uint8_t* s = src + static_cast<size_t>(f) * static_cast<size_t>(bpf) +
                                static_cast<size_t>(ch) * static_cast<size_t>(bytesPerSample);
            float value = 0.0f;

            if (audioFormat == 3 && bitsPerSample == 32) {
                float fv;
                std::memcpy(&fv, s, sizeof(float));
                value = fv;
            } else if (bitsPerSample == 16) {
                const int16_t iv = static_cast<int16_t>(s[0] | (s[1] << 8));
                value = static_cast<float>(iv) / 32768.0f;
            } else if (bitsPerSample == 24) {
                int32_t iv = static_cast<int32_t>(s[0]) | (static_cast<int32_t>(s[1]) << 8) | (static_cast<int32_t>(s[2]) << 16);
                if ((iv & 0x800000) != 0)
                    iv |= static_cast<int32_t>(0xFF000000);
                value = static_cast<float>(iv) / 8388608.0f;
            } else if (bitsPerSample == 32) {
                int32_t iv;
                std::memcpy(&iv, s, sizeof(int32_t));
                value = static_cast<float>(iv) / 2147483648.0f;
            }

            outChannels[ch][f] = value;
        }
    }

    return framesGot;
}

} // namespace resostage
