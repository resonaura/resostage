#include "doctest.h"

#include "audio/recording/AudioRecordWorker.h"
#include "engine/AudioEngineInternal.h"
#include "project/ProjectSchema.h"

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

TEST_CASE("AudioRecordWorker handles non-contiguous track indexing via session map") {
    const std::filesystem::path tempDir = std::filesystem::temp_directory_path() / "resostage_test_rec_map";
    std::error_code ec;
    std::filesystem::remove_all(tempDir, ec);
    std::filesystem::create_directories(tempDir, ec);

    AudioRecordWorker worker;

    // Simulate scenario: Track 0 is an Instrument track (no audio session).
    // Track 1 is an Audio track armed for recording -> Session 0.
    std::vector<TrackAudioRecordSession> sessions;
    TrackAudioRecordSession s;
    s.trackId = "audio::track:2";
    s.filename = "test_track2_offset.wav";
    s.fullPath = (tempDir / s.filename).string();
    s.channels = 2;
    s.inputChannel0 = 0;
    s.inputChannel1 = 1;
    sessions.push_back(std::move(s));

    std::string err;
    const double sr = 48000.0;
    bool ok = worker.prepareRecording(tempDir.string(), sessions, sr, 0, err);
    CHECK(ok);

    // Map: track 0 -> -1, track 1 -> 0
    std::array<int, 256> trackToSession;
    trackToSession.fill(-1);
    trackToSession[1] = 0;

    const size_t blockSize = 128;
    std::vector<float> bufL(blockSize, 0.5f);
    std::vector<float> bufR(blockSize, -0.5f);
    const float* ptrs[2] = {bufL.data(), bufR.data()};

    // Track 1 pushes using mapped session index (0)
    int sessIdx = trackToSession[1];
    CHECK(sessIdx == 0);
    worker.pushFrames(static_cast<size_t>(sessIdx), ptrs, blockSize);

    std::this_thread::sleep_for(std::chrono::milliseconds(30));

    auto results = worker.stopAndFinalize();
    REQUIRE(results.size() == 1);
    CHECK(results[0].trackId == "audio::track:2");
    CHECK(results[0].recordedFrames == blockSize);

    std::filesystem::remove_all(tempDir, ec);
}

TEST_CASE("Logic Pro MIDI recording: merge into existing region when within bounds") {
    SongDef song;
    song.id = "song:1";
    song.bpm = 120.0; // 1 beat = 0.5s
    song.endSeconds = 30.0; // 60 beats

    // Existing region on track "inst:1" from beat 0 to 16
    MidiRegion existing;
    existing.id = "reg:existing";
    existing.trackId = "inst:1";
    existing.startBeats = 0.0;
    existing.durationBeats = 16.0;
    MidiNote n1;
    n1.pitch = 60;
    n1.startBeats = 0.0;
    n1.durationBeats = 1.0;
    existing.notes.push_back(n1);
    song.midiRegions.push_back(std::move(existing));

    // Simulate session with recorded notes starting at beat 4 (inside existing region)
    const double recordStartBeats = 4.0;
    const double recordEndBeats = 18.0; // Overhangs past beat 16
    (void)recordEndBeats;

    std::string sessionTrackId = "inst:1";
    std::vector<MidiNote> recordedNotes;
    MidiNote recNote;
    recNote.pitch = 64;
    recNote.startBeats = 4.0;
    recNote.durationBeats = 2.0;
    recordedNotes.push_back(recNote);

    MidiNote recNote2;
    recNote2.pitch = 67;
    recNote2.startBeats = 16.5;
    recNote2.durationBeats = 1.5; // Ends at 18.0
    recordedNotes.push_back(recNote2);

    // Execute merge logic
    MidiRegion* targetRegion = nullptr;
    for (auto& mr : song.midiRegions) {
        if (mr.trackId == sessionTrackId) {
            const double mrEndBeats = mr.startBeats + mr.durationBeats;
            if (recordStartBeats >= (mr.startBeats - 0.25) && recordStartBeats <= (mrEndBeats + 0.25)) {
                targetRegion = &mr;
                break;
            }
        }
    }

    REQUIRE(targetRegion != nullptr);
    CHECK(targetRegion->id == "reg:existing");

    for (const auto& rNote : recordedNotes) {
        MidiNote note = rNote;
        note.startBeats = std::max(0.0, note.startBeats - targetRegion->startBeats);
        if (note.startBeats + note.durationBeats > targetRegion->durationBeats) {
            targetRegion->durationBeats = note.startBeats + note.durationBeats;
        }
        targetRegion->notes.push_back(note);
    }

    // Still only 1 region (merged!), not 2 stacked regions
    CHECK(song.midiRegions.size() == 1);
    CHECK(targetRegion->notes.size() == 3);
    // Duration extended to cover 18.0 beats
    CHECK(targetRegion->durationBeats == doctest::Approx(18.0));
}

TEST_CASE("Logic Pro MIDI recording: creates separate region when outside existing region") {
    SongDef song;
    song.id = "song:1";
    song.bpm = 120.0;

    MidiRegion existing;
    existing.id = "reg:existing";
    existing.trackId = "inst:1";
    existing.startBeats = 0.0;
    existing.durationBeats = 8.0;
    song.midiRegions.push_back(std::move(existing));

    // Record starts at beat 24.0 (well past beat 8.0)
    const double recordStartBeats = 24.0;
    const double recordEndBeats = 32.0;

    std::string sessionTrackId = "inst:1";
    std::vector<MidiNote> recordedNotes;
    MidiNote recNote;
    recNote.pitch = 72;
    recNote.startBeats = 24.0;
    recNote.durationBeats = 2.0;
    recordedNotes.push_back(recNote);

    MidiRegion* targetRegion = nullptr;
    for (auto& mr : song.midiRegions) {
        if (mr.trackId == sessionTrackId) {
            const double mrEndBeats = mr.startBeats + mr.durationBeats;
            if (recordStartBeats >= (mr.startBeats - 0.25) && recordStartBeats <= (mrEndBeats + 0.25)) {
                targetRegion = &mr;
                break;
            }
        }
    }

    // Must NOT merge into existing region
    CHECK(targetRegion == nullptr);

    // Create separate region
    MidiRegion mr;
    mr.id = "reg:new";
    mr.trackId = sessionTrackId;
    mr.startBeats = recordStartBeats;
    mr.durationBeats = recordEndBeats - recordStartBeats;
    for (const auto& rNote : recordedNotes) {
        MidiNote note = rNote;
        note.startBeats = std::max(0.0, note.startBeats - mr.startBeats);
        mr.notes.push_back(note);
    }
    song.midiRegions.push_back(std::move(mr));

    CHECK(song.midiRegions.size() == 2);
    CHECK(song.midiRegions[1].startBeats == doctest::Approx(24.0));
    CHECK(song.midiRegions[1].durationBeats == doctest::Approx(8.0));
    CHECK(song.midiRegions[1].notes[0].startBeats == doctest::Approx(0.0));
}

TEST_CASE("Song auto-extension extends endSeconds to bar boundary when recording exceeds song end") {
    SongDef song;
    song.bpm = 120.0; // 1 beat = 0.5s, 4 beats/bar = 2.0s per bar
    song.timeSignature = {4, 4};
    song.endSeconds = 10.0; // 5 bars

    // Recording ended at 15.3 seconds (7.65 bars)
    const double maxRecEndSec = 15.3;
    const double barSec = 2.0;
    const double candidateEndSec = std::ceil((maxRecEndSec + barSec * 0.5) / barSec) * barSec;

    if (candidateEndSec > song.endSeconds) {
        song.endSeconds = candidateEndSec;
    }

    // 15.3 + 1.0 = 16.3 -> ceil(16.3 / 2.0) * 2.0 = 9 bars * 2.0s = 18.0s
    CHECK(song.endSeconds == 18.0);
    CHECK(song.endSeconds > maxRecEndSec);
}


