#include "doctest.h"

#include "audio/WavMetadata.h"

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

using namespace resostage;

namespace {

void writeU32LE(std::vector<uint8_t>& out, uint32_t v) {
    out.push_back(static_cast<uint8_t>(v & 0xFF));
    out.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
    out.push_back(static_cast<uint8_t>((v >> 16) & 0xFF));
    out.push_back(static_cast<uint8_t>((v >> 24) & 0xFF));
}

void writeChunkId(std::vector<uint8_t>& out, const char* id) {
    out.insert(out.end(), id, id + 4);
}

// Builds a minimal but real RIFF/WAVE file: canonical 'fmt ' + a tiny silent
// 'data' chunk, optionally followed by a 'cue '/'LIST'-'adtl'-'labl' chunk
// pair labeling cue point 1 with `tempoLabel` -- the exact convention
// confirmed against real Logic Pro-exported stems.
std::vector<uint8_t> buildWavWithOptionalTempoLabel(const std::string* tempoLabel) {
    std::vector<uint8_t> fmtChunk;
    writeChunkId(fmtChunk, "fmt ");
    writeU32LE(fmtChunk, 16);
    // audioFormat=1 (PCM), channels=1, sampleRate=48000, byteRate, blockAlign=2, bits=16
    fmtChunk.push_back(1); fmtChunk.push_back(0);
    fmtChunk.push_back(1); fmtChunk.push_back(0);
    writeU32LE(fmtChunk, 48000);
    writeU32LE(fmtChunk, 48000 * 2);
    fmtChunk.push_back(2); fmtChunk.push_back(0);
    fmtChunk.push_back(16); fmtChunk.push_back(0);

    std::vector<uint8_t> dataChunk;
    writeChunkId(dataChunk, "data");
    writeU32LE(dataChunk, 4);
    dataChunk.push_back(0); dataChunk.push_back(0); dataChunk.push_back(0); dataChunk.push_back(0);

    std::vector<uint8_t> metaChunks;
    if (tempoLabel != nullptr) {
        // 'cue ' chunk: dwCuePoints=1, one 24-byte cue point entry.
        std::vector<uint8_t> cueChunk;
        writeChunkId(cueChunk, "cue ");
        writeU32LE(cueChunk, 4 + 24);
        writeU32LE(cueChunk, 1); // count
        writeU32LE(cueChunk, 1); // dwName
        writeU32LE(cueChunk, 0); // dwPosition
        writeChunkId(cueChunk, "data"); // fccChunk
        writeU32LE(cueChunk, 0); // dwChunkStart
        writeU32LE(cueChunk, 0); // dwBlockStart
        writeU32LE(cueChunk, 0); // dwSampleOffset

        // 'LIST'/'adtl'/'labl': 4-byte cue ID + null-terminated text, padded to even.
        std::string text = *tempoLabel;
        text.push_back('\0');
        if (text.size() % 2 != 0)
            text.push_back('\0');

        std::vector<uint8_t> lablChunk;
        writeChunkId(lablChunk, "labl");
        writeU32LE(lablChunk, static_cast<uint32_t>(4 + text.size()));
        writeU32LE(lablChunk, 1); // cue point ID
        lablChunk.insert(lablChunk.end(), text.begin(), text.end());

        std::vector<uint8_t> listChunk;
        writeChunkId(listChunk, "LIST");
        writeU32LE(listChunk, static_cast<uint32_t>(4 + lablChunk.size()));
        writeChunkId(listChunk, "adtl");
        listChunk.insert(listChunk.end(), lablChunk.begin(), lablChunk.end());

        metaChunks.insert(metaChunks.end(), cueChunk.begin(), cueChunk.end());
        metaChunks.insert(metaChunks.end(), listChunk.begin(), listChunk.end());
    }

    const uint32_t riffSize = static_cast<uint32_t>(4 /*WAVE*/ + fmtChunk.size() + dataChunk.size() + metaChunks.size());

    std::vector<uint8_t> out;
    writeChunkId(out, "RIFF");
    writeU32LE(out, riffSize);
    writeChunkId(out, "WAVE");
    out.insert(out.end(), fmtChunk.begin(), fmtChunk.end());
    out.insert(out.end(), dataChunk.begin(), dataChunk.end());
    out.insert(out.end(), metaChunks.begin(), metaChunks.end());
    return out;
}

std::string writeTempFile(const std::vector<uint8_t>& bytes, const char* suffix) {
    const std::string dir = std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp";
    const std::string path = dir + "/resoset_wav_metadata_" + suffix + ".wav";
    std::ofstream f(path, std::ios::binary);
    f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    f.close();
    return path;
}

} // namespace

TEST_CASE("extractTempoFromWavFile finds a cue/LIST/adtl/labl 'Tempo: N' marker") {
    const std::string label = "Tempo: 120.0";
    const auto bytes = buildWavWithOptionalTempoLabel(&label);
    const std::string path = writeTempFile(bytes, "with_tempo");

    double bpm = 0.0;
    REQUIRE(extractTempoFromWavFile(path, bpm));
    CHECK(bpm == doctest::Approx(120.0));

    std::remove(path.c_str());
}

TEST_CASE("extractTempoFromWavFile returns false when no tempo label is present") {
    const auto bytes = buildWavWithOptionalTempoLabel(nullptr);
    const std::string path = writeTempFile(bytes, "no_tempo");

    double bpm = 0.0;
    CHECK_FALSE(extractTempoFromWavFile(path, bpm));

    std::remove(path.c_str());
}

TEST_CASE("extractTempoFromWavFile returns false for a nonexistent file") {
    double bpm = 0.0;
    CHECK_FALSE(extractTempoFromWavFile("/nonexistent/path/does_not_exist.wav", bpm));
}

TEST_CASE("extractTempoFromWavFile handles a label that isn't a tempo marker") {
    const std::string label = "Verse start";
    const auto bytes = buildWavWithOptionalTempoLabel(&label);
    const std::string path = writeTempFile(bytes, "other_label");

    double bpm = 0.0;
    CHECK_FALSE(extractTempoFromWavFile(path, bpm));

    std::remove(path.c_str());
}

TEST_CASE("parseBpmFromName extracts BPM tokens from folder/file names") {
    double bpm = 0.0;
    REQUIRE(parseBpmFromName("NEVERLAND_120BPM", bpm));
    CHECK(bpm == doctest::Approx(120.0));

    REQUIRE(parseBpmFromName("RUN_140BPM", bpm));
    CHECK(bpm == doctest::Approx(140.0));

    REQUIRE(parseBpmFromName("track 128 bpm final", bpm));
    CHECK(bpm == doctest::Approx(128.0));

    CHECK_FALSE(parseBpmFromName("NoTempoHere", bpm));
    CHECK_FALSE(parseBpmFromName("bpmwithoutnumber", bpm));
}
