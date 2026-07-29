#include "doctest.h"

#include "audio/WavStreamDecoder.h"

#include <cmath>
#include <cstring>
#include <vector>

using namespace resostage;

namespace {

constexpr double kPi = 3.14159265358979323846;

void appendU32(std::vector<uint8_t>& b, uint32_t v) {
    b.push_back(static_cast<uint8_t>(v & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 16) & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 24) & 0xFF));
}
void appendU16(std::vector<uint8_t>& b, uint16_t v) {
    b.push_back(static_cast<uint8_t>(v & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
}
void appendTag(std::vector<uint8_t>& b, const char* tag) {
    b.insert(b.end(), tag, tag + 4);
}

// Builds a WAV byte buffer for `frames` samples of a sine at `freqHz`, with
// a given bit depth (16/24/32 PCM, or 32 float via isFloat).
std::vector<uint8_t> makeWav(int channels, double sampleRate, int frames, int bitsPerSample, bool isFloat,
                              double freqHz = 440.0, float amplitude = 0.5f) {
    const uint16_t audioFormat = isFloat ? 3 : 1;
    const int bytesPerSample = bitsPerSample / 8;
    const uint32_t dataSize = static_cast<uint32_t>(frames) * channels * bytesPerSample;

    std::vector<uint8_t> out;
    appendTag(out, "RIFF");
    appendU32(out, 36 + dataSize);
    appendTag(out, "WAVE");
    appendTag(out, "fmt ");
    appendU32(out, 16);
    appendU16(out, audioFormat);
    appendU16(out, static_cast<uint16_t>(channels));
    appendU32(out, static_cast<uint32_t>(sampleRate));
    appendU32(out, static_cast<uint32_t>(sampleRate) * channels * bytesPerSample);
    appendU16(out, static_cast<uint16_t>(channels * bytesPerSample));
    appendU16(out, static_cast<uint16_t>(bitsPerSample));
    appendTag(out, "data");
    appendU32(out, dataSize);

    for (int i = 0; i < frames; ++i) {
        for (int ch = 0; ch < channels; ++ch) {
            const float s = amplitude * static_cast<float>(std::sin(2.0 * kPi * freqHz * i / sampleRate));
            if (isFloat) {
                uint8_t bytes[4];
                std::memcpy(bytes, &s, 4);
                out.insert(out.end(), bytes, bytes + 4);
            } else if (bitsPerSample == 16) {
                const int16_t v = static_cast<int16_t>(s * 32767.0f);
                appendU16(out, static_cast<uint16_t>(v));
            } else if (bitsPerSample == 24) {
                const int32_t v = static_cast<int32_t>(s * 8388607.0f);
                out.push_back(static_cast<uint8_t>(v & 0xFF));
                out.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
                out.push_back(static_cast<uint8_t>((v >> 16) & 0xFF));
            } else if (bitsPerSample == 32) {
                const int32_t v = static_cast<int32_t>(s * 2147483647.0);
                appendU32(out, static_cast<uint32_t>(v));
            }
        }
    }

    return out;
}

// Wraps an in-memory byte buffer as a ReadFn that only ever returns up to
// `chunkSize` bytes per call, forcing the decoder to cope with partial reads
// split arbitrarily across calls (the real StreamCursor behaves similarly).
struct ChunkedReader {
    const std::vector<uint8_t>& data;
    size_t pos = 0;
    size_t chunkSize;

    size_t operator()(void* buf, size_t bufSize) {
        if (pos >= data.size())
            return 0;
        const size_t n = std::min({bufSize, chunkSize, data.size() - pos});
        std::memcpy(buf, data.data() + pos, n);
        pos += n;
        return n;
    }
};

// WavStreamDecoder::ReadFn is a std::function; passing a stateful callable
// (like ChunkedReader) directly at each call site would implicitly convert
// -- i.e. COPY -- it into a fresh std::function every time, silently
// resetting `pos` between parseHeader()/decodeFrames() calls. Wrap it once
// in a reference-capturing lambda so all calls share the same cursor state
// (this is exactly how the real StreamCursor-backed usage in
// StreamingTrackBuffer shares state, by capturing `this` instead of copying).
WavStreamDecoder::ReadFn asReadFn(ChunkedReader& reader) {
    return [&reader](void* buf, size_t bufSize) { return reader(buf, bufSize); };
}

} // namespace

TEST_CASE("WavStreamDecoder parses 16-bit PCM header and decodes matching samples") {
    const int frames = 1000;
    auto wav = makeWav(2, 48000.0, frames, 16, false, 440.0, 0.5f);
    ChunkedReader reader{wav, 0, 7}; // deliberately awkward chunk size
    auto readFn = asReadFn(reader);

    WavStreamDecoder decoder;
    std::string error;
    REQUIRE(decoder.parseHeader(readFn, error));
    CHECK(decoder.numChannels() == 2);
    CHECK(decoder.sampleRate() == 48000.0);
    CHECK(decoder.totalFrames() == frames);

    std::vector<float> left(static_cast<size_t>(frames)), right(static_cast<size_t>(frames));
    float* channels[2] = {left.data(), right.data()};
    const int64_t got = decoder.decodeFrames(readFn, channels, frames);
    REQUIRE(got == frames);

    for (int i = 0; i < frames; ++i) {
        const float expected = 0.5f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * i / 48000.0));
        CHECK(std::abs(left[static_cast<size_t>(i)] - expected) < 0.001f);
        CHECK(left[static_cast<size_t>(i)] == right[static_cast<size_t>(i)]);
    }

    // Fully consumed: another decode call returns 0.
    CHECK(decoder.decodeFrames(readFn, channels, frames) == 0);
}

TEST_CASE("WavStreamDecoder handles 24-bit PCM") {
    const int frames = 500;
    auto wav = makeWav(1, 44100.0, frames, 24, false, 220.0, 0.8f);
    ChunkedReader reader{wav, 0, 4096};
    auto readFn = asReadFn(reader);

    WavStreamDecoder decoder;
    std::string error;
    REQUIRE(decoder.parseHeader(readFn, error));
    CHECK(decoder.numChannels() == 1);
    CHECK(decoder.sampleRate() == 44100.0);

    std::vector<float> mono(static_cast<size_t>(frames));
    float* channels[1] = {mono.data()};
    REQUIRE(decoder.decodeFrames(readFn, channels, frames) == frames);

    for (int i = 0; i < frames; ++i) {
        const float expected = 0.8f * static_cast<float>(std::sin(2.0 * kPi * 220.0 * i / 44100.0));
        CHECK(std::abs(mono[static_cast<size_t>(i)] - expected) < 0.0001f);
    }
}

TEST_CASE("WavStreamDecoder handles 32-bit IEEE float") {
    const int frames = 300;
    auto wav = makeWav(1, 48000.0, frames, 32, true, 660.0, 0.9f);
    ChunkedReader reader{wav, 0, 4096};
    auto readFn = asReadFn(reader);

    WavStreamDecoder decoder;
    std::string error;
    REQUIRE(decoder.parseHeader(readFn, error));

    std::vector<float> mono(static_cast<size_t>(frames));
    float* channels[1] = {mono.data()};
    REQUIRE(decoder.decodeFrames(readFn, channels, frames) == frames);

    for (int i = 0; i < frames; ++i) {
        const float expected = 0.9f * static_cast<float>(std::sin(2.0 * kPi * 660.0 * i / 48000.0));
        CHECK(std::abs(mono[static_cast<size_t>(i)] - expected) < 0.00001f);
    }
}

TEST_CASE("WavStreamDecoder decodeFrames respects maxFrames across multiple calls") {
    const int frames = 1000;
    auto wav = makeWav(1, 48000.0, frames, 16, false);
    ChunkedReader reader{wav, 0, 4096};
    auto readFn = asReadFn(reader);

    WavStreamDecoder decoder;
    std::string error;
    REQUIRE(decoder.parseHeader(readFn, error));

    std::vector<float> chunk(100);
    float* channels[1] = {chunk.data()};

    int64_t totalDecoded = 0;
    int64_t got = 0;
    do {
        got = decoder.decodeFrames(readFn, channels, 100);
        totalDecoded += got;
    } while (got > 0);

    CHECK(totalDecoded == frames);
}

TEST_CASE("WavStreamDecoder rejects a non-RIFF buffer") {
    std::vector<uint8_t> garbage = {'n', 'o', 't', 'a', 'w', 'a', 'v', 'x', 'x', 'x', 'x', 'x'};
    ChunkedReader reader{garbage, 0, 4096};
    auto readFn = asReadFn(reader);
    WavStreamDecoder decoder;
    std::string error;
    CHECK_FALSE(decoder.parseHeader(readFn, error));
    CHECK_FALSE(error.empty());
}
