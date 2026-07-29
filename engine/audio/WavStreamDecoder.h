#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace resoset {

// Incremental WAV parser + PCM/float decoder, fed by a pull-based byte reader
// (so it can be driven by ProjectLoader::StreamCursor in production, or an
// in-memory buffer in tests, without depending on either). Forward-only: no
// seeking backward is required or supported, matching sequential playback.
//
// Scope: canonical WAV layout (RIFF/WAVE, 'fmt ' chunk before 'data' chunk --
// true of essentially every DAW-exported stem). Supports 16/24/32-bit signed
// integer PCM and 32-bit IEEE float, mono or multi-channel. Does NOT handle
// WAVE_FORMAT_EXTENSIBLE sub-format quirks, compressed WAV codecs, or
// non-canonical chunk ordering (e.g. 'data' before 'fmt ') -- a documented
// limitation, not needed for exported DAW stems.
class WavStreamDecoder {
public:
    using ReadFn = std::function<size_t(void* buf, size_t bufSize)>; // returns bytes read; 0 = EOF

    // Parses RIFF/WAVE/'fmt ' chunks (skipping any other chunks) until the
    // 'data' chunk header is found. Leaves the read cursor positioned at the
    // start of the data chunk's payload. Returns false on malformed/unsupported input.
    bool parseHeader(const ReadFn& read, std::string& error);

    int numChannels() const { return channels; }
    double sampleRate() const { return sampleRateHz; }
    int bytesPerFrame() const { return channels * (bitsPerSample / 8); }
    int64_t totalFrames() const { return bytesPerFrame() > 0 ? static_cast<int64_t>(dataChunkBytesTotal) / bytesPerFrame() : 0; }

    // Decodes up to maxFrames frames into planar `outChannels` (numChannels()
    // entries, each with room for at least maxFrames floats). Returns frames
    // actually decoded; 0 means the data chunk is exhausted (or EOF/error).
    int64_t decodeFrames(const ReadFn& read, float* const* outChannels, int64_t maxFrames);

    // After the byte cursor has been seeked back to the start of the 'data'
    // payload, call this so decodeFrames reads the full chunk again. No
    // re-parse of the WAV header.
    void resetDataCursor() { dataChunkBytesRemaining = dataChunkBytesTotal; }

private:
    int channels = 0;
    double sampleRateHz = 0.0;
    uint16_t audioFormat = 0; // 1 = PCM, 3 = IEEE float
    uint16_t bitsPerSample = 0;
    uint64_t dataChunkBytesRemaining = 0;
    uint64_t dataChunkBytesTotal = 0;

    std::vector<uint8_t> rawScratch; // reused decode scratch buffer (grows on demand)
};

} // namespace resoset
