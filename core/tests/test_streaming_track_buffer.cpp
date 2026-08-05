#include "doctest.h"

#include "audio/StreamingTrackBuffer.h"
#include "miniz.h"
#include "project/ProjectLoader.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

using namespace resostage;

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kSampleRate = 48000.0;
constexpr double kFreqHz = 440.0;
constexpr float kAmplitude = 0.5f;

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

float expectedSample(int64_t frameIndex) {
    return kAmplitude * static_cast<float>(std::sin(2.0 * kPi * kFreqHz * static_cast<double>(frameIndex) / kSampleRate));
}

std::vector<uint8_t> makeMonoWav16AtRate(int frames, double wavSampleRate) {
    const uint32_t dataSize = static_cast<uint32_t>(frames) * 2;
    std::vector<uint8_t> out;
    appendTag(out, "RIFF");
    appendU32(out, 36 + dataSize);
    appendTag(out, "WAVE");
    appendTag(out, "fmt ");
    appendU32(out, 16);
    appendU16(out, 1);
    appendU16(out, 1);
    appendU32(out, static_cast<uint32_t>(wavSampleRate));
    appendU32(out, static_cast<uint32_t>(wavSampleRate) * 2);
    appendU16(out, 2);
    appendU16(out, 16);
    appendTag(out, "data");
    appendU32(out, dataSize);
    for (int i = 0; i < frames; ++i) {
        const int16_t v = static_cast<int16_t>(expectedSample(i) * 32767.0f);
        appendU16(out, static_cast<uint16_t>(v));
    }
    return out;
}

// Builds a minimal .rsnraset-like archive with one mono WAV track and returns
// its temp file path. `frames` controls the WAV's length. Tests run
// sequentially (doctest default), so reusing one fixed path across TEST_CASEs
// is safe -- each ProjectLoader is closed (RAII) before the next test overwrites it.
std::string makeTestArchive(int frames, double wavSampleRate = kSampleRate) {
    const std::string fixedPath = std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp") +
                                   "/resoset_streaming_test.rsnraset";

    mz_zip_archive zip;
    std::memset(&zip, 0, sizeof(zip));
    mz_zip_writer_init_file(&zip, fixedPath.c_str(), 0);

    const std::string projectJson = R"({"formatVersion":1,"name":"t","sampleRate":48000,"busses":[],"songs":[]})";
    mz_zip_writer_add_mem(&zip, "project.json", projectJson.data(), projectJson.size(), MZ_BEST_SPEED);

    auto wav = makeMonoWav16AtRate(frames, wavSampleRate);
    mz_zip_writer_add_mem(&zip, "Audio/tone.wav", wav.data(), wav.size(), MZ_BEST_SPEED);

    mz_zip_writer_finalize_archive(&zip);
    mz_zip_writer_end(&zip);
    return fixedPath;
}

} // namespace

TEST_CASE("StreamingTrackBuffer streams sequential audio correctly via refill()+read()") {
    const int totalFrames = 20000;
    const std::string path = makeTestArchive(totalFrames);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    StreamingTrackBuffer track;
    REQUIRE(track.open(loader, "Audio/tone.wav", 4096, kSampleRate, error));
    CHECK(track.numChannels() == 1);
    CHECK(track.totalFrames() == totalFrames);

    // Prime the ring buffer (simulates the background I/O thread running ahead).
    for (int i = 0; i < 20; ++i)
        track.refill();

    int64_t position = 0;
    std::vector<float> buf(500);
    float* channels[1] = {buf.data()};

    int64_t totalRead = 0;
    while (totalRead < totalFrames) {
        // Keep priming as we consume, like the real background thread would.
        track.refill();
        const int64_t got = track.read(channels, 500, position);
        for (int64_t i = 0; i < got; ++i)
            CHECK(std::abs(buf[static_cast<size_t>(i)] - expectedSample(position + i)) < 0.001f);
        position += got;
        totalRead += got;
        if (got == 0)
            track.refill(); // give the "background thread" another chance
    }

    CHECK(totalRead == totalFrames);
}

TEST_CASE("StreamingTrackBuffer catch-up: big forward jump produces silence then resumes at correct position") {
    const int totalFrames = 96000; // 2 seconds @ 48kHz
    const std::string path = makeTestArchive(totalFrames);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    StreamingTrackBuffer track;
    REQUIRE(track.open(loader, "Audio/tone.wav", 4096, kSampleRate, error)); // ring capacity smaller than the jump below

    for (int i = 0; i < 5; ++i)
        track.refill();

    std::vector<float> buf(500);
    float* channels[1] = {buf.data()};

    // Normal read of the first block.
    int64_t got = track.read(channels, 500, 0);
    REQUIRE(got == 500);
    CHECK(std::abs(buf[0] - expectedSample(0)) < 0.001f);

    // Simulate a stall: MasterClock jumps far ahead, well beyond the 4096-frame
    // ring buffer's lookahead, requiring a background skip-at-source.
    const int64_t jumpTo = 50000;
    got = track.read(channels, 500, jumpTo);
    CHECK(got == 0); // nothing buffered yet at the new position -> silence, not stale audio

    // Let the "background thread" service the pending skip + refill.
    for (int i = 0; i < 50 && got == 0; ++i) {
        track.refill();
        got = track.read(channels, 500, jumpTo + 500 * 0); // same expected position each retry until data arrives
    }
    REQUIRE(got > 0);
    for (int64_t i = 0; i < got; ++i)
        CHECK(std::abs(buf[static_cast<size_t>(i)] - expectedSample(jumpTo + i)) < 0.001f);
}

// Regression test for the "no resampling -> song ends early / wrong pitch
// when a track's native WAV rate differs from the device's operating rate"
// bug: a source authored at 44.1kHz played on a 48kHz device used to report
// (and enforce) a duration shrunk by the 44100/48000 ratio, cutting playback
// off well before the real end of the file.
TEST_CASE("StreamingTrackBuffer resamples a 44.1kHz source to a 48kHz device rate") {
    constexpr double kWavRate = 44100.0;
    constexpr double kDeviceRate = 48000.0;
    const int wavFrames = 44100; // exactly 1 second of source audio
    const std::string path = makeTestArchive(wavFrames, kWavRate);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    StreamingTrackBuffer track;
    REQUIRE(track.open(loader, "Audio/tone.wav", 8192, kDeviceRate, error));
    CHECK(track.sourceSampleRate() == doctest::Approx(kWavRate));

    // totalFrames() must report the DEVICE-domain frame count: 1 real second
    // of audio is 48000 device frames, not the 44100 native frames on disk --
    // this is exactly the number AudioEngine compares the playhead against
    // to decide the song has ended.
    const int64_t expectedDeviceFrames = static_cast<int64_t>(kDeviceRate); // 48000
    CHECK(std::abs(track.totalFrames() - expectedDeviceFrames) <= 1);

    // Drain the whole track through refill()+read() and confirm we actually
    // get ~48000 output frames (not ~44100, which is what the pre-fix code
    // would have produced by treating native frames as device frames).
    std::vector<float> buf(500);
    float* channels[1] = {buf.data()};
    int64_t position = 0;
    int64_t totalRead = 0;
    int guard = 0;
    while (totalRead < expectedDeviceFrames && guard++ < 10000) {
        track.refill();
        const int64_t got = track.read(channels, 500, position);
        for (int64_t i = 0; i < got; ++i) {
            // Loose bound: linear interpolation of a bounded sine can't
            // overshoot the source amplitude by more than a hair.
            CHECK(std::abs(buf[static_cast<size_t>(i)]) <= kAmplitude * 1.05f);
        }
        position += got;
        totalRead += got;
        if (got == 0 && track.isExhausted())
            break;
    }
    CHECK(std::abs(totalRead - expectedDeviceFrames) <= 4); // interpolation/rounding slack
}
