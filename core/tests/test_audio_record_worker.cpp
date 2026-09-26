#include "doctest.h"

#include "audio/AudioRecordWorker.h"
#include "engine/AudioEngineInternal.h"

#include <cmath>
#include <filesystem>
#include <fstream>
#include <vector>

using namespace resostage;

TEST_CASE("parseInputRouting correctly parses hardware input channels") {
    int chL = -1, chR = -1;

    // Default "none" / empty with mono
    audio_engine_detail::parseInputRouting("none", 1, chL, chR);
    CHECK(chL == 0);
    CHECK(chR == -1);

    // Default "none" / empty with stereo
    audio_engine_detail::parseInputRouting("", 2, chL, chR);
    CHECK(chL == 0);
    CHECK(chR == 1);

    // Explicit mono in:1
    audio_engine_detail::parseInputRouting("in:1", 1, chL, chR);
    CHECK(chL == 0);
    CHECK(chR == -1);

    // Explicit mono in:2
    audio_engine_detail::parseInputRouting("in:2", 1, chL, chR);
    CHECK(chL == 1);
    CHECK(chR == -1);

    // Stereo pair in:1+2
    audio_engine_detail::parseInputRouting("in:1+2", 2, chL, chR);
    CHECK(chL == 0);
    CHECK(chR == 1);

    // Stereo pair in:3+4
    audio_engine_detail::parseInputRouting("in:3+4", 2, chL, chR);
    CHECK(chL == 2);
    CHECK(chR == 3);

    // Comma-separated in:1,2
    audio_engine_detail::parseInputRouting("in:1,2", 2, chL, chR);
    CHECK(chL == 0);
    CHECK(chR == 1);
}

TEST_CASE("AudioRecordWorker records 24-bit PCM WAV with correct headers and audio frames") {
    const std::filesystem::path tempDir = std::filesystem::temp_directory_path() / "resostage_test_rec";
    std::error_code ec;
    std::filesystem::remove_all(tempDir, ec);
    std::filesystem::create_directories(tempDir, ec);

    AudioRecordWorker worker;
    CHECK_FALSE(worker.isRecording());

    // Prepare 2 sessions: 1 mono, 1 stereo
    std::vector<TrackAudioRecordSession> sessions;
    {
        TrackAudioRecordSession s1;
        s1.trackId = "audio::track:1";
        s1.filename = "test_track1_mono.wav";
        s1.fullPath = (tempDir / s1.filename).string();
        s1.channels = 1;
        s1.inputChannel0 = 0;
        s1.inputChannel1 = -1;
        sessions.push_back(std::move(s1));

        TrackAudioRecordSession s2;
        s2.trackId = "audio::track:2";
        s2.filename = "test_track2_stereo.wav";
        s2.fullPath = (tempDir / s2.filename).string();
        s2.channels = 2;
        s2.inputChannel0 = 0;
        s2.inputChannel1 = 1;
        sessions.push_back(std::move(s2));
    }

    std::string err;
    const double sr = 48000.0;
    const int64_t startSample = 1000;
    bool ok = worker.prepareRecording(tempDir.string(), sessions, sr, startSample, err);
    CHECK(ok);
    CHECK(err.empty());
    CHECK(worker.isRecording());

    // Generate test input signal (2 input channels)
    const size_t blockSize = 256;
    const size_t numBlocks = 16; // 4096 samples total
    std::vector<float> inputL(blockSize);
    std::vector<float> inputR(blockSize);

    for (size_t b = 0; b < numBlocks; ++b) {
        for (size_t i = 0; i < blockSize; ++i) {
            const double phase = 2.0 * M_PI * 440.0 * static_cast<double>(b * blockSize + i) / sr;
            inputL[i] = static_cast<float>(std::sin(phase) * 0.5);
            inputR[i] = static_cast<float>(std::cos(phase) * 0.25);
        }

        const float* in1[1] = {inputL.data()};
        worker.pushFrames(0, in1, blockSize);

        const float* in2[2] = {inputL.data(), inputR.data()};
        worker.pushFrames(1, in2, blockSize);
    }

    // Give background disk worker a moment to drain the ring buffers
    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    // Stop and finalize
    auto results = worker.stopAndFinalize();
    CHECK_FALSE(worker.isRecording());
    REQUIRE(results.size() == 2);

    CHECK(results[0].trackId == "audio::track:1");
    CHECK(results[0].channels == 1);
    CHECK(results[0].sampleRate == 48000);
    CHECK(results[0].recordedFrames == blockSize * numBlocks);

    CHECK(results[1].trackId == "audio::track:2");
    CHECK(results[1].channels == 2);
    CHECK(results[1].sampleRate == 48000);
    CHECK(results[1].recordedFrames == blockSize * numBlocks);

    // Verify WAV files exist on disk
    for (const auto& res : results) {
        CHECK(std::filesystem::exists(res.fullPath));
        const auto fileSize = std::filesystem::file_size(res.fullPath);
        // Header is 44 bytes, 24-bit PCM = 3 bytes per sample * channels * frames
        const size_t expectedDataBytes = res.recordedFrames * res.channels * 3;
        const size_t expectedTotalSize = 44 + expectedDataBytes;
        CHECK(fileSize == expectedTotalSize);

        // Read and verify RIFF header
        std::ifstream wavFile(res.fullPath, std::ios::binary);
        REQUIRE(wavFile.is_open());
        char header[44];
        wavFile.read(header, 44);
        REQUIRE(wavFile.gcount() == 44);

        // "RIFF"
        CHECK(std::memcmp(header, "RIFF", 4) == 0);
        // "WAVE"
        CHECK(std::memcmp(header + 8, "WAVE", 4) == 0);
        // "fmt "
        CHECK(std::memcmp(header + 12, "fmt ", 4) == 0);
        // AudioFormat == 1 (PCM)
        const uint16_t audioFormat = *reinterpret_cast<const uint16_t*>(header + 20);
        CHECK(audioFormat == 1);
        // NumChannels
        const uint16_t numChannels = *reinterpret_cast<const uint16_t*>(header + 22);
        CHECK(numChannels == res.channels);
        // SampleRate
        const uint32_t sampleRate = *reinterpret_cast<const uint32_t*>(header + 24);
        CHECK(sampleRate == 48000);
        // BitsPerSample == 24
        const uint16_t bitsPerSample = *reinterpret_cast<const uint16_t*>(header + 34);
        CHECK(bitsPerSample == 24);
        // "data"
        CHECK(std::memcmp(header + 36, "data", 4) == 0);
        const uint32_t dataBytes = *reinterpret_cast<const uint32_t*>(header + 40);
        CHECK(dataBytes == expectedDataBytes);
    }

    // Cleanup
    std::filesystem::remove_all(tempDir, ec);
}
